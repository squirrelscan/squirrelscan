// security/json-sensitive-fields - sensitive fields in the site's JSON API responses
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows it (`ctx.probe`, see probe-budget.ts) and sends
// nothing on a passive run or with no probe budget.
//
// What may be probed. Endpoints come from the endpoint discovery pass
// (`ctx.endpointSurface`) and nowhere else: no path is guessed. Every one of
// these must hold, and `selectJsonCandidates` enforces all of them:
//
//  - Same origin as the audited base URL (scheme, host and port), checked here
//    again rather than trusting `probeEligible`. Cross-origin endpoints are
//    counted, never requested.
//  - A call site that states GET, or states no method. A POST, PUT, PATCH or
//    DELETE call site is never sent anything.
//  - Not a GraphQL path (security/graphql-introspection owns those) and not a
//    path or query that names a state-changing action (`isStateChangingPath`).
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_JSON_ENDPOINTS endpoints per run.
//
// What is sent. One quiet GET per endpoint, with no cookies and no credentials,
// redirects not followed, bounded by the shared probe budget and a per-request
// timeout, and at most JSON_RESPONSE_CAP decoded bytes read (the GraphQL
// probe's capped reader, so a compression bomb is never inflated). The request
// is what any visitor's browser could send: the rule reads what the endpoint
// gives an anonymous caller.
//
// Not checked is never clean (#1920). No candidate endpoint, or any endpoint
// left unverified (an HTTP 429, a bot challenge or a 403 carrying WAF markers,
// which stops the run at once as in security/exposed-files; a 5xx; a timeout
// or network error; the budget running out) means the rule reports not
// checked, never a pass. Findings for the endpoints that did answer are kept
// alongside that note. A 401, a 403 the app sent itself (JSON or plain, no WAF
// marker: the endpoint is protected), a real 404, and a 2xx page that is not
// JSON and not a challenge count as answered.
//
// What is flagged. A 2xx JSON answer is parsed and walked (bounded depth and
// node count):
//
//  - fail: a credential in the response. A password hash by its own shape
//    (bcrypt, argon2, scrypt, PBKDF2, crypt), a value the leaked-secrets
//    matchers recognise as a server-side key, or a password, secret, token, API
//    key, SSN, card number or CVV under a field named for it.
//  - warn: bulk personal data. Email addresses or phone numbers for many
//    distinct records, or many records that carry a postal address or a date
//    of birth. A single email (a contact address, the caller's own record) is
//    not flagged.
//
// Values never reach the report: an item names the endpoint, the field path
// (array indices folded to `[]`), the kind of value and its length, never a
// character of the value itself. Paths and keys are clamped, and items are
// capped per endpoint.
//
// An unauthenticated probe cannot tell whose records came back, or prove that
// one user can read another's data: it shows what the endpoint hands to anyone
// who asks without logging in. The rule's copy says so.

import { type CheckItem, PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { EndpointCandidate } from "../endpoint-surface";
import type { ProbeBudget } from "../probe-budget";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isGraphqlPath, isStateChangingPath, isSuccessStatus } from "./graphql-probe";
import { isThrottledOrChallenged, isUnverifiedReply, readCapped } from "./probe-http";
import { isShippedServerSecret, scanContentBounded } from "./leaked-secrets";

const CHECK_SENSITIVE = "json-sensitive-fields";
const CHECK_BULK_PII = "json-bulk-pii";
const CHECK_CLEAN = "json-api-responses";

/** Endpoints probed per run. */
export const MAX_JSON_ENDPOINTS = 10;
/** Per-request timeout, on top of the shared probe budget's deadline. */
export const JSON_PROBE_TIMEOUT_MS = 10_000;
/** Decoded response bytes read per endpoint. A longer body is scanned as text only. */
export const JSON_RESPONSE_CAP = 1024 * 1024;
/** Distinct records with personal data before a response counts as bulk. */
export const BULK_PII_MIN_RECORDS = 5;
/** Items kept per endpoint and check. */
export const MAX_ITEMS_PER_ENDPOINT = 20;
/** Longest field path an item shows. */
const MAX_PATH_CHARS = 160;
/** Longest single key kept in a path. */
const MAX_KEY_CHARS = 48;
/** JSON nodes walked per response, and nesting depth followed. */
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;

