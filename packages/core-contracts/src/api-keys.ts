/**
 * Org-scoped API key contract — the SINGLE SOURCE OF TRUTH shared by the API
 * (mint + parse + auth), the dashboard (display), and the CLI (precedence).
 *
 * Token format (env-aware):
 *   - production: `sq_<random>`
 *   - non-prod:   `sq_<env>_<random>` (e.g. dev → `sq_dev_<random>`)
 *
 * The env segment is stamped at mint from the API server's own environment, and
 * the API rejects keys whose env ≠ the server env (cross-env guard). `<random>`
 * is ~32 url-safe-base62 bytes. The full token is SHA-256 hashed at rest; the
 * plaintext is shown exactly once on creation.
 *
 * Distinct from the CLI login token `sqcli_` — the auth router matches known
 * prefixes EXACTLY / longest-first, never a naive `startsWith("sq")`.
 */

/** Base literal prefix on every org API key (NOT the CLI login token `sqcli_`). */
export const API_KEY_BASE_PREFIX = "sq_" as const;

/** Display prefix length surfaced in lists (`prefix` column) — never reversible. */
export const API_KEY_DISPLAY_PREFIX_LEN = 12;

/** Random-segment byte count (encoded url-safe-base62 → longer string). */
export const API_KEY_RANDOM_BYTES = 32;

/**
 * Server environment → key env segment. Production has NO segment (`sq_<random>`);
 * every other env gets `sq_<env>_<random>`. Keyed off the API's
 * `SENTRY_ENVIRONMENT` binding (`production` in prod, `development` locally).
 *
 * The map is the only place env→segment lives — API mint/parse, dashboard
 * display, and any future env all read it so the three layers never disagree.
 */
export const KEY_ENV_SEGMENTS: Record<string, string> = {
  production: "", // sq_<random>
  development: "dev", // sq_dev_<random>
};

/** Default `keyEnv` stored when the server env is unknown/unmapped. */
export const DEFAULT_KEY_ENV = "production" as const;

/**
 * Resolve the canonical `keyEnv` value for a raw server-environment string.
 * Anything not explicitly mapped collapses to a sanitized, lowercased label so a
 * new environment still produces a stable, parseable prefix (`sq_<env>_…`).
 *
 * The label is sanitized to `[a-z0-9-]` (underscores → hyphens, other chars
 * dropped) and clamped to 16 chars so it is ALWAYS a single token before the
 * `_<random>` body — this is exactly what `parseKeyEnv` recovers, so mint/parse
 * round-trip even for envs whose raw name contained `_` or was long. Empty after
 * sanitization → development.
 */
export function normalizeServerEnv(serverEnv: string | undefined | null): string {
  const e = (serverEnv ?? "").toLowerCase();
  if (e === "production" || e === "prod") return "production";
  if (e === "" || e === "development" || e === "dev" || e === "local") return "development";
  const sanitized = e
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 16);
  return sanitized || "development";
}

/** The literal token prefix for a given (normalized) keyEnv. */
export function keyPrefixForEnv(keyEnv: string): string {
  const segment = KEY_ENV_SEGMENTS[keyEnv] ?? keyEnv;
  return segment ? `${API_KEY_BASE_PREFIX}${segment}_` : API_KEY_BASE_PREFIX;
}

/**
 * Recover the keyEnv stamped into a token (or env-qualified prefix slug).
 * `sq_<random>` → "production"; `sq_dev_<random>` → "development";
 * `sq_<env>_<random>` → that env. Returns null if the token isn't an API key.
 *
 * Matches the longest known segment first so an env literal that itself starts
 * with another env's name can't be mis-parsed.
 */
export function parseKeyEnv(token: string): string | null {
  if (!token.startsWith(API_KEY_BASE_PREFIX)) return null;
  const rest = token.slice(API_KEY_BASE_PREFIX.length); // after "sq_"

  // Build env→segment candidates (skip production's empty segment), longest first.
  const named = Object.entries(KEY_ENV_SEGMENTS)
    .filter(([, seg]) => seg.length > 0)
    .map(([env, seg]) => ({ env, seg }))
    .sort((a, b) => b.seg.length - a.seg.length);

  for (const { env, seg } of named) {
    if (rest.startsWith(`${seg}_`)) return env;
  }

  // No known env segment matched. Either production (`sq_<random>`) or an
  // unmapped env (`sq_<env>_<random>`). Distinguish by structure: an unmapped
  // env token has a short alpha segment before an underscore; production's
  // random body is a long base62 string with no early underscore.
  //
  // INVARIANT: this relies on the token's random body containing NO `_` — true
  // because the generator's base62 alphabet (0-9a-zA-Z, see lib/api-keys.ts)
  // excludes `_`. If that alphabet ever gains `_`, this heuristic breaks.
  const underscoreIdx = rest.indexOf("_");
  if (underscoreIdx > 0 && underscoreIdx <= 16 && /^[a-z0-9-]+$/.test(rest.slice(0, underscoreIdx))) {
    return rest.slice(0, underscoreIdx);
  }
  return "production";
}

