// Credential resolution — the single chokepoint for "which bearer token does
// the CLI send for cloud calls, and where did it come from?". Implements the
// locked precedence (issue #159/epic #154, SQUIRRELSCAN_API_KEY rename #670):
//
//   1. SQUIRRELSCAN_API_KEY env var (or its back-compat alias
//      SQUIRREL_API_TOKEN, checked when the preferred var is unset — no
//      deprecation warning, it just works) — authoritative / fail-closed. When
//      set it OVERRIDES a logged-in session. If it's present but invalid
//      (revoked / expired / wrong-env → API 401) the CLI ERRORS; it does NOT
//      silently fall back to the local login. Matches gh / Stripe / AWS —
//      predictable CI.
//   2. settings.json auth.token — the `squirrel auth login` session.
//   3. unauthenticated — local / deterministic-only.
//
// The env token is NEVER persisted to settings.json (callers read it here, they
// never write it). It may be a `sq_…` org API key or the legacy `sqcli_…` login
// token — it's just a bearer string on the wire; the API differentiates.

import { isApiKey, parseKeyEnv } from "@squirrelscan/core-contracts/api-keys";

import type { Result } from "@/controllers/types";

import type { UserSettings } from "./types";

import { getApiUrl } from "./api";
import { formatSessionLoadWarning, loadUserSettings } from "./settings";

/** Preferred env var that supplies a bearer token for headless / CI auth. */
export const API_TOKEN_ENV_VAR = "SQUIRRELSCAN_API_KEY";

/** Back-compat alias (the pre-rename name) — still read silently, checked
 * only when the preferred var above is unset/empty. No deprecation warning. */
export const LEGACY_API_TOKEN_ENV_VAR = "SQUIRREL_API_TOKEN";

/** Where the active credential came from. */
export type CredentialSource = "env" | "login";

export interface ResolvedCredential {
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Provenance — drives whoami display + fail-closed behavior. */
  source: CredentialSource;
  /**
   * Login-token expiry (ISO). Only known for `login` source — env tokens are
   * opaque, their validity is decided server-side (fail-closed on 401).
   */
  expiresAt?: string;
}