// ── candidate selection ────────────────────────────────────────────

export interface JsonCandidate {
  /** Origin, path and (clean) query of the discovered endpoint. */
  url: string;
  discoveredVia: string;
}

export interface JsonCandidateSelection {
  candidates: JsonCandidate[];
  skippedCrossOrigin: number;
  skippedMethod: number;
  skippedStateChanging: number;
  skippedRobots: number;
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
 * The discovered endpoints the rule may GET, in the discovery pass's order,
 * deduped on URL. Pure: sends nothing.
 */
export function selectJsonCandidates(
  ctx: Pick<RuleContext, "site" | "endpointSurface" | "probe">
): JsonCandidateSelection {
  const selection: JsonCandidateSelection = {
    candidates: [],
    skippedCrossOrigin: 0,
    skippedMethod: 0,
    skippedStateChanging: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  const siteOrigin = baseUrl ? originOf(baseUrl) : null;
  if (!baseUrl || !siteOrigin) return selection;

  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const seen = new Set<string>();

  for (const c of ctx.endpointSurface?.candidates ?? []) {
    let u: URL;
    try {
      u = new URL(c.url, baseUrl);
    } catch {
      continue;
    }
    // Strict same origin, whatever the candidate says about itself.
    if (!c.sameOrigin || !c.probeEligible || originOf(u.href) !== siteOrigin) {
      selection.skippedCrossOrigin++;
      continue;
    }
    if (u.username || u.password) continue;
    u.hash = "";
    const url = `${u.origin}${u.pathname}${u.search}`;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isReadMethod(c)) {
      selection.skippedMethod++;
      continue;
    }
    if (isGraphqlPath(u.pathname)) continue;
    if (isStateChangingPath(u.pathname) || isStateChangingPath(u.search)) {
      selection.skippedStateChanging++;
      continue;
    }
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
      selection.skippedRobots++;
      continue;
    }
    if (selection.candidates.length >= MAX_JSON_ENDPOINTS) {
      selection.skippedCap++;
      continue;
    }
    selection.candidates.push({ url, discoveredVia: c.discoveredVia });
  }
  return selection;
}

function isReadMethod(c: EndpointCandidate): boolean {
  return c.method === undefined || c.method.toUpperCase() === "GET";
}

// ── sending ────────────────────────────────────────────────────────

export interface JsonProbeResponse {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  /** Response headers, read for a rate limit or bot challenge (`cf-mitigated`). */
  headers?: Headers;
}

export type JsonProbeOutcome =
  | { sent: false }
  | { sent: true; response: JsonProbeResponse }
  | { sent: true; error: string };

/** The exact request for one endpoint. Exported so tests can pin what is sent. */
export function buildJsonProbe(url: string): { url: string; init: RequestInit } {
  return {
    url,
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: {
        Accept: "application/json, */*;q=0.1",
        "User-Agent": SQUIRRELSCAN_USER_AGENT,
      },
    },
  };
}

/** One quiet GET, if the shared budget allows it. Sends nothing otherwise. */
export async function sendJsonProbe(
  probe: ProbeBudget | undefined,
  endpointUrl: string
): Promise<JsonProbeOutcome> {
  if (!probe || !probe.allows("quiet")) return { sent: false };
  const { url, init } = buildJsonProbe(endpointUrl);
  // Aborted once the read is done, so a capped read does not keep pulling the
  // rest of an endless answer off the wire (see sendGraphqlProbe).
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(JSON_PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const { text, truncated } = await readCapped(res, JSON_RESPONSE_CAP);
    return {
      sent: true,
      response: {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        body: text,
        truncated,
        headers: res.headers,
      },
    };
  } catch (err) {
    return { sent: true, error: err instanceof Error ? err.name || err.message : String(err) };
  } finally {
    done.abort();
  }
}

// ── field classification ───────────────────────────────────────────

