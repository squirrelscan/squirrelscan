// security/unauthenticated-api - API endpoints that hand records to an anonymous caller
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows it (`ctx.probe`, see probe-budget.ts) and sends
// nothing on a passive run or when `ctx.probe` is absent. That is the
// activation policy for active probes: a cloud audit stays passive until the
// website's ownership is verified, and `--disable-discovery-probes` keeps any
// run passive.
//
// What may be probed. Candidates come only from the endpoint discovery pass
// (`ctx.endpointSurface`); this rule adds no paths of its own. Every one of
// these must hold, and `selectApiCandidates` enforces all of them:
//
//  - Same origin as the audited base URL (scheme, host and port), checked here
//    again. `probeEligible` only says same-origin; it does not say safe to send.
//  - A call site that states GET, or a reference that states no method. A
//    path whose only call sites state POST, PUT, PATCH or DELETE is never
//    probed, not even with a GET.
//  - Not a path that names a state-changing or session action (logout, delete,
//    verify, callback, webhook and so on). A GET there can have side effects
//    on a badly built API, so it is never sent.
//  - Not an endpoint another rule owns: GraphQL (graphql-introspection), the
//    Next.js `_next/data` payloads, and health, metrics or API-spec paths.
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_API_ENDPOINTS endpoints, call sites first.
//
// What is sent. One GET per endpoint: origin plus path, the query string and
// fragment dropped, no cookies, no Authorization header, no redirect followed.
// The body is read up to API_RESPONSE_CAP decoded bytes. Nothing else.
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
// What is flagged. A 2xx JSON answer that carries records: an array of
// objects, an array of objects under a wrapper key (`data`, `results`,
// `items`, ...), or one object that carries an id and at least two other
// fields. The field NAMES of those records grade the finding:
//
//  - credential, personal (PII) or internal fields: fail (high);
//  - user-identity fields, or fields that say nothing either way: warn;
//  - only fields that read as published content (title, slug, price, ...):
//    info (low), since a public catalog or blog API is meant to be open.
//
// The finding names the endpoint, the number of records and the field names.
// It never carries a VALUE from the response: the sample is a shape such as
// `{id: number, email: string}`, and a field name that looks like data itself
// (an email address, a number, an id) is left out.
//
// Honest limit: an anonymous probe shows that an endpoint answers without
// credentials. It cannot show that one signed-in user can read another's data
// (that needs two identities), and it cannot tell intended public data from a
// leak except by the field names.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { EndpointCandidate } from "../endpoint-surface";
import type { ProbeBudget } from "../probe-budget";
import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  AUTH_ENDPOINT_DISCLOSURE_RULE_ID,
  authRuleLeftUnread,
  findDisclosures,
  parseJsonAnswer,
  selectAuthCandidates,
} from "./auth-endpoint-disclosure";
import { isGraphqlPath, isStateChangingPath } from "./graphql-probe";
import {
  ANONYMOUS_GET_CAP,
  ANONYMOUS_GET_TIMEOUT_MS,
  buildAnonymousGet,
  isThrottledOrChallenged,
  isUnverifiedReply,
  sendAnonymousGet,
} from "./probe-http";

/** Endpoints probed per run. */
export const MAX_API_ENDPOINTS = 10;

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const API_PROBE_TIMEOUT_MS = ANONYMOUS_GET_TIMEOUT_MS;

/** Decoded response bytes read per endpoint. A longer body is read as a prefix. */
export const API_RESPONSE_CAP = ANONYMOUS_GET_CAP;

/** Records whose field names are read per endpoint. */
const MAX_RECORDS_SCANNED = 25;
/** Distinct field names kept per endpoint. */
const MAX_FIELDS = 100;
/** Field names listed in a finding's label and message. */
const MAX_LISTED_FIELDS = 8;
/** Characters of the redacted shape sample. */
const MAX_SAMPLE_CHARS = 300;

const CHECK_SENSITIVE = "unauthenticated-api-sensitive";
const CHECK_DATA = "unauthenticated-api-data";
const CHECK_PUBLIC = "unauthenticated-api-public";
const CHECK_CLEAN = "unauthenticated-api";
const CHECK_UNCHECKED = "unauthenticated-api-unchecked";

// ── selection ───────────────────────────────────────────────────────