function readEnvVar(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read SQUIRRELSCAN_API_KEY, falling back to the SQUIRREL_API_TOKEN alias,
 * trimmed. Returns null when both are unset OR empty/whitespace (an empty
 * export must behave exactly like "no env token" — fall through to the login
 * session — not like an invalid credential).
 */
export function getEnvApiToken(): string | null {
  return readEnvVar(API_TOKEN_ENV_VAR) ?? readEnvVar(LEGACY_API_TOKEN_ENV_VAR);
}

/**
 * Name of whichever env var actually supplied the active token — the
 * preferred var or the legacy alias — or null when neither is set. Lets
 * display copy name the var the user actually exported instead of always
 * assuming the preferred one.
 */
export function activeEnvTokenVar(): string | null {
  if (readEnvVar(API_TOKEN_ENV_VAR)) return API_TOKEN_ENV_VAR;
  if (readEnvVar(LEGACY_API_TOKEN_ENV_VAR)) return LEGACY_API_TOKEN_ENV_VAR;
  return null;
}

/** True when a non-empty SQUIRRELSCAN_API_KEY (or the legacy alias) is set
 * (shadows any login session). */
export function isEnvTokenSet(): boolean {
  return getEnvApiToken() !== null;
}

/**
 * Resolve the active credential per the precedence above. Does NOT validate the
 * token against the server — validity (and fail-closed erroring) is enforced at
 * the call site, since only a live request can tell a revoked key from a good
 * one. Returns null only for the unauthenticated case.
 *
 * Login-token expiry IS checked locally (it's a self-describing JWT-style token
 * with a known expiry) so an obviously-expired session reads as logged-out
 * rather than firing a doomed request — but ONLY when the env var is unset. When
 * the env var is set we never consult the login token at all.
 */
export function resolveCredential(): ResolvedCredential | null {
  const envToken = getEnvApiToken();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const settings = loadUserSettings();
  if (!settings.ok) return null;

  const auth = settings.data.auth;
  if (!auth?.token) return null;

  // expiresAt is an ISO date written by the API at login — toISOString
  // comparison is safe here (unlike DB-side Postgres-format timestamps).
  if (auth.expiresAt && new Date(auth.expiresAt).getTime() < Date.now()) {
    return null;
  }

  return { token: auth.token, source: "login", expiresAt: auth.expiresAt };
}

/**
 * Human label for an env credential's kind, for whoami/status display. The env
 * token may be an org API key (`sq_…` / `sq_dev_…`) or a login token (`sqcli_…`).
 * For dev-env keys we surface the env so a "why is prod rejecting my key?"
 * cross-env mistake is visible without leaking the secret.
 */
export function describeEnvToken(token: string): string {
  if (isApiKey(token)) {
    const env = parseKeyEnv(token);
    return env === "production" ? "API key" : `API key (${env})`;
  }
  return "login token";
}

/**
 * Dashboard page for managing org API keys. Hardcoded on purpose — the dashboard
 * is a fixed production property; it does NOT vary with SQUIRREL_API_SERVER (that
 * override targets the API origin, not the human-facing dashboard).
 */
export const API_KEYS_DASHBOARD_URL =
  "https://app.squirrelscan.com/settings/api-keys";

/**
 * Actionable fail-closed message when the env token (SQUIRRELSCAN_API_KEY or
 * the SQUIRREL_API_TOKEN alias) is set but the server rejects it (401: revoked
 * / expired / wrong-env / malformed). Names the env var that was ACTUALLY set,
 * the API it was checked against, and the dashboard to manage keys. NEVER
 * echoes the token value. Used by commands that hard-error rather than degrade.
 */
export function envTokenRejectedMessage(): string {
  const token = getEnvApiToken();
  const envVar = activeEnvTokenVar() ?? API_TOKEN_ENV_VAR;
  const kind = token ? describeEnvToken(token) : "token";
  const env = token ? parseKeyEnv(token) : null;
  const crossEnvHint =
    env && env !== "production"
      ? `\n  This is a ${env} key — it is rejected by a production server (and vice-versa).`
      : "";
  return (
    `Error: ${envVar} was rejected by ${getApiUrl()} (invalid, revoked, expired, or wrong environment).\n` +
    `  The ${kind} from ${envVar} is authoritative — the CLI will not fall back to a logged-in session.${crossEnvHint}\n` +
    `  Manage keys: ${API_KEYS_DASHBOARD_URL}\n` +
    `  To use a logged-in session instead, unset ${envVar}.`
  );
}

/**
 * Loud warning for a USER session file that exists but couldn't be loaded
 * (EACCES, corrupt JSON, fails schema, ...) — as opposed to genuinely logged
 * out (no file), which stays silent. This is the single implementation of
 * the #805 check: originally wired into `squirrel audit` only, every command
 * entry whose behavior can silently degrade to "anonymous" when the session
 * is unreadable must call this (#1062) instead of re-doing the
 * loadUserSettings()+formatSessionLoadWarning() dance per command.
 *
 * Takes an already-loaded Result so callers that need the settings for other
 * purposes too (audit.ts) don't pay for a second read; omit the argument to
 * have it load fresh (report/config/self/mcp entry, which don't otherwise
 * need settings up front).
 *
 * Skipped when an env token is set: resolveCredential() checks
 * SQUIRRELSCAN_API_KEY/the legacy alias FIRST and never touches
 * settings.json in that case (see its precedence doc above), so a broken
 * session file is irrelevant to auth — warning anyway produced a
 * contradictory "running anonymous" message right next to "Authenticated as
 * ... (env)" in `auth status`/`whoami` (#1062 review).
 */
export function warnIfSessionUnreadable(
  settings: Result<UserSettings> = loadUserSettings()
): void {
  if (!settings.ok && !isEnvTokenSet()) {
    console.error(formatSessionLoadWarning(settings.error));
    console.error("");
  }
}