/** True when the bearer is an org API key (`sq_…` / `sq_<env>_…`), not a CLI
 * login token (`sqcli_…`) or session JWT. Derived from parseKeyEnv so the
 * prefix rules stay in one place — auth router + CLI agree on routing. */
export function isApiKey(token: string): boolean {
  return parseKeyEnv(token) !== null;
}

/** Legacy user-scoped CLI login token prefix (PKCE browser flow). Distinct from
 * the org API-key `sq_` family — the auth router matches prefixes exactly /
 * longest-first so `sqcli_` is never caught by the `sq_` branch. */
export const CLI_LOGIN_TOKEN_PREFIX = "sqcli_";

/** All org API-key prefixes, longest-first. ORDER MATTERS: matchers must test
 * longest-first so `sq_dev_` is recognized before the bare `sq_`. Derived from
 * KEY_ENV_SEGMENTS so a new env automatically joins the routing table. */
export const API_KEY_PREFIXES_LONGEST_FIRST: readonly string[] = Object.keys(KEY_ENV_SEGMENTS)
  .map((env) => keyPrefixForEnv(env))
  .sort((a, b) => b.length - a.length);

/** True when the bearer is the legacy user-scoped CLI login token (`sqcli_…`). */
export function isCliLoginToken(token: string): boolean {
  return token.startsWith(CLI_LOGIN_TOKEN_PREFIX);
}

// ── Scopes ─────────────────────────────────────────────────────────

/** Grantable scopes (resource:action) in v1. */
export const API_KEY_SCOPES = [
  "audits:write",
  "audits:read",
  "credits:read",
  "org:read",
  "org:write",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Reserved scopes — accepted by the type system for forward-compat but NOT
 * grantable in v1. Requesting one on key creation is a 400.
 */
export const RESERVED_API_KEY_SCOPES = ["keys:write", "webhooks:write"] as const;
export type ReservedApiKeyScope = (typeof RESERVED_API_KEY_SCOPES)[number];

/** Is this a real, grantable scope? */
export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** Is this a reserved (not-yet-grantable) scope? */
export function isReservedApiKeyScope(value: string): value is ReservedApiKeyScope {
  return (RESERVED_API_KEY_SCOPES as readonly string[]).includes(value);
}

/** UI presets — expanded to concrete scopes on the client; defined here so
 * dashboard + docs share one definition. */
export const API_KEY_SCOPE_PRESETS = {
  /** Everything grantable today. */
  full: [...API_KEY_SCOPES],
  /** All read scopes. */
  "read-only": API_KEY_SCOPES.filter((s) => s.endsWith(":read")),
  /** CI: run/read audits + read credits. */
  ci: ["audits:write", "audits:read", "credits:read"],
} as const satisfies Record<string, ApiKeyScope[]>;

export type ApiKeyScopePreset = keyof typeof API_KEY_SCOPE_PRESETS;

// ── UI display vocabulary ──────────────────────────────────────────
// Shared so the dashboard create-form and the docs render identical
// scope labels + preset copy. Scope sets come from API_KEY_SCOPE_PRESETS
// above (single source of truth) — only display strings live here.

/** Human label for each grantable scope (checkbox copy in the create form). */
export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  "audits:write": "Run audits",
  "audits:read": "Read audits",
  "credits:read": "Read credits",
  "org:read": "Read org",
  "org:write": "Manage org",
};

/** Preset id — alias of {@link ApiKeyScopePreset} for the create-form UI. */
export type ApiKeyPresetId = ApiKeyScopePreset;

/** A one-click preset offered in the create form: scope set + display copy. */
export interface ApiKeyPreset {
  id: ApiKeyPresetId;
  label: string;
  description: string;
  scopes: readonly ApiKeyScope[];
}

/** Create-form presets — scopes derived from API_KEY_SCOPE_PRESETS so they
 * cannot drift from the canonical scope map; this layer only adds copy. */
export const API_KEY_PRESETS: readonly ApiKeyPreset[] = [
  {
    id: "full",
    label: "Full access",
    description: "Every permission. Best for trusted automation.",
    scopes: API_KEY_SCOPE_PRESETS.full,
  },
  {
    id: "read-only",
    label: "Read-only",
    description: "Read audits, credits, and org details — no writes.",
    scopes: API_KEY_SCOPE_PRESETS["read-only"],
  },
  {
    id: "ci",
    label: "CI",
    description: "Run audits and read results — ideal for pipelines.",
    scopes: API_KEY_SCOPE_PRESETS.ci,
  },
];