// Words that mark a path as a session or side-effect action, on top of the
// state-changing words graphql-probe.ts already refuses. Matched against whole
// words of the path, split at punctuation and camelCase.
const SIDE_EFFECT_WORDS = new Set([
  "login",
  "logon",
  "signin",
  "signup",
  "register",
  "auth",
  "oauth",
  "oauth2",
  "sso",
  "saml",
  "callback",
  "verify",
  "verification",
  "confirm",
  "activate",
  "invite",
  "magic",
  "token",
  "tokens",
  "session",
  "sessions",
  "webhook",
  "webhooks",
  "hook",
  "hooks",
  "cron",
  "trigger",
  "send",
  "notify",
  "sync",
  "refresh",
  "import",
  "run",
  "execute",
  "exec",
  "invoke",
  "seed",
  "migrate",
  "upload",
  "track",
  "tracking",
  "collect",
  "beacon",
  "event",
  "events",
  "log",
  "logs",
  "vote",
  "like",
  "follow",
]);
const SIDE_EFFECT_PAIRS = new Set(["log in", "sign in", "sign up"]);

// Paths another rule owns, or that describe the API rather than return its data.
const OWNED_ELSEWHERE_RE =
  /(?:^|\/)(?:_next\/data|actuator|metrics|health|healthz|readyz|livez|status|ping|openapi(?:\.json|\.ya?ml)?|swagger(?:\.json|\.ya?ml)?|api-docs|specs?)(?:\/|$)|\/swagger\/v\d+\/swagger\.json$/i;

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

/** True when the path names a session or side-effect action. Such a path is never probed. */
export function isSideEffectPath(pathname: string): boolean {
  if (isStateChangingPath(pathname)) return true;
  const words = pathWords(pathname);
  for (let i = 0; i < words.length; i++) {
    if (SIDE_EFFECT_WORDS.has(words[i]!)) return true;
    if (i + 1 < words.length && SIDE_EFFECT_PAIRS.has(`${words[i]} ${words[i + 1]}`)) return true;
  }
  return false;
}

export interface ApiCandidate {
  /** Origin plus path: the query string and fragment of the source URL are dropped. */
  url: string;
  source: EndpointCandidate["source"];
  discoveredVia: string;
}

export interface ApiCandidateSelection {
  candidates: ApiCandidate[];
  /** Left out because the call site states a method other than GET. */
  skippedMethod: number;
  /** Left out because the path names a state-changing or session action. */
  skippedSideEffect: number;
  /** Left out because another rule owns the endpoint (GraphQL, `_next/data`, health, specs). */
  skippedOwned: number;
  /** Left out because robots.txt disallows them (below aggressive). */
  skippedRobots: number;
  /** Past MAX_API_ENDPOINTS. */
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

// Call sites name a URL the page really requests; a string literal or a
// convention path is a guess. Probe the strongest evidence first.
function candidateRank(c: EndpointCandidate): number {
  if (c.source === "convention") return 3;
  if (c.discoveredVia === "string-literal") return 2;
  if (c.discoveredVia === "link-href" || c.discoveredVia === "form-action") return 1;
  return 0;
}

/**
 * The endpoints this rule may probe, in a stable order: call sites first, then
 * links and forms, then string literals, then convention paths, each group in
 * the discovery pass's order. Deduped on origin plus path. Pure: sends nothing.
 */
export function selectApiCandidates(
  ctx: Pick<RuleContext, "site" | "endpointSurface" | "probe">
): ApiCandidateSelection {
  const selection: ApiCandidateSelection = {
    candidates: [],
    skippedMethod: 0,
    skippedSideEffect: 0,
    skippedOwned: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  if (!baseUrl) return selection;
  const siteOrigin = originOf(baseUrl);
  if (!siteOrigin) return selection;

  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const ranked = (ctx.endpointSurface?.candidates ?? [])
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.probeEligible && c.sameOrigin)
    .sort((a, b) => candidateRank(a.c) - candidateRank(b.c) || a.i - b.i);

  // Origin plus path of each candidate, and the methods its call sites state.
  // A path with a GET call site is probed even when other call sites POST to
  // it (a REST list and create share a path). A method-less literal is probed
  // only when no call site states another method for the same path.
  const keyed: Array<{ c: EndpointCandidate; u: URL; url: string; method: string | undefined }> = [];
  const getPaths = new Set<string>();
  const otherPaths = new Set<string>();
  for (const { c } of ranked) {
    let u: URL;
    try {
      u = new URL(c.url, baseUrl);
    } catch {
      continue;
    }
    // Strict same origin, whatever the candidate says about itself.
    if (originOf(u.href) !== siteOrigin) continue;
    if (u.username || u.password) continue;
    const url = `${u.origin}${u.pathname}`;
    const method = c.method?.toUpperCase();
    if (method === "GET") getPaths.add(url);
    else if (method) otherPaths.add(url);
    keyed.push({ c, u, url, method });
  }

  const seen = new Set<string>();
  for (const { c, u, url } of keyed) {
    if (seen.has(url)) continue;
    if (!getPaths.has(url) && otherPaths.has(url)) {
      seen.add(url);
      selection.skippedMethod++;
      continue;
    }
    if (c.method && c.method.toUpperCase() !== "GET") continue;
    seen.add(url);
    if (isGraphqlPath(u.pathname) || OWNED_ELSEWHERE_RE.test(u.pathname)) {
      selection.skippedOwned++;
      continue;
    }
    if (isSideEffectPath(u.pathname)) {
      selection.skippedSideEffect++;
      continue;
    }
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
      selection.skippedRobots++;
      continue;
    }
    if (selection.candidates.length >= MAX_API_ENDPOINTS) {
      selection.skippedCap++;
      continue;
    }
    selection.candidates.push({ url, source: c.source, discoveredVia: c.discoveredVia });
  }
  return selection;
}

