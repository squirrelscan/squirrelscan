// security/auth-endpoint-disclosure - auth and session endpoints that return a
// password, a password hash, a credential secret or the internal user record
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows it (`ctx.probe`, see probe-budget.ts) and sends
// nothing on a passive run. Cloud audits of an unverified website and runs with
// discovery probes turned off resolve to passive before the rule runs, so the
// activation policy (repo#1931) reaches it through `ctx.probe` alone.
//
// What may be probed, all enforced by `selectAuthCandidates`:
//
//  - Same origin as the audited base URL (scheme, host and port), checked here
//    again rather than trusting `probeEligible`.
//  - A path whose last segment names the current user or session (`me`,
//    `session`, `user`, `whoami`, `userinfo`, ...), under an API or auth
//    segment unless a call site (fetch, axios, XHR, $.ajax) named it.
//  - Never a path that names a state-changing action (graphql-probe's list:
//    logout, delete, update, reset, ...) or a credential flow (login, signup,
//    register, password, callback, authorize, ...).
//  - Never a call site that declares a method other than GET or HEAD: a POST
//    to /api/session is how a login is submitted, so it is left alone.
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_AUTH_ENDPOINTS endpoints, one GET each.
//
// What is sent: one GET per endpoint, with no query string, no body, no
// cookies (`credentials: "omit"`), no Authorization header and no redirect
// following. Credentials are never submitted. At most AUTH_RESPONSE_CAP decoded
// bytes of the answer are read (#722: the body is decoded only that far).
//
// What is flagged: a 2xx JSON answer that contains a password or password hash
// (by key or by hash format), a credential secret (reset, confirmation or
// remember tokens, OTP and MFA secrets, recovery codes, signing keys), or an
// object with several internal user-table columns (sign-in counters and IPs,
// lockout state, salts). Findings name the JSON path of each field, never its
// value.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { EndpointCandidate } from "../endpoint-surface";
import type { ProbeBudget } from "../probe-budget";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { isStateChangingPath } from "./graphql-probe";
import {
  ANONYMOUS_GET_CAP,
  ANONYMOUS_GET_TIMEOUT_MS,
  buildAnonymousGet,
  isThrottledOrChallenged,
  isUnverifiedReply,
  peekAnonymousGet,
  sendAnonymousGet,
} from "./probe-http";

export const AUTH_ENDPOINT_DISCLOSURE_RULE_ID = "security/auth-endpoint-disclosure";

// Endpoints this rule had to leave unread in an audit (throttled, challenged or
// out of budget, and no other rule had fetched them yet), keyed on the audit's
// probe budget. security/unauthenticated-api defers a leaking endpoint to this
// rule only when it is NOT in here, so whichever rule runs first, the endpoint
// is reported exactly once (squirrelscan#1886).
const unreadByAuth = new WeakMap<ProbeBudget, Set<string>>();

function markUnread(probe: ProbeBudget | undefined, url: string): void {
  if (!probe) return;
  let set = unreadByAuth.get(probe);
  if (!set) {
    set = new Set();
    unreadByAuth.set(probe, set);
  }
  set.add(url);
}

/** True when this rule left `url` unread in the audit that owns `probe`, so it will not report it. */
export function authRuleLeftUnread(probe: ProbeBudget | undefined, url: string): boolean {
  return probe ? (unreadByAuth.get(probe)?.has(url) ?? false) : false;
}

const CHECK_PROBLEM = "auth-endpoint-disclosure";
const CHECK_CLEAN = "auth-endpoint-clean";
const CHECK_SKIPPED = "auth-endpoint-not-checked";

/** Paths probed on every site, besides the ones the discovery pass found. */
export const AUTH_CONVENTION_PATHS: readonly string[] = [
  "/api/me",
  "/api/session",
  "/api/auth/session",
  "/api/user",
];

/** Endpoints probed per run. */
export const MAX_AUTH_ENDPOINTS = 6;

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const AUTH_PROBE_TIMEOUT_MS = ANONYMOUS_GET_TIMEOUT_MS;

/** Decoded response bytes read per endpoint. A longer answer is not parsed. */
export const AUTH_RESPONSE_CAP = ANONYMOUS_GET_CAP;