/** Lower case, letters and digits only: `password_hash`, `passwordHash` and `password-hash` are one key. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type CredentialClass = "password" | "secret" | "token" | "ssn" | "card" | "cvv";

const CREDENTIAL_EXACT: Readonly<Record<string, CredentialClass>> = {
  password: "password",
  passwd: "password",
  pwd: "password",
  passwordhash: "password",
  hashedpassword: "password",
  passworddigest: "password",
  encryptedpassword: "password",
  passwordsalt: "password",
  salt: "password",
  secret: "secret",
  privatekey: "secret",
  secretkey: "secret",
  clientsecret: "secret",
  apikey: "secret",
  apisecret: "secret",
  otpsecret: "secret",
  totpsecret: "secret",
  mfasecret: "secret",
  twofactorsecret: "secret",
  recoverycodes: "secret",
  token: "token",
  accesstoken: "token",
  refreshtoken: "token",
  authtoken: "token",
  sessiontoken: "token",
  idtoken: "token",
  resettoken: "token",
  passwordresettoken: "token",
  verificationtoken: "token",
  ssn: "ssn",
  socialsecuritynumber: "ssn",
  creditcard: "card",
  creditcardnumber: "card",
  cardnumber: "card",
  ccnumber: "card",
  cvv: "cvv",
  cvv2: "cvv",
  cvc: "cvv",
  cardcvc: "cvv",
  cardcvv: "cvv",
};

// Suffixes that name the same thing with a prefix (`userPassword`, `stripeSecret`, `githubToken`).
const CREDENTIAL_SUFFIXES: ReadonlyArray<[string, CredentialClass]> = [
  ["passwordhash", "password"],
  ["password", "password"],
  ["privatekey", "secret"],
  ["secretkey", "secret"],
  ["apikey", "secret"],
  ["secret", "secret"],
  ["accesstoken", "token"],
  ["refreshtoken", "token"],
  ["authtoken", "token"],
  ["token", "token"],
];

// Tokens that are meant to reach the browser: CSRF tokens, pagination cursors.
const PUBLIC_TOKEN_KEYS = new Set([
  "csrftoken",
  "xsrftoken",
  "csrfmiddlewaretoken",
  "authenticitytoken",
  "nexttoken",
  "pagetoken",
  "nextpagetoken",
  "prevpagetoken",
  "continuationtoken",
  "paginationtoken",
  "synctoken",
  "cursortoken",
  "turnstiletoken",
  "recaptchatoken",
  "captchatoken",
]);

/** The credential class a key names, or null. */
export function credentialClass(key: string): CredentialClass | null {
  const k = normalizeKey(key);
  if (k.length === 0 || k.length > 64) return null;
  if (PUBLIC_TOKEN_KEYS.has(k)) return null;
  const exact = CREDENTIAL_EXACT[k];
  if (exact) return exact;
  for (const [suffix, cls] of CREDENTIAL_SUFFIXES) {
    if (k.endsWith(suffix)) return cls;
  }
  return null;
}