// ── sending ─────────────────────────────────────────────────────────

export interface ApiProbeResponse {
  status: number;
  contentType: string;
  /** The body as text, at most API_RESPONSE_CAP bytes. */
  body: string;
  /** True when the decoded body was longer than the cap; `body` is then a prefix. */
  truncated: boolean;
  /** Response headers, read for a rate limit or bot challenge (`cf-mitigated`). */
  headers?: Headers;
}

export type ApiProbeOutcome =
  | { sent: false }
  | { sent: true; response: ApiProbeResponse }
  | { sent: true; error: string };

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildApiProbe(endpointUrl: string): { url: string; init: RequestInit } {
  // The same anonymous GET security/auth-endpoint-disclosure sends: one answer
  // per endpoint per audit serves both rules (squirrelscan#1886).
  return buildAnonymousGet(endpointUrl);
}

/**
 * Send one quiet GET, if the shared budget allows it. Sends nothing otherwise.
 * An endpoint another rule already probed in this audit is answered from that
 * probe and costs nothing (sendAnonymousGet).
 */
export function sendApiProbe(
  probe: ProbeBudget | undefined,
  endpointUrl: string
): Promise<ApiProbeOutcome> {
  return sendAnonymousGet(probe, endpointUrl);
}

// ── reading ─────────────────────────────────────────────────────────

/** Field classes, most serious first. */
export type FieldClass = "credential" | "personal" | "internal" | "user" | "public";

const CREDENTIAL_EXACT = new Set([
  "pwd",
  "passwd",
  "salt",
  "token",
  "authtoken",
  "sessionid",
  "sessiontoken",
  "sessionkey",
  "otp",
  "mfasecret",
  "totpsecret",
  "recoverycodes",
  "backupcodes",
  "privatekey",
  "hashedpassword",
  "passwordhash",
  "pwhash",
]);
const CREDENTIAL_PARTS = ["password", "secret", "apikey", "accesskey", "privatekey"];
const CREDENTIAL_SUFFIXES = ["token", "tokenhash"];
// Pagination cursors end in "token" too, and are not credentials.
const NOT_CREDENTIAL = new Set(["pagetoken", "nextpagetoken", "nexttoken", "continuationtoken", "cursortoken"]);