/** Field paths listed per endpoint. */
const MAX_FIELDS_PER_ENDPOINT = 20;
/** JSON nesting walked, and nodes visited, per answer. */
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;
/** Longest string tested against the hash formats. */
const MAX_HASH_CHARS = 512;

// Last path segments that name the current user or session.
const AUTH_LEAVES = new Set([
  "me",
  "session",
  "whoami",
  "userinfo",
  "user",
  "currentuser",
  "self",
  "profile",
  "account",
]);

// A segment that marks the path as an API or auth route, for candidates that
// are not call sites (string literals, conventions).
const API_SEGMENTS = new Set(["api", "auth", "rest", "identity", "users", "accounts", "v1", "v2", "v3"]);

// Words that mark a credential flow. Such a path is never probed, even by GET:
// a GET to an OAuth callback or a magic-link verifier can complete a sign-in.
const CREDENTIAL_WORDS = new Set([
  "login",
  "logon",
  "signin",
  "signup",
  "register",
  "registration",
  "password",
  "passwd",
  "otp",
  "verify",
  "verification",
  "confirm",
  "callback",
  "authorize",
  "magic",
  "impersonate",
  "sso",
  "saml",
  "token",
  "tokens",
]);
const CREDENTIAL_PAIRS = new Set(["log in", "sign in", "sign up"]);

/** True for a discovery-pass call site (fetch, axios, XHR, jQuery), not a literal or a convention. */
function isCallSite(discoveredVia: string): boolean {
  return (
    discoveredVia === "fetch" ||
    discoveredVia === "xhr.open" ||
    discoveredVia.startsWith("axios.") ||
    discoveredVia.startsWith("$.")
  );
}

