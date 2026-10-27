import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts/failure-reason";

import { TELEMETRY_TIMEOUT_MS } from "@/constants";
import { cliApi } from "@/lib/api-client";
import { DEFAULT_API_URL, getApiUrl } from "@/self/api";

import type { UserSettings } from "./types";

import { version } from "../../package.json";
import { getOrCreateInstallId } from "./install-id";
import { loadUserSettings, updateSettings } from "./settings";

export type TelemetryEvent =
  | "audit"
  | "error"
  | "update"
  | "update_auto"
  | "update_auto_started"
  | "update_auto_skipped"
  | "update_auto_error"
  | "update_check"
  | "update_available"
  | "update_check_error"
  | "update_notified"
  | "update_prompt_accepted"
  | "update_prompt_declined"
  // First-run funnel: which step ran, whether login and the first audit worked.
  | "setup_started"
  | "setup_step"
  | "setup_completed"
  | "setup_audit_accepted"
  | "setup_audit_declined"
  | "login_completed"
  | "first_audit_ok"
  | "first_audit_failed";

interface TelemetryPayload {
  event: TelemetryEvent;
  install_id?: string;
  version: string;
  error_type?: string;
}

export function isTelemetryDisabled(settings?: UserSettings): boolean {
  return (
    typeof process.env.NO_TELEMETRY !== "undefined" ||
    settings?.telemetry === false
  );
}

// v2: telemetry carries the user ID once signed in.
const TELEMETRY_NOTICE_VERSION = 2;

export function showTelemetryNotice(settings: UserSettings): void {
  if (isTelemetryDisabled(settings)) return;
  if (
    settings.telemetry_notice_shown &&
    (settings.telemetry_notice_version ?? 1) >= TELEMETRY_NOTICE_VERSION
  )
    return;

  const updated = updateSettings({
    telemetry_notice_shown: true,
    telemetry_notice_version: TELEMETRY_NOTICE_VERSION,
  });
  if (!updated.ok) return;

  console.error(
    [
      "squirrelscan collects minimal telemetry: event name, CLI version, a random",
      "install ID, your user ID once you sign in, and bounded error categories.",
      "It never sends URLs, credentials, report contents, or raw error messages.",
      "Disable it with `squirrel self settings set telemetry false` or `NO_TELEMETRY=1`.",
      "",
    ].join("\n")
  );
}

export function trackTelemetryEvent(
  event: TelemetryEvent,
  settings?: UserSettings,
  detail?: { error_type?: string }
): void {
  if (isTelemetryDisabled(settings)) return;

  void sendTelemetryEvent({
    event,
    version,
    ...(detail?.error_type && { error_type: detail.error_type.slice(0, 128) }),
  });
}

// Bounded detail for first-run events: a lowercase slug, never free text, so a
// URL, host, path or email cannot ride along even by mistake.
const DETAIL_PATTERN = /^[a-z0-9_:-]{1,64}$/;

/**
 * Track a first-run funnel event. `detail` is a fixed slug (step:outcome or a
 * failure class); anything that is not one is dropped, not truncated.
 */
export function trackFirstRunEvent(
  event: TelemetryEvent,
  settings?: UserSettings,
  detail?: string
): void {
  trackTelemetryEvent(
    event,
    settings,
    detail && DETAIL_PATTERN.test(detail) ? { error_type: detail } : undefined
  );
}

/**
 * Report the outcome of the install's first audit, once. The marker is written
 * whether or not telemetry is on, so turning it on later never mislabels a
 * later audit as the first. Offline runs are not first audits (they send no
 * telemetry at all), so callers skip them.
 */
let firstAuditReported = false;

export function trackFirstAudit(
  outcome:
    | { ok: true }
    | { ok: false; failureClass: AuditFailureReasonCode | "exception" },
  settings?: UserSettings
): void {
  // The settings snapshot can predate this run's own report, so a process
  // guard keeps a late throw after a reported result from sending twice.
  if (firstAuditReported || settings?.first_audit_reported_at) return;
  // The snapshot can be missing or stale (another process may have reported):
  // the marker on disk decides.
  const onDisk = loadUserSettings();
  if (onDisk.ok && onDisk.data.first_audit_reported_at) return;
  firstAuditReported = true;
  // The marker means "first audit seen", not "first audit sent": it is set even
  // with telemetry off. Marker first, send second: "once" beats "at least once". A send that
  // fails (offline, process exit) loses this event rather than repeating it.
  const updated = updateSettings({
    first_audit_reported_at: new Date().toISOString(),
  });
  if (!updated.ok) return;
  if (outcome.ok) trackFirstRunEvent("first_audit_ok", settings);
  else trackFirstRunEvent("first_audit_failed", settings, outcome.failureClass);
}

/** Test hook: forget that this process already reported a first audit. */
export function resetFirstAuditReportedForTests(): void {
  firstAuditReported = false;
}

/**
 * The login session's token (`sqcli_...`), when signed in and unexpired. The
 * API turns it into a user ID server-side. An org API key (env or otherwise)
 * is never sent to telemetry.
 */
function loginSessionToken(): string | null {
  // Only the production API ever receives the session on this always-on path:
  // a SQUIRREL_API_SERVER override (dev, a stray env var) gets anonymous events.
  if (getApiUrl() !== DEFAULT_API_URL) return null;
  const loaded = loadUserSettings();
  if (!loaded.ok || loaded.data.telemetry === false) return null;
  const auth = loaded.data.auth;
  if (!auth?.token || !auth.token.startsWith("sqcli_")) return null;
  // Fail closed: an unparseable expiry reads as expired.
  if (auth.expiresAt) {
    const expires = Date.parse(auth.expiresAt);
    if (Number.isNaN(expires) || expires <= Date.now()) return null;
  }
  return auth.token;
}

export function trackError(
  error: Error | string,
  context?: string,
  settings?: UserSettings
): void {
  if (isTelemetryDisabled(settings)) return;

  const errorType =
    context ??
    (error instanceof Error ? error.name || error.constructor.name : "Error");

  void sendTelemetryEvent({
    event: "error",
    version,
    error_type: errorType.slice(0, 128),
  });
}

async function sendTelemetryEvent(payload: TelemetryPayload): Promise<void> {
  // Re-check immediately before touching settings so a late-set kill switch
  // still prevents install-ID reads or creation.
  if (isTelemetryDisabled()) return;

  // The caller may not have had settings (unreadable at start): honour the
  // opt-out from disk too before touching anything.
  const loaded = loadUserSettings();
  if (loaded.ok && loaded.data.telemetry === false) return;

  const installId = getOrCreateInstallId();
  if (installId) payload.install_id = installId;

  // Signed in, the login session token attributes the event to the user (the
  // API resolves it to a user ID). Org API keys are never sent here.
  await cliApi.send("/v1/traces", {
    method: "POST",
    token: loginSessionToken(),
    timeoutMs: TELEMETRY_TIMEOUT_MS,
    body: payload,
  });
}