const PERSONAL_EXACT = new Set([
  "phone",
  "mobile",
  "tel",
  "telephone",
  "phonenumber",
  "mobilenumber",
  "address",
  "streetaddress",
  "street",
  "addressline1",
  "addressline2",
  "homeaddress",
  "billingaddress",
  "shippingaddress",
  "postcode",
  "postalcode",
  "zip",
  "zipcode",
  "dob",
  "dateofbirth",
  "birthdate",
  "birthday",
  "ssn",
  "socialsecuritynumber",
  "nationalid",
  "taxid",
  "tfn",
  "passport",
  "passportnumber",
  "driverslicense",
  "licensenumber",
  "ip",
  "ipaddress",
  "lastip",
  "lastloginip",
  "signupip",
  "creditcard",
  "cardnumber",
  "ccnumber",
  "cvv",
  "cvc",
  "iban",
  "bankaccount",
  "accountnumber",
  "routingnumber",
  "sortcode",
]);

const INTERNAL_EXACT = new Set([
  "role",
  "roles",
  "isadmin",
  "admin",
  "issuperuser",
  "superuser",
  "isstaff",
  "permissions",
  "privileges",
  "scopes",
  "stripecustomerid",
  "stripeid",
  "stripesubscriptionid",
  "customerid",
  "tenantid",
  "lastlogin",
  "lastloginat",
  "lastsigninat",
  "loginattempts",
  "failedloginattempts",
  "emailverified",
  "isverified",
  "isbanned",
  "banned",
  "deletedat",
  "internalnotes",
  "adminnotes",
]);

const USER_EXACT = new Set([
  "username",
  "userid",
  "userids",
  "firstname",
  "lastname",
  "fullname",
  "surname",
  "givenname",
  "familyname",
  "displayname",
  "gender",
  "avatar",
  "avatarurl",
  "avatarurls",
  "user",
  "users",
  "owner",
  "ownerid",
  "createdby",
  "updatedby",
  "accountid",
  "memberid",
  "customer",
]);

const PUBLIC_EXACT = new Set([
  "title",
  "slug",
  "excerpt",
  "summary",
  "body",
  "content",
  "description",
  "publishedat",
  "publishdate",
  "datepublished",
  "published",
  "price",
  "currency",
  "sku",
  "image",
  "images",
  "imageurl",
  "thumbnail",
  "featuredimage",
  "tags",
  "tag",
  "category",
  "categories",
  "permalink",
  "url",
  "link",
  "href",
  "rating",
  "brand",
  "caption",
  "headline",
  "lang",
  "locale",
]);