const PII_EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const PHONE_KEYS = new Set(["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "cell", "cellphone", "tel", "telephone"]);
const PERSONAL_RECORD_KEYS = new Set([
  "address",
  "streetaddress",
  "street",
  "address1",
  "addressline1",
  "homeaddress",
  "billingaddress",
  "shippingaddress",
  "dob",
  "dateofbirth",
  "birthdate",
  "birthday",
]);
const PRIVILEGE_KEYS = new Set(["role", "roles", "isadmin", "admin", "issuperuser", "superuser", "isstaff", "permissions"]);
// Keys that make an object a record about someone. `name` and `email` are not
// enough as keys alone: a form's label dictionary has both (`"email": "E-Mail"`).
const RECORD_ID_KEYS = new Set(["id", "uuid", "userid", "uid", "accountid", "customerid", "memberid"]);
const EMAIL_KEYS = new Set(["email", "emailaddress", "mail"]);

function isPhoneKey(k: string): boolean {
  return PHONE_KEYS.has(k) || k.endsWith("phone") || k.endsWith("phonenumber");
}

// Password hashes recognised by their own format, whatever the key.
const HASH_SHAPES: ReadonlyArray<[string, RegExp]> = [
  ["bcrypt hash", /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/],
  ["argon2 hash", /^\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{8,}\$[A-Za-z0-9+/]{16,}$/],
  ["scrypt hash", /^\$(?:scrypt|7)\$[./A-Za-z0-9$=,+-]{20,}$/],
  ["PBKDF2 hash", /^(?:pbkdf2_sha(?:1|256|512)\$\d{3,7}\$[A-Za-z0-9./+]{4,}\$[A-Za-z0-9./+=]{16,}|\$pbkdf2(?:-sha(?:1|256|512))?\$\d{3,7}\$[A-Za-z0-9./+]{4,}\$[A-Za-z0-9./+=]{16,})$/],
  ["crypt hash", /^\$[156]\$(?:rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{22,86}$/],
];
const HEX_DIGEST_RE = /^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{128})$/i;

/** The password-hash format a value is in, or null. */
export function passwordHashShape(value: string): string | null {
  if (value.length < 20 || value.length > 400) return null;
  if (!value.startsWith("$") && !value.startsWith("pbkdf2_")) return null;
  for (const [name, re] of HASH_SHAPES) if (re.test(value)) return name;
  return null;
}

// A value written over a credential (`********`, `[REDACTED]`, `<hidden>`), or a label.
const PLACEHOLDER_RE = /^(?:\*+|x+|•+|\.+|-+|null|none|undefined|n\/a|true|false)$|redacted|filtered|hidden|masked|removed|placeholder|example|changeme|your[_-]?/i;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * True when the leaked-secrets matchers call this key and value a key that is
 * built to ship to browsers (a Firebase `apiKey`, a Stripe `pk_live_`, a Mapbox
 * `pk.` token), which is not a leak wherever it is served.
 */
function isPublicByDesign(key: string, value: string): boolean {
  const { secrets } = scanContentBounded(`${JSON.stringify(key)}:${JSON.stringify(value)}`, "external-script");
  return secrets.some((s) => s.publicByDesign);
}

/**
 * The kind of credential a key and value pair is, or null. The value has to
 * look like the thing the key names: a password needs a record around it, a
 * token or secret needs a token-like value, a card number needs to pass Luhn.
 */
function credentialKind(
  cls: CredentialClass,
  key: string,
  value: string,
  recordHasIdentity: boolean,
  publicMemo: Map<string, boolean>
): string | null {
  const v = value.trim();
  if (v.length === 0 || PLACEHOLDER_RE.test(v)) return null;
  switch (cls) {
    case "password": {
      if (/\s/.test(v) || /^(?:https?:)?\/\//i.test(v) || v.startsWith("/")) return null;
      if (HEX_DIGEST_RE.test(v)) return "password hash or salt (hex digest)";
      // A bare word under `password` is as likely a label (`"Passwort"`) as a
      // password. Only a value inside a user-shaped record counts.
      if (!recordHasIdentity || v.length < 4 || v.length > 256) return null;
      return "plaintext password or salt";
    }
    case "secret":
    case "token": {
      if (v.length < 16 || v.length > 4096 || /\s/.test(v)) return null;
      if (/^(?:https?:)?\/\//i.test(v) || v.startsWith("/")) return null;
      // Mostly one character class (a slug, a number): not a key.
      if (/^[a-z-]+$/.test(v) || /^\d+$/.test(v)) return null;
      // Checked once per field name and value. A name alone is not enough: one
      // response can carry a public Firebase `apiKey` and a server `apiKey`,
      // and the first one checked must not decide the other. The same value
      // repeated across records is still checked once.
      const memoKey = `${normalizeKey(key)}\u0000${v}`;
      let isPublic = publicMemo.get(memoKey);
      if (isPublic === undefined) {
        isPublic = isPublicByDesign(key, v);
        publicMemo.set(memoKey, isPublic);
      }
      if (isPublic) return null;
      return cls === "secret" ? "secret or API key" : "access token";
    }
    case "ssn":
      return /^\d{3}-?\d{2}-?\d{4}$/.test(v) ? "social security number" : null;
    case "card": {
      const digits = v.replace(/[ -]/g, "");
      return /^\d{13,19}$/.test(digits) && luhnValid(digits) ? "card number" : null;
    }
    case "cvv":
      return /^\d{3,4}$/.test(v) && recordHasIdentity ? "card security code" : null;
  }
}

// ── scanning ───────────────────────────────────────────────────────

export interface SensitiveFinding {
  /** Field path with array indices folded: `$.users[].passwordHash`. */
  path: string;
  /** What the value is: `bcrypt hash`, `access token`, `card number`, a leaked-secrets type. */
  kind: string;
  /** Records it was seen in. */
  count: number;
  /** Longest value length seen. Never the value. */
  maxLength: number;
}

export interface JsonScanResult {
  sensitive: SensitiveFinding[];
  pii: {
    distinctEmails: number;
    distinctPhones: number;
    personalRecords: number;
    privilegeFields: number;
    /** Field paths carrying the personal data, folded and clamped. */
    paths: string[];
  };
  /** True when the node or depth cap stopped the walk. */
  walkTruncated: boolean;
  /**
   * The values already flagged by field, so a leaked-secrets match on the same
   * value is not reported twice. In memory only: never put in a report.
   */
  flaggedValues: Set<string>;
}

/** A path segment the report can show: printable, clamped, quoted when it is not an identifier. */
function pathSegment(key: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = key.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, MAX_KEY_CHARS);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean) ? `.${clean}` : `[${JSON.stringify(clean)}]`;
}

function clampPath(path: string): string {
  return path.length > MAX_PATH_CHARS ? `${path.slice(0, MAX_PATH_CHARS - 1)}…` : path;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The form a value is counted as distinct in. Held in memory for the count only, never reported. */
function fingerprint(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Walk a parsed JSON value and collect sensitive fields and personal data.
 * Pure, bounded, and keeps no value: only paths, kinds, counts and lengths.
 */
export function scanJsonValue(root: unknown): JsonScanResult {
  const sensitive = new Map<string, SensitiveFinding>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const piiPaths = new Set<string>();
  const flaggedValues = new Set<string>();
  const publicMemo = new Map<string, boolean>();
  let personalRecords = 0;
  let privilegeFields = 0;
  let nodes = 0;
  let walkTruncated = false;

  const record = (path: string, kind: string, length: number): void => {
    const key = `${path}\u0000${kind}`;
    const prior = sensitive.get(key);
    if (prior) {
      prior.count++;
      prior.maxLength = Math.max(prior.maxLength, length);
    } else {
      sensitive.set(key, { path: clampPath(path), kind, count: 1, maxLength: length });
    }
  };

  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value: root, path: "$", depth: 0 }];
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!;
    if (++nodes > MAX_NODES) {
      walkTruncated = true;
      break;
    }
    if (depth > MAX_DEPTH) {
      walkTruncated = true;
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: `${path}[]`, depth: depth + 1 });
      continue;
    }
    if (!isPlainObject(value)) {
      if (typeof value === "string") {
        const shape = passwordHashShape(value);
        if (shape) {
          record(path, shape, value.length);
          flaggedValues.add(value.trim());
        } else if (PII_EMAIL_RE.test(value)) {
          emails.add(fingerprint(value));
          piiPaths.add(clampPath(path));
        }
      }
      continue;
    }

    const keys = Object.keys(value);
    const normalized = keys.map(normalizeKey);
    const hasIdentity = normalized.some(
      (k, i) =>
        RECORD_ID_KEYS.has(k) ||
        (EMAIL_KEYS.has(k) && typeof value[keys[i]!] === "string" && PII_EMAIL_RE.test(value[keys[i]!] as string))
    );
    let personal = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const k = normalized[i]!;
      const child = value[key];
      const childPath = `${path}${pathSegment(key)}`;

      if (PRIVILEGE_KEYS.has(k) && child !== null && child !== undefined && child !== "") privilegeFields++;

      if (typeof child === "string" || typeof child === "number") {
        const str = String(child);
        if (typeof child === "string" && passwordHashShape(str)) {
          // Recorded when the string node itself is walked.
        } else {
          const cls = credentialClass(key);
          const kind = cls ? credentialKind(cls, key, str, hasIdentity, publicMemo) : null;
          if (kind) {
            record(childPath, kind, str.length);
            flaggedValues.add(str.trim());
            continue;
          }
        }
        if (isPhoneKey(k)) {
          const digits = str.replace(/\D/g, "");
          if (digits.length >= 7 && digits.length <= 15) {
            phones.add(fingerprint(digits));
            piiPaths.add(clampPath(childPath));
            continue;
          }
        }
        if (PERSONAL_RECORD_KEYS.has(k) && str.trim().length > 0) {
          personal = true;
          piiPaths.add(clampPath(childPath));
        }
      } else if (PERSONAL_RECORD_KEYS.has(k) && isPlainObject(child) && Object.keys(child).length > 0) {
        personal = true;
        piiPaths.add(clampPath(childPath));
      }
      // Objects and arrays are walked; a string is walked for its own shape (a hash, an email).
      if ((child !== null && typeof child === "object") || typeof child === "string") {
        stack.push({ value: child, path: childPath, depth: depth + 1 });
      }
    }
    if (personal) personalRecords++;
  }

  return {
    sensitive: [...sensitive.values()],
    pii: {
      distinctEmails: emails.size,
      distinctPhones: phones.size,
      personalRecords,
      privilegeFields,
      paths: [...piiPaths].sort().slice(0, MAX_ITEMS_PER_ENDPOINT),
    },
    walkTruncated,
    flaggedValues,
  };
}