function pathWords(pathname: string): string[] {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  return decoded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** True when the path names a sign-in, sign-up, password or token flow. */
export function isCredentialPath(pathname: string): boolean {
  const words = pathWords(pathname);
  for (let i = 0; i < words.length; i++) {
    if (CREDENTIAL_WORDS.has(words[i]!)) return true;
    if (i + 1 < words.length && CREDENTIAL_PAIRS.has(`${words[i]} ${words[i + 1]}`)) return true;
  }
  return false;
}

function segments(pathname: string): string[] {
  return pathname
    .toLowerCase()
    .split("/")
    .filter((s) => s.length > 0);
}

/**
 * True when the path looks like a current-user or session endpoint: its last
 * segment (separators dropped, so `current-user` and `current_user` match)
 * names one, and it sits under an API or auth segment unless a call site named
 * it.
 */
export function isAuthEndpointPath(pathname: string, callSite: boolean): boolean {
  const segs = segments(pathname);
  if (segs.length === 0) return false;
  const leaf = segs[segs.length - 1]!.replace(/[^a-z0-9]/g, "");
  if (!AUTH_LEAVES.has(leaf)) return false;
  return callSite || segs.slice(0, -1).some((s) => API_SEGMENTS.has(s));
}

export interface AuthCandidate {
  /** Origin plus path: the query string and fragment are dropped. */
  url: string;
  source: "discovered" | "convention";
  /** The discovery pass's `discoveredVia`, or `convention`. */
  discoveredVia: string;
}

export interface AuthCandidateSelection {
  candidates: AuthCandidate[];
  /** Auth-looking candidates left out: state-changing or credential path, or a non-GET call site. */
  skippedUnsafe: number;
  /** Candidates left out because robots.txt disallows them (below aggressive). */
  skippedRobots: number;
  /** Candidates past MAX_AUTH_ENDPOINTS. */
  skippedCap: number;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The auth endpoints this rule may probe, in a stable order: discovered
 * endpoints first, then the conventional paths. Deduped on origin plus path.
 * Pure: sends nothing.
 */
export function selectAuthCandidates(
  ctx: Pick<RuleContext, "site" | "endpointSurface" | "probe">
): AuthCandidateSelection {
  const out: AuthCandidate[] = [];
  const selection: AuthCandidateSelection = {
    candidates: out,
    skippedUnsafe: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  if (!baseUrl) return selection;
  const siteOrigin = originOf(baseUrl);
  if (!siteOrigin) return selection;

  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const seen = new Set<string>();

  const consider = (
    rawUrl: string,
    source: AuthCandidate["source"],
    discoveredVia: string,
    method: string | undefined
  ): void => {
    let u: URL;
    try {
      u = new URL(rawUrl, baseUrl);
    } catch {
      return;
    }
    // Strict same origin, whatever the candidate says about itself.
    if (originOf(u.href) !== siteOrigin) return;
    if (u.username || u.password) return;
    const callSite = isCallSite(discoveredVia);
    if (!isAuthEndpointPath(u.pathname, callSite)) return;
    const url = `${u.origin}${u.pathname}`;
    if (seen.has(url)) return;
    seen.add(url);
    const m = method?.toUpperCase();
    if (
      isStateChangingPath(u.pathname) ||
      isCredentialPath(u.pathname) ||
      (m !== undefined && m !== "GET" && m !== "HEAD")
    ) {
      selection.skippedUnsafe++;
      return;
    }
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
      selection.skippedRobots++;
      return;
    }
    if (out.length >= MAX_AUTH_ENDPOINTS) {
      selection.skippedCap++;
      return;
    }
    out.push({ url, source, discoveredVia });
  };

  for (const c of ctx.endpointSurface?.candidates ?? []) {
    if (!c.probeEligible || !c.sameOrigin) continue;
    consider(c.url, candidateSource(c), c.discoveredVia, c.method);
  }
  for (const path of AUTH_CONVENTION_PATHS) consider(path, "convention", "convention", "GET");
  return selection;
}

function candidateSource(c: EndpointCandidate): AuthCandidate["source"] {
  return c.source === "convention" ? "convention" : "discovered";
}

// ── sending ─────────────────────────────────────────────────────────

export interface AuthProbeResponse {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  /** Response headers, read for a rate limit or bot challenge (`cf-mitigated`). */
  headers?: Headers;
}

export type AuthProbeOutcome =
  | { sent: false }
  | { sent: true; response: AuthProbeResponse }
  | { sent: true; error: string };

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildAuthProbe(endpointUrl: string): { url: string; init: RequestInit } {
  // The same anonymous GET security/unauthenticated-api sends: one answer per
  // endpoint per audit serves both rules (squirrelscan#1886).
  return buildAnonymousGet(endpointUrl);
}

/**
 * Send one GET, if the shared budget allows a quiet probe. An endpoint another
 * rule already probed in this audit is answered from that probe and costs
 * nothing (sendAnonymousGet).
 */
export function sendAuthProbe(
  probe: ProbeBudget | undefined,
  endpointUrl: string
): Promise<AuthProbeOutcome> {
  return sendAnonymousGet(probe, endpointUrl);
}

// ── reading ─────────────────────────────────────────────────────────

export type DisclosureKind = "password" | "password-hash" | "secret" | "internal-record";

export interface DisclosedField {
  /** JSON path of the field, such as `user.encrypted_password` or `users[0].password`. */
  path: string;
  kind: DisclosureKind;
}

/** Keys (lower case, separators dropped) that hold a password or its hash. */
const PASSWORD_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "userpassword",
  "passwordhash",
  "hashedpassword",
  "encryptedpassword",
  "cryptedpassword",
  "passworddigest",
  "passhash",
  "pwdhash",
  "passwordsalt",
]);

/** Keys that hold a credential secret: whoever reads one can sign in, reset or forge. */
const SECRET_KEYS = new Set([
  "resetpasswordtoken",
  "passwordresettoken",
  "resettoken",
  "recoverytoken",
  "confirmationtoken",
  "emailverificationtoken",
  "verificationtoken",
  "emailchangetoken",
  "emailchangetokennew",
  "emailchangetokencurrent",
  "unlocktoken",
  "remembertoken",
  "otpsecret",
  "encryptedotpsecret",
  "totpsecret",
  "twofactorsecret",
  "mfasecret",
  "otpbackupcodes",
  "twofactorrecoverycodes",
  "recoverycodes",
  "backupcodes",
  "sessionsecret",
  "jwtsecret",
  "clientsecret",
  "privatekey",
  "secretkey",
  "apisecret",
  "refreshtoken",
]);