function normalizeField(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The class of one field name, or null when the name says nothing either way. */
export function classifyField(name: string): FieldClass | null {
  const n = normalizeField(name);
  if (n.length === 0) return null;
  if (
    !NOT_CREDENTIAL.has(n) &&
    (CREDENTIAL_EXACT.has(n) ||
    CREDENTIAL_PARTS.some((p) => n.includes(p)) ||
      CREDENTIAL_SUFFIXES.some((s) => n.endsWith(s)))
  ) {
    return "credential";
  }
  if (n === "email" || n.endsWith("email") || n.endsWith("emailaddress")) return "personal";
  if (PERSONAL_EXACT.has(n)) return "personal";
  if (INTERNAL_EXACT.has(n) || n.startsWith("internal")) return "internal";
  if (USER_EXACT.has(n)) return "user";
  if (PUBLIC_EXACT.has(n)) return "public";
  return null;
}

// A field name worth naming in a finding: an identifier, not data. A map keyed
// by email address, user id or UUID would otherwise leak its keys.
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
const DATA_LIKE_RE = /^[0-9a-f]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-|\d{4,}/i;

function isReportableField(name: string): boolean {
  return IDENTIFIER_RE.test(name) && !DATA_LIKE_RE.test(name) && !name.includes("@");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys a record wrapper uses for its list, read before any other key. */
const WRAPPER_KEYS = [
  "data",
  "results",
  "result",
  "items",
  "records",
  "rows",
  "entries",
  "nodes",
  "edges",
  "list",
  "hits",
  "docs",
  "objects",
  "value",
  "values",
  "content",
  "payload",
  "response",
];

/** Keys of a body that only reports an outcome: `{ "error": ..., "message": ... }`. */
const ENVELOPE_ONLY_KEYS = new Set([
  "error",
  "errors",
  "message",
  "msg",
  "status",
  "statuscode",
  "code",
  "detail",
  "details",
  "title",
  "type",
  "success",
  "ok",
  "reason",
  "timestamp",
  "path",
  "instance",
  "requestid",
  "traceid",
]);

const ID_KEY_RE = /^(?:id|_id|uuid|guid|pk)$|[a-z0-9](?:_id|Id|ID)$/;

function objectsOf(arr: unknown[]): Record<string, unknown>[] | null {
  if (arr.length === 0) return null;
  const objects = arr.filter(isPlainObject);
  // A list of records, not a mixed list that happens to hold an object.
  if (objects.length === 0 || objects.length * 2 < arr.length) return null;
  return objects;
}

function isSingleRecord(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length < 3) return false;
  if (keys.every((k) => ENVELOPE_ONLY_KEYS.has(normalizeField(k)))) return false;
  return keys.some((k) => ID_KEY_RE.test(k) && obj[k] !== null && obj[k] !== "");
}

export interface RecordSet {
  /** The records found, at most MAX_RECORDS_SCANNED of them are read. */
  records: Record<string, unknown>[];
  /** Records in the list (the whole list, not only the ones read). */
  count: number;
  /** Where the list sits: `$`, `$.data`, `$.data.items`. */
  at: string;
}

function findRecordsIn(value: unknown, at: string, depth: number): RecordSet | null {
  if (Array.isArray(value)) {
    const objects = objectsOf(value);
    return objects ? { records: objects, count: value.length, at } : null;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;

  // A wrapper first: `{ "data": [...] }`, `{ "data": { "items": [...] } }`.
  if (depth < 2) {
    for (const key of keys) {
      if (!WRAPPER_KEYS.includes(key.toLowerCase())) continue;
      const found = findRecordsIn(value[key], `${at}.${key}`, depth + 1);
      if (found) return found;
    }
  }
  // Then any top-level list of objects (`{ "users": [...], "total": 3 }`): the longest.
  if (depth === 0) {
    let best: RecordSet | null = null;
    for (const key of keys) {
      const v = value[key];
      if (!Array.isArray(v)) continue;
      const objects = objectsOf(v);
      if (objects && (!best || v.length > best.count)) {
        best = { records: objects, count: v.length, at: `$.${key}` };
      }
    }
    if (best) return best;
  }
  // Then one record: an object with an id and at least two other fields.
  return isSingleRecord(value) ? { records: [value], count: 1, at } : null;
}

/** The records in a parsed JSON body, or null when it holds none. */
export function findRecords(json: unknown): RecordSet | null {
  return findRecordsIn(json, "$", 0);
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

export interface FieldSummary {
  /** Distinct reportable field names, in first-seen order. */
  fields: string[];
  /** Field names by class (not `public`: that one only lowers severity). */
  sensitive: Partial<Record<Exclude<FieldClass, "public">, string[]>>;
  /** Field names that read as published content. */
  publicFields: string[];
  /** Field names left out because they look like data, not identifiers. */
  unreportable: number;
  /** The first record's shape: field names and value types, never values. */
  sample: string;
}

/**
 * Collect field names from the records: top-level keys and one level of nested
 * objects (JSON:API `attributes`, `author.email`), plus the first object of a
 * nested list. Reads names only, never values.
 */
export function summarizeFields(records: Record<string, unknown>[]): FieldSummary {
  const fields: string[] = [];
  const seen = new Set<string>();
  let unreportable = 0;
  const add = (name: string, label: string): void => {
    if (!isReportableField(name)) {
      unreportable++;
      return;
    }
    if (seen.has(label) || fields.length >= MAX_FIELDS) return;
    seen.add(label);
    fields.push(label);
  };
  for (const record of records.slice(0, MAX_RECORDS_SCANNED)) {
    for (const [key, v] of Object.entries(record)) {
      add(key, key);
      const nested = isPlainObject(v) ? v : Array.isArray(v) && isPlainObject(v[0]) ? v[0] : null;
      if (nested && isReportableField(key)) {
        for (const inner of Object.keys(nested)) add(inner, `${key}.${inner}`);
      }
    }
  }

  const sensitive: FieldSummary["sensitive"] = {};
  const publicFields: string[] = [];
  for (const label of fields) {
    const leaf = label.slice(label.lastIndexOf(".") + 1);
    const cls = classifyField(leaf);
    if (!cls) continue;
    if (cls === "public") {
      publicFields.push(label);
      continue;
    }
    const list = sensitive[cls] ?? [];
    list.push(label);
    sensitive[cls] = list;
  }

  const first = records[0] ?? {};
  const parts: string[] = [];
  for (const [key, v] of Object.entries(first)) {
    if (!isReportableField(key)) continue;
    parts.push(`${key}: ${typeName(v)}`);
  }
  let sample = `{${parts.join(", ")}}`;
  if (sample.length > MAX_SAMPLE_CHARS) sample = `${sample.slice(0, MAX_SAMPLE_CHARS - 4)}...}`;
  return { fields, sensitive, publicFields, unreportable, sample };
}

const TRUNCATED_LIST_RE = new RegExp(
  `^\\s*(?:\\[\\s*\\{|\\{\\s*"(?:${WRAPPER_KEYS.join("|")})"\\s*:\\s*\\[\\s*\\{)`,
  "i"
);
const KEY_IN_PREFIX_RE = /[{,]\s*"([^"\\]{1,64})"\s*:/g;

/**
 * Records in a body longer than the read cap: only when the prefix opens as a
 * list of objects (`[{` or `{"data":[{`), so a large page that is not a record
 * list is never read as one. Field names are read from the prefix with a
 * bounded scan; the record count is unknown.
 */
function recordsFromPrefix(body: string): Record<string, unknown> | null {
  if (!TRUNCATED_LIST_RE.test(body)) return null;
  const fake: Record<string, unknown> = {};
  let n = 0;
  for (const m of body.matchAll(KEY_IN_PREFIX_RE)) {
    const key = m[1]!;
    if (WRAPPER_KEYS.includes(key.toLowerCase()) && n === 0) continue;
    if (!(key in fake)) fake[key] = undefined;
    if (++n > 2000) break;
  }
  return Object.keys(fake).length > 0 ? fake : null;
}

export type ApiVerdict =
  | {
      kind: "records";
      status: number;
      count: number | null;
      at: string;
      summary: FieldSummary;
      truncated: boolean;
    }
  | { kind: "no-records"; status: number }
  | { kind: "errored" }
  | { kind: "not-sent" };

/** Read one probe answer. Exported so tests can pin the classification. */
export function readApiResponse(response: ApiProbeResponse): ApiVerdict {
  const { status } = response;
  if (status < 200 || status >= 300) return { kind: "no-records", status };
  if (response.contentType.includes("html")) return { kind: "no-records", status };
  const text = response.body.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return { kind: "no-records", status };

  if (response.truncated) {
    const record = recordsFromPrefix(text);
    if (!record) return { kind: "no-records", status };
    return {
      kind: "records",
      status,
      count: null,
      at: "$",
      summary: { ...summarizeFields([record]), sample: "" },
      truncated: true,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "no-records", status };
  }
  const set = findRecords(json);
  if (!set) return { kind: "no-records", status };
  const summary = summarizeFields(set.records);
  if (summary.fields.length === 0) return { kind: "no-records", status };
  return { kind: "records", status, count: set.count, at: set.at, summary, truncated: false };
}

export type Tier = "sensitive" | "data" | "public";

/** The finding tier for a set of fields: sensitive, data, or plainly public. */
export function tierOf(summary: FieldSummary): Tier {
  const s = summary.sensitive;
  if (s.credential?.length || s.personal?.length || s.internal?.length) return "sensitive";
  if (s.user?.length) return "data";
  // Plainly public: at least two content fields, and they are a real share of
  // the record, not two incidental names on an otherwise opaque object.
  const pub = summary.publicFields.length;
  if (pub >= 2 && pub * 3 >= Math.min(summary.fields.length, 12)) return "public";
  return "data";
}

// ── the rule ────────────────────────────────────────────────────────

interface Flagged {
  candidate: ApiCandidate;
  verdict: Extract<ApiVerdict, { kind: "records" }>;
  tier: Tier;
}

function listedFields(summary: FieldSummary, tier: Tier): string[] {
  const s = summary.sensitive;
  const ordered =
    tier === "sensitive"
      ? [...(s.credential ?? []), ...(s.personal ?? []), ...(s.internal ?? [])]
      : tier === "public"
        ? summary.publicFields
        : [...(s.user ?? []), ...summary.fields];
  return [...new Set(ordered)].slice(0, MAX_LISTED_FIELDS);
}

function recordsPhrase(v: Flagged["verdict"]): string {
  if (v.count === null) return "a record list larger than 256 KB";
  return v.count === 1 ? "1 record" : `${v.count} records`;
}

function itemFor(f: Flagged): CheckItem {
  const { candidate, verdict, tier } = f;
  const fields = listedFields(verdict.summary, tier);
  return {
    id: candidate.url,
    label: `GET ${candidate.url}: ${recordsPhrase(verdict)}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`,
    meta: {
      method: "GET",
      status: verdict.status,
      records: verdict.count,
      at: verdict.at,
      fields: verdict.summary.fields.slice(0, 30),
      fieldCount: verdict.summary.fields.length,
      ...verdict.summary.sensitive,
      ...(verdict.summary.sample ? { sample: verdict.summary.sample } : {}),
      ...(verdict.summary.unreportable > 0 ? { unreportableFields: verdict.summary.unreportable } : {}),
      ...(verdict.truncated ? { truncated: true, confidence: "lower" } : {}),
      source: candidate.source,
      discoveredVia: candidate.discoveredVia,
    },
  };
}

const TIER_CHECKS: Record<
  Tier,
  { name: string; status: CheckResult["status"]; severity: string; message: (n: number, first: Flagged) => string }
> = {
  sensitive: {
    name: CHECK_SENSITIVE,
    status: "fail",
    severity: "high",
    message: (n, f) =>
      `${n} API endpoint(s) return records with credential, personal or internal fields to a request with no cookies or Authorization header, for example ${f.candidate.url} (${listedFields(f.verdict.summary, "sensitive").join(", ")})`,
  },
  data: {
    name: CHECK_DATA,
    status: "warn",
    severity: "medium",
    message: (n, f) =>
      `${n} API endpoint(s) return records to a request with no cookies or Authorization header, for example ${f.candidate.url}: confirm the data is meant to be public`,
  },
  public: {
    name: CHECK_PUBLIC,
    status: "info",
    severity: "low",
    message: (n) =>
      `${n} API endpoint(s) answer without authentication with what reads as published content (titles, slugs, prices): likely public by design`,
  },
};

export const unauthenticatedApiRule: Rule = {
  meta: {
    id: "security/unauthenticated-api",
    name: "Unauthenticated API Data",
    description:
      "Probes the site's own API endpoints with one GET that carries no cookies and no Authorization header, and flags an endpoint that answers with records. Records with credential, personal or internal fields fail; records that read as published content are informational. Runs only when probing is active or aggressive.",
    solution:
      "Check authorization on the server for every API route that returns user or business data, and answer 401 or 403 when the request carries no valid session or token. Hiding a button or a page in the frontend does not protect the API behind it. Return only the fields the caller needs: never password hashes, tokens, emails or roles in a list response. If the endpoint is meant to be public (a product catalog, a blog feed), make sure it returns only public fields. This probe is anonymous: it cannot tell whether one signed-in user can read another user's records, so test that separately with two accounts.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 7,
    checks: [
      { name: CHECK_SENSITIVE, outcome: "problem" },
      { name: CHECK_DATA, outcome: "problem" },
      { name: CHECK_PUBLIC, outcome: "problem" },
      { name: CHECK_CLEAN, outcome: "clean", clears: [CHECK_SENSITIVE, CHECK_DATA, CHECK_PUBLIC] },
      { name: CHECK_UNCHECKED, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no API endpoint was probed. Run with --probe active to check for API endpoints that answer without authentication.",
      });
      return { checks };
    }

    const selection = selectApiCandidates(ctx);
    const details = {
      skippedMethod: selection.skippedMethod,
      skippedSideEffect: selection.skippedSideEffect,
      skippedOwned: selection.skippedOwned,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    // No candidate is not a clean result: nothing was probed (#1920).
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason: "no-endpoints",
        message:
          "Not checked: no API endpoints found in page code (no same-origin API endpoint that may be read with a GET), so nothing was probed",
        details,
      });
      return { checks };
    }

    // An endpoint security/auth-endpoint-disclosure also probes is reported
    // once: by that rule when the answer carries a password, secret or the
    // user record (the more specific finding), by this rule otherwise, and by
    // this rule when the auth rule left it unread (squirrelscan#1886).
    // Undefined `ruleEnabled` means the default rule set.
    const authRuleOn = ctx.ruleEnabled?.(AUTH_ENDPOINT_DISCLOSURE_RULE_ID) ?? true;
    const authUrls = new Set(authRuleOn ? selectAuthCandidates(ctx).candidates.map((c) => c.url) : []);
    let deferredToAuth = 0;

    let probed = 0;
    let errored = 0;
    let serverErrors = 0;
    let budgetStopped = false;
    let pushback = false;
    const flagged: Flagged[] = [];
    for (const candidate of selection.candidates) {
      const outcome = await sendApiProbe(ctx.probe, candidate.url);
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
      // and the site is pushing back, so no further probe is sent (#1920).
      if (isThrottledOrChallenged(reply)) {
        pushback = true;
        break;
      }
      if (isUnverifiedReply(reply)) {
        serverErrors++;
        continue;
      }
      const verdict = readApiResponse(response);
      if (verdict.kind === "records") {
        // Checked after this rule's own GET resolved: by then the auth rule has
        // either read this answer (it was memoized before the request left) or
        // marked the endpoint unread, whichever order the rules run in.
        if (
          authUrls.has(candidate.url) &&
          !authRuleLeftUnread(ctx.probe, candidate.url) &&
          disclosesToAuthRule(response)
        ) {
          deferredToAuth++;
          continue;
        }
        flagged.push({ candidate, verdict, tier: tierOf(verdict.summary) });
      }
    }

    if (probed === 0) {
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any API endpoint was probed",
        details,
      });
      return { checks };
    }

    for (const tier of ["sensitive", "data", "public"] as const) {
      const hits = flagged.filter((f) => f.tier === tier);
      if (hits.length === 0) continue;
      const spec = TIER_CHECKS[tier];
      checks.push({
        name: spec.name,
        status: spec.status,
        message: spec.message(hits.length, hits[0]!),
        items: hits.map(itemFor),
        details: { severity: spec.severity, endpoints: hits.length, probed },
      });
    }

    // An endpoint that was never answered (budget, throttle, challenge, error,
    // 5xx) could be open, so the run is not a clean result (#1920).
    const total = selection.candidates.length;
    const verified = probed - errored - serverErrors - (pushback ? 1 : 0);
    const unverified = total - verified;
    const runDetails = {
      ...details,
      probed,
      errored,
      serverErrors,
      pushback,
      budgetStopped,
      verified,
      unverified,
      ...(deferredToAuth > 0 ? { deferredToAuth } : {}),
    };
    if (unverified > 0) {
      const why: string[] = [];
      if (pushback) {
        why.push(
          `the site throttled the probes (HTTP 429) or answered with a bot challenge after ${probed} of ${total} endpoint(s), so no further request was sent`
        );
      }
      if (budgetStopped) why.push(`the probe budget ran out after ${probed} of ${total} endpoint(s)`);
      if (errored > 0) why.push(`${errored} probe(s) failed with a network error or timeout`);
      if (serverErrors > 0) why.push(`${serverErrors} endpoint(s) answered with a server error (5xx)`);
      const onlyBudget = budgetStopped && !pushback && errored === 0 && serverErrors === 0;
      const onlyErrors = !pushback && !budgetStopped && serverErrors === 0 && errored === probed;
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason: onlyBudget ? "probe-budget" : onlyErrors ? "probe-errors" : PROBE_INCOMPLETE_SKIP_REASON,
        message: `Unauthenticated API check incomplete: ${why.join("; ")}. ${unverified} of ${total} API endpoint(s) were not checked and may be exposed`,
        value: "not-checked",
        details: runDetails,
      });
    } else if (flagged.length === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "pass",
        message:
          deferredToAuth > 0
            ? `No other API endpoint returned records without authentication (${probed} endpoint(s) probed; ${deferredToAuth} reported by ${AUTH_ENDPOINT_DISCLOSURE_RULE_ID})`
            : `No API endpoint returned records without authentication (${probed} endpoint(s) probed)`,
        details: runDetails,
      });
    }
    return { checks };
  },
};

/** True when security/auth-endpoint-disclosure reports this answer itself. */
function disclosesToAuthRule(response: ApiProbeResponse): boolean {
  const json = parseJsonAnswer(response);
  return json !== undefined && findDisclosures(json).length > 0;
}