/** True when the scan found enough personal data to count as bulk. */
export function isBulkPii(pii: JsonScanResult["pii"]): boolean {
  return (
    pii.distinctEmails >= BULK_PII_MIN_RECORDS ||
    pii.distinctPhones >= BULK_PII_MIN_RECORDS ||
    pii.personalRecords >= BULK_PII_MIN_RECORDS
  );
}

/**
 * Server-side keys the leaked-secrets matchers recognise in the response text.
 * Publishable keys and session values the crawl itself was issued are left out.
 */
function leakedSecretKinds(body: string, url: string, alreadyFlagged?: Set<string>): SensitiveFinding[] {
  const { secrets } = scanContentBounded(body, "external-script", url);
  const byType = new Map<string, SensitiveFinding>();
  for (const s of secrets) {
    if (s.publicByDesign || s.confidence === "info") continue;
    // A medium-confidence generic match is too loose for API data; a provider
    // key or a server-only secret type is not.
    if (s.confidence !== "high" && !isShippedServerSecret(s)) continue;
    if (alreadyFlagged?.has(s.value.trim())) continue;
    const prior = byType.get(s.type);
    if (prior) {
      prior.count++;
      prior.maxLength = Math.max(prior.maxLength, s.length);
    } else {
      byType.set(s.type, { path: "(response text)", kind: s.type, count: 1, maxLength: s.length });
    }
  }
  return [...byType.values()];
}

