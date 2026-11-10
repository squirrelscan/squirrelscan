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

import type { AuthState, UserSettings } from "./types";

import { DEFAULT_API_URL, getApiUrl } from "./api";
import {
  formatSessionLoadWarning,
  loadUserSettings,
  updateSettings,
} from "./settings";

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
 * What the CLI knows about the credential it would send (#1666):
 * - `env`: SQUIRRELSCAN_API_KEY (or its alias) is set. Its validity is the server's call.
 * - `login`: a stored login session that has not expired and was not rejected.
 * - `expired`: a stored login whose expiry has passed. Read as signed out.
 * - `rejected`: a stored login the server answered 401 to. Read as signed out, and not retried.
 * - `none`: nothing.
 */
export type CredentialState = "env" | "login" | "expired" | "rejected" | "none";

/** How long a rejection is remembered before the login is tried once more: a revoked token stays dead, a gateway glitch does not. */
export const REJECTED_LOGIN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The state, from what is stored and the clock. Pure, so every edge is a table row. An unparseable
 * date fails closed, as `telemetry.ts` does for the same expiry: a stamp or an expiry the CLI cannot
 * read is not evidence the login works.
 */
export function deriveCredentialState(input: {
  envToken: boolean;
  auth: AuthState | undefined;
  now: number;
}): CredentialState {
  if (input.envToken) return "env";
  const auth = input.auth;
  if (!auth?.token) return "none";
  if (auth.rejectedAt) {
    const rejected = Date.parse(auth.rejectedAt);
    if (Number.isNaN(rejected) || input.now - rejected < REJECTED_LOGIN_TTL_MS)
      return "rejected";
  }
  if (auth.expiresAt) {
    const expires = Date.parse(auth.expiresAt);
    if (Number.isNaN(expires) || expires <= input.now) return "expired";
  }
  return "login";
}

/** {@link deriveCredentialState} over the real environment and settings file. */
export function credentialState(): CredentialState {
  const settings = loadUserSettings();
  return deriveCredentialState({
    envToken: isEnvTokenSet(),
    auth: settings.ok ? (settings.data.auth ?? undefined) : undefined,
    now: Date.now(),
  });
}

/**
 * Record that the PRODUCTION server answered 401 to this LOGIN token on an account route, so the next
 * command reads it as rejected without another request (#1666). Callers pass only token-death routes
 * (`/v1/auth/*`): a 401 from any other route may be a gateway glitch and must not disable a working login.
 *
 * Nothing is written when the API is overridden (`SQUIRREL_API_SERVER`): a local or dev server's 401 says
 * nothing about the production login. A token that is not the stored one (an env token, or a login
 * replaced since) is left alone: the env token is never written to settings.
 */
export function markLoginRejected(token: string): void {
  if (getApiUrl() !== DEFAULT_API_URL) return;
  const settings = loadUserSettings();
  if (!settings.ok) return;
  const auth = settings.data.auth;
  if (!auth || auth.token !== token) return;
  // Already remembered and still within the window: nothing to refresh.
  if (
    auth.rejectedAt &&
    Date.now() - Date.parse(auth.rejectedAt) < REJECTED_LOGIN_TTL_MS
  )
    return;
  updateSettings({ auth: { ...auth, rejectedAt: new Date().toISOString() } });
}

/** The one line a command prints to stderr when the stored login cannot be used. Null for any other state. */
export function staleLoginNote(state: CredentialState): string | null {
  if (state === "expired") {
    return "Your squirrelscan login has expired, so this run is signed out (local checks only). Run `squirrel auth login` to sign in again.";
  }
  if (state === "rejected") {
    return "The server rejected your squirrelscan login (revoked or expired), so this run is signed out (local checks only). Run `squirrel auth login` to sign in again.";
  }
  return null;
}

let staleLoginNoted = false;

/** Print {@link staleLoginNote} to stderr, once per process. */
export function noteStaleLogin(
  state: CredentialState = credentialState()
): void {
  const note = staleLoginNote(state);
  if (note === null || staleLoginNoted) return;
  staleLoginNoted = true;
  console.error(note);
  console.error("");
}

/** For a command that reports the credential state itself (`auth status`): no second line on stderr. Tests also reset with `false`. */
export function setStaleLoginNoted(noted: boolean): void {
  staleLoginNoted = noted;
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

  // An expired or rejected login reads as signed out (#1666): no doomed request, and a rejected
  // token is never retried. `warnIfSessionUnreadable` says so once per command.
  const state = deriveCredentialState({
    envToken: false,
    auth,
    now: Date.now(),
  });
  if (state !== "login") return null;

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
 * Why `squirrel auth status` / `squirrel auth whoami` cannot report an identity
 * for an org API key.
 *
 * The identity endpoint the command calls (`/v1/auth/whoami`) is the CLI-session
 * endpoint: it accepts only the `sqcli_…` token that `squirrel auth login`
 * issues, and refuses an `sq_…` org key at the prefix. So a key that works
 * everywhere else — audits, publishing, credits, MCP — still 401s HERE, and the
 * generic rejected-token wording blamed the user's key for being revoked,
 * expired or from the wrong environment when usually none of that is true.
 *
 * We cannot tell that case apart from a genuinely dead key (both are a bare
 * 401), so this leads with the structural reason, which is the one a user has no
 * way to guess, and still points at the dashboard for the other one.
 *
 * `envVarName` names the env var that supplied the key, when one did; omit it
 * for a key that came from the session file. It changes the ADVICE, not just the
 * wording: an env token is authoritative and keeps shadowing the session (see
 * the precedence doc at the top of this file), so telling an env-key user to
 * just log in would hand them the identical error again afterwards — they have
 * to unset the variable for the session to be consulted at all.
 */
export function apiKeyNotVerifiableMessage(envVarName?: string | null): string {
  const source = envVarName
    ? `the org API key in ${envVarName}`
    : "an org API key";
  const howToSeeAccount = envVarName
    ? `  To see your account, run "squirrel auth login", then unset ${envVarName} —\n` +
      `  while it is set it takes precedence over the session for every cloud call.\n`
    : `  To see your account, run: squirrel auth login\n`;
  return (
    `This command cannot verify ${source}.\n` +
    `  ${getApiUrl()} answers identity lookups only for the login token that\n` +
    `  "squirrel auth login" issues, so it refuses an org API key (sq_…) here even\n` +
    `  when that same key works for audits, publishing and credits.\n` +
    howToSeeAccount +
    `  If cloud calls are failing too, the key may be revoked, expired, or from\n` +
    `  another environment: ${API_KEYS_DASHBOARD_URL}`
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
    return;
  }
  // #1666: a login that expired or was rejected is signed out with no other word, so say so,
  // once per command. The entry point every command already calls is the one place for it.
  if (settings.ok) {
    noteStaleLogin(
      deriveCredentialState({
        envToken: isEnvTokenSet(),
        auth: settings.data.auth ?? undefined,
        now: Date.now(),
      })
    );
  }
}