/**
 * Columns that belong to the user table, not to a profile a client needs.
 * Devise, Laravel, Supabase auth.users and common hand-rolled schemas. Two or
 * more on one object read as the whole row being serialized.
 */
const INTERNAL_COLUMNS = new Set([
  "signincount",
  "currentsigninip",
  "lastsigninip",
  "currentsigninat",
  "resetpasswordsentat",
  "remembercreatedat",
  "failedattempts",
  "failedloginattempts",
  "failedlogincount",
  "lockedat",
  "lockeduntil",
  "lastloginip",
  "salt",
  "passwordchangedat",
  "confirmationsentat",
  "recoverysentat",
  "emailchangesentat",
  "rawappmetadata",
  "issuperuser",
  "issuperadmin",
]);
const INTERNAL_ROW_MIN = 2;

// Password hash formats, by their own prefix: bcrypt, argon2, scrypt, sha-crypt,
// md5-crypt, Django and Werkzeug.
const HASH_FORMATS: readonly RegExp[] = [
  /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/,
  /^\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  /^\$scrypt\$[^\s$]+\$[A-Za-z0-9+/=.]+\$[A-Za-z0-9+/=.]+$/,
  /^\$[56]\$(?:rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{43,86}$/,
  /^\$1\$[./A-Za-z0-9]{1,8}\$[./A-Za-z0-9]{22}$/,
  /^(?:pbkdf2_sha256|pbkdf2_sha1|bcrypt_sha256|argon2|scrypt)\$[^\s]{20,}$/,
  /^(?:pbkdf2:sha(?:1|256|512)(?::\d+)?|scrypt:\d+:\d+:\d+)\$[^\s$]+\$[0-9a-f]{32,}$/,
];

/** True when the string is a password hash in a known format. */
export function looksLikePasswordHash(value: string): boolean {
  if (value.length < 20 || value.length > MAX_HASH_CHARS) return false;
  return HASH_FORMATS.some((re) => re.test(value));
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A value that carries something: a non-blank string that is not a mask, or a non-empty array or object. */
function hasContent(value: unknown): boolean {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 && !/^[*•.\-_]+$/.test(t) && !/^(?:null|undefined|redacted|\[redacted\]|\[filtered\])$/i.test(t);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return false;
}

function childPath(parent: string, key: string): string {
  // Only plain field names reach the report. A key with a digit, "@", "." or
  // any other character may be data (an email, user id or session token used
  // as a map key), so it is masked rather than copied into the finding.
  const safe = /^[A-Za-z_-]{1,32}$/.test(key) ? key : "*";
  return parent === "" ? safe : `${parent}.${safe}`;
}

/**
 * Every disclosed field in a parsed JSON answer, in document order, deduped on
 * path. Bounded in depth and node count. Reads keys and the shape of values;
 * never returns a value.
 */
export function findDisclosures(json: unknown): DisclosedField[] {
  const found: DisclosedField[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  const add = (path: string, kind: DisclosureKind) => {
    if (seen.has(path)) return;
    seen.add(path);
    found.push({ path, kind });
  };

  const walk = (value: unknown, path: string, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      if (looksLikePasswordHash(value)) add(path || "(root)", "password-hash");
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof value !== "object" || value === null) return;

    const internal: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nk = normalizeKey(key);
      const p = childPath(path, key);
      if (PASSWORD_KEYS.has(nk) && typeof child === "string" && hasContent(child)) {
        add(p, looksLikePasswordHash(child) ? "password-hash" : "password");
        continue;
      }
      if (SECRET_KEYS.has(nk) && hasContent(child)) {
        add(p, "secret");
        continue;
      }
      if (INTERNAL_COLUMNS.has(nk) && child !== null && child !== undefined && child !== "") {
        internal.push(p);
      }
      walk(child, p, depth + 1);
    }
    if (internal.length >= INTERNAL_ROW_MIN) for (const p of internal) add(p, "internal-record");
  };

  walk(json, "", 0);
  return found;
}

/** The parsed JSON of a 2xx, non-HTML, complete answer, or undefined. */
export function parseJsonAnswer(response: AuthProbeResponse): unknown {
  if (response.status < 200 || response.status >= 300) return undefined;
  if (response.truncated || response.contentType.includes("html")) return undefined;
  const text = response.body.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const KIND_LABEL: Record<DisclosureKind, string> = {
  password: "password",
  "password-hash": "password hash",
  secret: "credential secret",
  "internal-record": "internal user column",
};
const KIND_ORDER: readonly DisclosureKind[] = ["password-hash", "password", "secret", "internal-record"];

function summarize(fields: DisclosedField[]): string {
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const paths = fields.filter((f) => f.kind === kind).map((f) => f.path);
    if (paths.length === 0) continue;
    const shown = paths.slice(0, 3).join(", ");
    const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
    parts.push(`${paths.length} ${KIND_LABEL[kind]}${paths.length === 1 ? "" : "s"} (${shown}${more})`);
  }
  return parts.join("; ");
}

type EndpointVerdict =
  | { kind: "leaks"; fields: DisclosedField[] }
  | { kind: "json" }
  | { kind: "not-json" }
  | { kind: "errored" }
  /** Throttled (429) or a bot or WAF challenge: says nothing about the endpoint, and the site is pushing back. */
  | { kind: "pushback" }
  /** A server error (5xx): cannot show whether the endpoint is open. */
  | { kind: "server-error" }
  | { kind: "not-sent" };

async function probeEndpoint(
  ctx: RuleContext,
  candidate: AuthCandidate,
  cachedOnly = false
): Promise<EndpointVerdict> {
  const pending: Promise<AuthProbeOutcome> | undefined = cachedOnly
    ? peekAnonymousGet(ctx.probe, candidate.url)
    : sendAuthProbe(ctx.probe, candidate.url);
  const outcome = pending ? await pending : ({ sent: false } as const);
  if (!outcome.sent) return { kind: "not-sent" };
  if ("error" in outcome) return { kind: "errored" };
  const { response } = outcome;
  const reply = { status: response.status, headers: response.headers, text: response.body };
  // Never read a throttled, challenged or 5xx answer as "no disclosure" (#1920).
  if (isThrottledOrChallenged(reply)) return { kind: "pushback" };
  if (isUnverifiedReply(reply)) return { kind: "server-error" };
  const json = parseJsonAnswer(response);
  if (json === undefined) return { kind: "not-json" };
  const fields = findDisclosures(json);
  return fields.length > 0 ? { kind: "leaks", fields } : { kind: "json" };
}

export const authEndpointDisclosureRule: Rule = {
  meta: {
    id: "security/auth-endpoint-disclosure",
    name: "Auth Endpoint Disclosure",
    description:
      "Probes the site's current-user and session endpoints (such as /api/me and /api/session) with a GET that carries no credentials, and flags a JSON answer that contains a password, a password hash, a credential secret or the internal user record. Runs only when probing is active or aggressive, on the audited origin only.",
    solution:
      "Never serialize the user row as it is stored. Return an explicit allowlist of fields the client needs (id, name, email, avatar) from a dedicated serializer or DTO, and keep password hashes, reset, confirmation and remember tokens, OTP secrets, recovery codes, sign-in counters and IPs out of every API response. Most frameworks have one place for it: `hidden` on a Laravel model, `select` in Prisma or Drizzle, `only:` or a serializer in Rails, a `toJSON` override or a response schema in Express and Fastify, `exclude` in a Django REST serializer. An endpoint that answers a request with no session cookie should return 401 or an empty session, not a user. Then rotate whatever leaked: force a password reset for exposed hashes and revoke exposed tokens and secrets.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    // Check names by outcome class (#1741).
    checks: [
      { name: CHECK_PROBLEM, outcome: "problem" },
      { name: CHECK_CLEAN, outcome: "clean", clears: [CHECK_PROBLEM] },
      { name: CHECK_SKIPPED, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no auth or session endpoint was probed. Run with --probe active to check what they disclose.",
      });
      return { checks };
    }

    const selection = selectAuthCandidates(ctx);
    const details = {
      skippedUnsafe: selection.skippedUnsafe,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    // No candidate is not a clean result: nothing was probed (#1920).
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "no-endpoints",
        message: "Not checked: no same-origin auth or session endpoint could be probed",
        details,
      });
      return { checks };
    }

    let probed = 0;
    let jsonAnswers = 0;
    let errored = 0;
    let serverErrors = 0;
    let budgetStopped = false;
    let pushback = false;
    const leaks: Array<{ candidate: AuthCandidate; fields: DisclosedField[] }> = [];
    for (const candidate of selection.candidates) {
      // After pushback nothing new is sent (#1920), but an answer another rule
      // already got in this audit is still read: unauthenticated-api defers a
      // leaking endpoint to this rule, so skipping it would lose the finding
      // (squirrelscan#1886). Likewise past a budget refusal.
      const verdict = await probeEndpoint(ctx, candidate, pushback);
      if (verdict.kind === "not-sent") {
        if (!pushback) budgetStopped = true;
        markUnread(ctx.probe, candidate.url);
        continue;
      }
      probed++;
      if (verdict.kind === "pushback") {
        pushback = true;
        continue;
      }
      if (verdict.kind === "server-error") serverErrors++;
      if (verdict.kind === "errored") errored++;
      if (verdict.kind === "leaks" || verdict.kind === "json") jsonAnswers++;
      if (verdict.kind === "leaks") leaks.push({ candidate, fields: verdict.fields });
    }

    if (probed === 0) {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any auth or session endpoint was probed",
        details,
      });
      return { checks };
    }

    if (errored === probed) {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "probe-errors",
        message: `Every auth endpoint probe failed with a network error or timeout (${probed} endpoint(s)), so nothing was checked`,
        details: { ...details, probed, errored },
      });
      return { checks };
    }

    for (const { candidate, fields } of leaks) {
      const kinds = KIND_ORDER.filter((k) => fields.some((f) => f.kind === k));
      checks.push({
        name: CHECK_PROBLEM,
        status: "fail",
        message: `${candidate.url} answered a GET with no credentials with ${summarize(fields)}`,
        items: fields.slice(0, MAX_FIELDS_PER_ENDPOINT).map((f) => ({
          id: `${candidate.url}#${f.path}`,
          label: `${f.path}: ${KIND_LABEL[f.kind]}`,
          meta: {
            endpoint: candidate.url,
            field: f.path,
            kind: f.kind,
            source: candidate.source,
            discoveredVia: candidate.discoveredVia,
          },
        })),
        details: {
          endpoint: candidate.url,
          kinds,
          fields: fields.length,
          ...(fields.length > MAX_FIELDS_PER_ENDPOINT ? { fieldsTruncated: true } : {}),
        },
      });
    }

    // An endpoint that was never answered (budget, throttle, challenge, 5xx)
    // could be leaking, so a run that left one unread is not clean (#1920).
    const total = selection.candidates.length;
    const unverified = total - probed + serverErrors + (pushback ? 1 : 0);
    const runDetails = { ...details, probed, jsonAnswers, errored, serverErrors, pushback, budgetStopped, unverified };
    const onlyBudget = budgetStopped && !pushback && serverErrors === 0;
    if (leaks.length === 0 && unverified > 0 && onlyBudget) {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "probe-budget",
        message: `The probe budget ran out after ${probed} of ${total} auth endpoint(s). None of those probed disclosed a password, secret or user record, but the rest were not checked`,
        details: runDetails,
      });
    } else if (leaks.length === 0 && unverified > 0) {
      const why: string[] = [];
      if (pushback) {
        why.push(
          `the site throttled the probes (HTTP 429) or answered with a bot challenge after ${probed} of ${total} endpoint(s), so no further request was sent`
        );
      }
      if (budgetStopped) why.push(`the probe budget ran out after ${probed} of ${total} endpoint(s)`);
      if (serverErrors > 0) why.push(`${serverErrors} endpoint(s) answered with a server error (5xx)`);
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: PROBE_INCOMPLETE_SKIP_REASON,
        message: `Auth endpoint check incomplete: ${why.join("; ")}. ${unverified} of ${total} auth endpoint(s) were not checked and may disclose a password, secret or user record`,
        value: "not-checked",
        details: runDetails,
      });
    } else if (leaks.length === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "pass",
        message: `No auth or session endpoint disclosed a password, password hash, credential secret or internal user record (${probed} endpoint(s) probed, ${jsonAnswers} answered with JSON)`,
        details: runDetails,
      });
    }
    return { checks };
  },
};
