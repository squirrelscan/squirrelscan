import { TELEMETRY_TIMEOUT_MS } from "@/constants";
import { cliApi } from "@/lib/api-client";

import type { UserSettings } from "./types";

import { version } from "../../package.json";
import { getOrCreateInstallId } from "./install-id";
import { updateSettings } from "./settings";

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
  | "update_prompt_declined";

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

export function showTelemetryNotice(settings: UserSettings): void {
  if (isTelemetryDisabled(settings) || settings.telemetry_notice_shown) return;

  const updated = updateSettings({ telemetry_notice_shown: true });
  if (!updated.ok) return;

  console.error(
    [
      "SquirrelScan collects minimal pseudonymous telemetry: event name, CLI version,",
      "a random install ID, and bounded error categories. It never sends URLs,",
      "credentials, report contents, or raw error messages.",
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

  const installId = getOrCreateInstallId();
  if (installId) payload.install_id = installId;

  // Telemetry is deliberately never associated with an API credential.
  await cliApi.send("/v1/traces", {
    method: "POST",
    auth: "none",
    timeoutMs: TELEMETRY_TIMEOUT_MS,
    body: payload,
  });
}