// Quoted emails in text that could not be parsed (a body over the read cap).
const QUOTED_EMAIL_RE = /"([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24})"/g;

export interface EndpointScan {
  sensitive: SensitiveFinding[];
  pii: JsonScanResult["pii"];
  /** The body was longer than the read cap: only its first bytes were scanned, as text. */
  truncated: boolean;
  walkTruncated: boolean;
}

/** True when a response is JSON by type or, failing a type, by its first byte. */
export function looksLikeJson(response: JsonProbeResponse): boolean {
  if (response.contentType.includes("html")) return false;
  if (response.contentType.includes("json")) return true;
  const first = response.body.trimStart()[0];
  return first === "{" || first === "[";
}

/** Scan one 2xx JSON response, or null when it is not one. */
export function scanJsonResponse(response: JsonProbeResponse, url: string): EndpointScan | null {
  if (!isSuccessStatus(response.status) || !looksLikeJson(response)) return null;
  const text = response.body;

  if (response.truncated) {
    // Too large to parse. The leaked-secrets matchers and a count of quoted
    // emails still read the first bytes; field names cannot be judged.
    const emails = new Set<string>();
    for (const m of text.matchAll(QUOTED_EMAIL_RE)) {
      emails.add(fingerprint(m[1]!));
      if (emails.size >= 10_000) break;
    }
    return {
      sensitive: leakedSecretKinds(text, url),
      pii: { distinctEmails: emails.size, distinctPhones: 0, personalRecords: 0, privilegeFields: 0, paths: [] },
      truncated: true,
      walkTruncated: false,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const walked = scanJsonValue(json);
  const sensitive = [...walked.sensitive, ...leakedSecretKinds(text, url, walked.flaggedValues)];
  return { sensitive, pii: walked.pii, truncated: false, walkTruncated: walked.walkTruncated };
}

// ── reporting ──────────────────────────────────────────────────────

function sensitiveItems(url: string, findings: SensitiveFinding[]): CheckItem[] {
  return findings.slice(0, MAX_ITEMS_PER_ENDPOINT).map((f) => ({
    id: `${url} ${f.path} ${f.kind}`,
    label: `${f.path}: ${f.kind}${f.count > 1 ? ` (${f.count} records)` : ""}`,
    snippet: `${f.path} = <redacted, ${f.maxLength} chars>`,
    meta: { endpoint: url, path: f.path, kind: f.kind, records: f.count, valueLength: f.maxLength },
  }));
}

function piiSummary(pii: JsonScanResult["pii"]): string {
  const parts: string[] = [];
  if (pii.distinctEmails > 0) parts.push(`${pii.distinctEmails} distinct email address(es)`);
  if (pii.distinctPhones > 0) parts.push(`${pii.distinctPhones} distinct phone number(s)`);
  if (pii.personalRecords > 0) parts.push(`${pii.personalRecords} record(s) with an address or date of birth`);
  return parts.join(", ");
}

export const jsonSensitiveFieldsRule: Rule = {
  meta: {
    id: "security/json-sensitive-fields",
    name: "Sensitive Fields in JSON API Responses",
    description:
      "Sends one GET to each same-origin API endpoint the site's own pages and scripts call, without cookies, and flags JSON responses that hand an anonymous caller password hashes, tokens, secrets, card numbers or personal data for many records. Runs only when probing is active or aggressive.",
    solution:
      "Return only the fields the client needs. Serialize API responses through an explicit allowlist (a DTO, a `select` in the query, a serializer with named fields) instead of returning whole database rows, so a new column such as `password_hash` never reaches the wire by default. Never send password hashes, salts, reset or session tokens, API keys or full card numbers to a browser at all. Require authentication on endpoints that list users or customers, scope each response to the caller, and paginate. Rotate any secret or token that has been served. This check sees only what an anonymous request gets back: it cannot prove that one signed-in user can read another's records, so test authorization with two accounts as well.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    checks: [
      { name: CHECK_SENSITIVE, outcome: "problem" },
      { name: CHECK_BULK_PII, outcome: "problem" },
      { name: CHECK_CLEAN, outcome: "clean", clears: [CHECK_SENSITIVE, CHECK_BULK_PII] },
      { name: CHECK_CLEAN, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no API endpoint was requested. Run with --probe active to check JSON responses for sensitive fields.",
      });
      return { checks };
    }

    const selection = selectJsonCandidates(ctx);
    const details = {
      skippedCrossOrigin: selection.skippedCrossOrigin,
      skippedMethod: selection.skippedMethod,
      skippedStateChanging: selection.skippedStateChanging,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    // No candidate is not a clean result: nothing was requested (#1920).
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: "no-endpoints",
        message:
          "Not checked: no API endpoints found in page code (no same-origin API endpoint that answers GET), so nothing was requested",
        details,
      });
      return { checks };
    }

    let probed = 0;
    let errored = 0;
    let jsonAnswers = 0;
    let serverErrors = 0;
    let budgetStopped = false;
    let pushback = false;
    let flagged = 0;
    for (const candidate of selection.candidates) {
      const outcome = await sendJsonProbe(ctx.probe, candidate.url);
      if (!outcome.sent) {
        budgetStopped = true;
        break;
      }
      probed++;
      if ("error" in outcome) {
        errored++;
        continue;
      }
      const { response } = outcome;
      const reply = { status: response.status, headers: response.headers, text: response.body };
      // Throttled or challenged: the answer says nothing about the endpoint,
      // and the site is pushing back, so no further request is sent (#1920).
      if (isThrottledOrChallenged(reply)) {
        pushback = true;
        break;
      }
      if (isUnverifiedReply(reply)) {
        serverErrors++;
        continue;
      }
      const scan = scanJsonResponse(response, candidate.url);
      if (!scan) continue;
      jsonAnswers++;
      const partial = scan.truncated
        ? " (the response is over 1 MB, so only its first 1 MB was read)"
        : "";
      const endpointMeta = {
        endpoint: candidate.url,
        discoveredVia: candidate.discoveredVia,
        status: outcome.response.status,
        ...(scan.truncated ? { truncated: true, confidence: "lower" } : {}),
        ...(scan.walkTruncated ? { walkTruncated: true } : {}),
      };

      if (scan.sensitive.length > 0) {
        flagged++;
        const kinds = [...new Set(scan.sensitive.map((f) => f.kind))];
        checks.push({
          name: CHECK_SENSITIVE,
          status: "fail",
          message: `${candidate.url} returns ${kinds.slice(0, 4).join(", ")}${kinds.length > 4 ? ` and ${kinds.length - 4} more kind(s)` : ""} to a request without credentials${partial}`,
          items: sensitiveItems(candidate.url, scan.sensitive),
          details: { ...endpointMeta, fields: scan.sensitive.length },
        });
      }

      const pii = scan.pii;
      if (isBulkPii(pii)) {
        flagged++;
        const { privilegeFields } = pii;
        const privilege = privilegeFields > 0 ? `, and ${privilegeFields} role or admin field(s)` : "";
        checks.push({
          name: CHECK_BULK_PII,
          status: "warn",
          message: `${candidate.url} returns personal data for many records to a request without credentials: ${piiSummary(pii)}${privilege}${partial}`,
          items: (pii.paths.length > 0 ? pii.paths : ["(response text)"]).map((path) => ({
            id: `${candidate.url} ${path}`,
            label: path,
            snippet: `${path} = <redacted>`,
            meta: { endpoint: candidate.url, path },
          })),
          details: {
            ...endpointMeta,
            distinctEmails: pii.distinctEmails,
            distinctPhones: pii.distinctPhones,
            personalRecords: pii.personalRecords,
            privilegeFields,
          },
        });
      }
    }

    if (probed === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any API endpoint was requested",
        details,
      });
      return { checks };
    }

    // An endpoint that was never answered (budget, throttle, challenge, error,
    // 5xx) could be leaking, so the run is not a clean result (#1920).
    const total = selection.candidates.length;
    const verified = probed - errored - serverErrors - (pushback ? 1 : 0);
    const unverified = total - verified;
    const runDetails = {
      ...details,
      probed,
      jsonAnswers,
      errored,
      serverErrors,
      pushback,
      budgetStopped,
      verified,
      unverified,
    };
    // Findings for the endpoints that answered stand; the note names the rest.
    if (unverified > 0) {
      const why: string[] = [];
      if (pushback) {
        why.push(
          `the site throttled the requests (HTTP 429) or answered with a bot challenge after ${probed} of ${total} endpoint(s), so no further request was sent`
        );
      }
      if (budgetStopped) why.push(`the probe budget ran out after ${probed} of ${total} endpoint(s)`);
      if (errored > 0) why.push(`${errored} request(s) failed with a network error or timeout`);
      if (serverErrors > 0) why.push(`${serverErrors} endpoint(s) answered with a server error (5xx)`);
      const onlyBudget = budgetStopped && !pushback && errored === 0 && serverErrors === 0;
      const onlyErrors = !pushback && !budgetStopped && serverErrors === 0 && errored === probed;
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: onlyBudget ? "probe-budget" : onlyErrors ? "probe-errors" : PROBE_INCOMPLETE_SKIP_REASON,
        message: `JSON API responses check incomplete: ${why.join("; ")}. ${
          flagged === 0
            ? `None of the ${verified} endpoint(s) answered returned sensitive fields, but ${unverified}`
            : `${unverified}`
        } of ${total} endpoint(s) were not verified and may be leaking`,
        value: "not-checked",
        details: runDetails,
      });
    } else if (flagged === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "pass",
        message: `No JSON response carried sensitive fields or bulk personal data (${probed} endpoint(s) requested, ${jsonAnswers} answered with JSON)`,
        details: runDetails,
      });
    }
    return { checks };
  },
};
