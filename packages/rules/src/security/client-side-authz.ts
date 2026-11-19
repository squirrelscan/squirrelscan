// security/client-side-authz - an admin API that answers without credentials
//
// The classic vibe-coded authorization bug: the frontend hides the admin
// screens behind a role check (`if (user.role === "admin")`), and the API they
// call checks nothing, so anyone who reads the bundle can call it directly.
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows it (`ctx.probe`, see probe-budget.ts) and sends
// nothing on a passive run or with no probe budget.
//
// What may be probed. A candidate comes from the endpoint discovery pass
// (`ctx.endpointSurface`): a URL referenced in the site's own pages or
// scripts. Every one of these must hold, and `selectAdminCandidates` enforces
// all of them:
//
//  - Same origin as the audited base URL (scheme, host and port), checked here
//    again. `probeEligible` only says same-origin; it does not say safe to send.
//  - Found in the site's pages or scripts, not guessed from a convention path.
//  - A privileged path: a whole path word such as `admin`, `superadmin`,
//    `staff`, `internal` or `backoffice`.
//  - Not a state-changing path: no word such as delete, update, reset, logout
//    (the GraphQL probes' list), and none of the admin actions below
//    (impersonate, ban, grant, export, ...), whatever the method.
//  - At least one reference that calls it with GET or with no stated method.
//    A URL only ever called with POST, PUT, PATCH or DELETE is a write and is
//    never probed.
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_ADMIN_ENDPOINTS endpoints per run.
//
// What may be sent. One GET per endpoint, to origin plus path (the query
// string is dropped, so a discovered `?action=delete` is never replayed). No
// cookies, no Authorization header, no custom crawl headers, no redirects
// followed, a per-request timeout plus the shared probe budget, and at most
// ADMIN_RESPONSE_CAP decoded bytes read (a compression bomb is cut at the cap).
//
// What is flagged. Only a 2xx JSON answer that carries data: a non-empty list,
// a non-empty collection under a key such as `users` or `data`, or an object
// with at least two populated fields that are not status or error fields. A
// 401 or 403, a redirect (to a login page), any other non-2xx, an HTML page
// (the SPA shell), an empty or health-shaped answer, or a 200 whose body says
// unauthorized is not flagged. The report names field names and counts, never
// a value.
//
// An unauthenticated probe proves the endpoint answers anyone. It cannot prove
// cross-tenant access (user A reading user B's data): that needs two
// signed-in identities.

import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded, readBodyCapped } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { EndpointCandidate } from "../endpoint-surface";
import type { ProbeBudget } from "../probe-budget";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { isStateChangingPath } from "./graphql-probe";

const CHECK = "client-side-authz";

/** Endpoints probed per run. */
export const MAX_ADMIN_ENDPOINTS = 8;

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const ADMIN_PROBE_TIMEOUT_MS = 10_000;

/** Decoded response bytes read per probe. A longer JSON answer is data by definition. */
export const ADMIN_RESPONSE_CAP = 256 * 1024;

/** Same-origin scripts scanned for client-side role checks, and the bytes read from each. */
const MAX_ROLE_CHECK_SCRIPTS = 50;
const MAX_ROLE_CHECK_SCAN_CHARS = 512 * 1024;

/** Whole path words that mark an endpoint as privileged. */
const PRIVILEGED_WORDS = new Set([
  "admin",
  "admins",
  "administrator",
  "administrators",
  "administration",
  "superadmin",
  "superuser",
  "sudo",
  "staff",
  "backoffice",
  "internal",
  "moderator",
  "moderation",
  "privileged",
]);

// Admin actions a GET might trigger, on top of the GraphQL probes' list of
// state-changing words. A path with any of these is never probed.
const ADMIN_ACTION_WORDS = new Set([
  "impersonate",
  "impersonation",
  "invite",
  "ban",
  "unban",
  "block",
  "unblock",
  "suspend",
  "restore",
  "grant",
  "promote",
  "demote",
  "verify",
  "approve",
  "activate",
  "enable",
  "send",
  "run",
  "execute",
  "exec",
  "trigger",
  "sync",
  "import",
  "export",
  "backup",
  "rebuild",
  "reindex",
  "migrate",
  "seed",
  "flush",
  "restart",
  "deploy",
  "publish",
  "unpublish",
  "archive",
  "refund",
  "charge",
  "notify",
  "email",
  "ajax",
]);

const SAFE_METHODS = new Set(["GET", "HEAD"]);

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

/** True when a whole path word names an admin or privileged area. */
export function isPrivilegedPath(pathname: string): boolean {
  return pathWords(pathname).some((w) => PRIVILEGED_WORDS.has(w));
}

/** True when the path names an action: such a path is never probed, whatever the method. */
export function isAdminActionPath(pathname: string): boolean {
  if (isStateChangingPath(pathname)) return true;
  return pathWords(pathname).some((w) => ADMIN_ACTION_WORDS.has(w));
}

export interface AdminCandidate {
  /** Origin plus path: the query string and fragment of the source URL are dropped. */
  url: string;
  /** The discovery pass's `discoveredVia` for the first GET-callable reference. */
  discoveredVia: string;
}

export interface AdminCandidateSelection {
  candidates: AdminCandidate[];
  /** Privileged paths left out because the path names an action. */
  skippedStateChanging: number;
  /** Privileged paths left out because every reference calls them with a write method. */
  skippedWriteOnly: number;
  /** Privileged paths left out because robots.txt disallows them (below aggressive). */
  skippedRobots: number;
  /** Privileged paths past MAX_ADMIN_ENDPOINTS. */
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
 * The admin endpoints this rule may probe, in the discovery pass's order,
 * deduped on origin plus path. Pure: sends nothing.
 */
export function selectAdminCandidates(
  ctx: Pick<RuleContext, "site" | "endpointSurface" | "probe">
): AdminCandidateSelection {
  const selection: AdminCandidateSelection = {
    candidates: [],
    skippedStateChanging: 0,
    skippedWriteOnly: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  if (!baseUrl) return selection;
  const siteOrigin = originOf(baseUrl);
  if (!siteOrigin) return selection;

  // Group the references per origin plus path, keeping first-seen order, so a
  // URL called with GET in one place and POST in another is probed by GET.
  const groups = new Map<string, { getVia?: string; refs: number }>();
  for (const c of ctx.endpointSurface?.candidates ?? []) {
    if (!c.probeEligible || !c.sameOrigin || c.source === "convention") continue;
    let u: URL;
    try {
      u = new URL(c.url, baseUrl);
    } catch {
      continue;
    }
    // Strict same origin, whatever the candidate says about itself.
    if (originOf(u.href) !== siteOrigin) continue;
    if (u.username || u.password) continue;
    if (!isPrivilegedPath(u.pathname)) continue;
    const key = `${u.origin}${u.pathname}`;
    const group = groups.get(key) ?? { refs: 0 };
    group.refs++;
    if (group.getVia === undefined && isGetCallable(c)) group.getVia = c.discoveredVia;
    groups.set(key, group);
  }

  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  for (const [url, group] of groups) {
    if (isAdminActionPath(new URL(url).pathname)) {
      selection.skippedStateChanging++;
      continue;
    }
    if (group.getVia === undefined) {
      selection.skippedWriteOnly++;
      continue;
    }
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
      selection.skippedRobots++;
      continue;
    }
    if (selection.candidates.length >= MAX_ADMIN_ENDPOINTS) {
      selection.skippedCap++;
      continue;
    }
    selection.candidates.push({ url, discoveredVia: group.getVia });
  }
  return selection;
}

function isGetCallable(c: EndpointCandidate): boolean {
  return c.method === undefined || SAFE_METHODS.has(c.method.toUpperCase());
}

// ── sending ─────────────────────────────────────────────────────────

export interface AdminProbeResponse {
  status: number;
  contentType: string;
  /** The body as text, at most ADMIN_RESPONSE_CAP bytes. */
  body: string;
  /** True when the decoded body was longer than the cap; `body` is then a prefix. */
  truncated: boolean;
}

export type AdminProbeOutcome =
  | { sent: false }
  | { sent: true; response: AdminProbeResponse }
  | { sent: true; error: string };

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildAdminProbe(endpointUrl: string): { url: string; init: RequestInit } {
  const u = new URL(endpointUrl);
  u.search = "";
  u.hash = "";
  return {
    url: u.href,
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

/** Send one GET, if the shared budget allows a quiet probe. */
export async function sendAdminProbe(
  probe: ProbeBudget | undefined,
  endpointUrl: string
): Promise<AdminProbeOutcome> {
  if (!probe || !probe.allows("quiet")) return { sent: false };
  const { url, init } = buildAdminProbe(endpointUrl);
  // Aborted once the probe is done, so a capped read does not keep pulling the
  // rest of an endless answer off the wire until the timeout.
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(ADMIN_PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  // Counted before the request leaves, so a request that fails still uses budget.
  probe.record();
  try {
    // Never `fetch` itself: Bun inflates a Content-Encoding body in full before
    // any capped read (#722).
    const res = await fetchUndecoded(url, { ...init, signal });
    // One byte over the cap tells a full answer from a cut one.
    const text = await readBodyCapped(res, ADMIN_RESPONSE_CAP + 1);
    const bytes = new TextEncoder().encode(text);
    const truncated = bytes.byteLength > ADMIN_RESPONSE_CAP;
    return {
      sent: true,
      response: {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        body: truncated ? new TextDecoder().decode(bytes.subarray(0, ADMIN_RESPONSE_CAP)) : text,
        truncated,
      },
    };
  } catch (err) {
    return { sent: true, error: err instanceof Error ? err.name || err.message : String(err) };
  } finally {
    done.abort();
  }
}

// ── reading ─────────────────────────────────────────────────────────

/** What the answer shows, without any value from it. */
export interface ExposedData {
  /** Records seen: list length, or 1 for a single populated object. A lower bound when truncated. */
  records: number;
  /** Field names of the first record (at most 12). */
  fields: string[];
  /** Field names that look sensitive (email, password, token, role, ...). */
  sensitiveFields: string[];
  /** The answer was longer than the read cap, so it was not parsed in full. */
  truncated?: true;
}

export type AdminVerdict =
  | { kind: "exposed"; data: ExposedData }
  | { kind: "enforced" }
  | { kind: "redirected" }
  | { kind: "not-data" }
  | { kind: "other-status" };

// Keys that describe the response, not data: a body made only of these says
// nothing about what the endpoint guards.
const ENVELOPE_KEYS = new Set([
  "status",
  "statuscode",
  "ok",
  "success",
  "healthy",
  "health",
  "version",
  "uptime",
  "timestamp",
  "time",
  "message",
  "msg",
  "error",
  "errors",
  "code",
  "detail",
  "details",
  "reason",
  "title",
  "type",
  "instance",
  "path",
  "method",
  "requestid",
  "traceid",
  "redirect",
  "redirectto",
  "redirecturl",
  "location",
  "url",
  "loginurl",
  "authenticated",
  "authorized",
  "loggedin",
  "isloggedin",
  "isauthenticated",
  "user",
  "session",
  "csrf",
  "csrftoken",
  // Pagination metadata around a list.
  "total",
  "count",
  "page",
  "per_page",
  "perpage",
  "pagesize",
  "limit",
  "offset",
  "next",
  "prev",
  "cursor",
  "has_more",
  "hasmore",
  "totalcount",
  "total_count",
  "pageinfo",
  "page_info",
  "nextcursor",
  "next_cursor",
  "page_size",
  "totalpages",
  "total_pages",
]);

// Keys that hold the records of a list response.
const COLLECTION_KEYS = new Set([
  "data",
  "items",
  "results",
  "records",
  "rows",
  "entries",
  "list",
  "nodes",
  "edges",
  "users",
  "accounts",
  "customers",
  "members",
  "orders",
  "payments",
  "invoices",
  "subscriptions",
  "transactions",
  "tenants",
  "organizations",
  "orgs",
  "teams",
  "roles",
  "permissions",
  "logs",
  "events",
  "audit",
  "reports",
  "content",
  "docs",
  "documents",
]);

const SENSITIVE_FIELD_RE =
  /(?:e-?mail|password|passwd|pwd|hash|salt|secret|token|api_?key|apikey|ssn|phone|address|dob|birth|card|iban|role|permission|is_?admin|stripe|billing|ip_?addr|last_?login)/i;

// A 200 whose body says the caller is not allowed: the server enforces, just
// with the wrong status.
const DENIAL_RE =
  /\b(?:unauthori[sz]ed|unauthenticated|not authenticated|not authori[sz]ed|forbidden|access denied|permission denied|login required|not logged in|authentication required|sign in required|invalid token|missing token|no token)\b/i;

const DENIAL_FLAG_KEYS = ["authenticated", "authorized", "loggedIn", "isLoggedIn", "isAuthenticated"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPopulated(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

function saysDenied(json: Record<string, unknown>): boolean {
  if (DENIAL_FLAG_KEYS.some((k) => json[k] === false)) return true;
  for (const key of ["error", "message", "msg", "detail", "reason", "code", "status", "title"]) {
    const v = json[key];
    if (typeof v === "string" && DENIAL_RE.test(v.slice(0, 500))) return true;
    if (isPlainObject(v)) {
      const inner = v.message ?? v.code ?? v.detail;
      if (typeof inner === "string" && DENIAL_RE.test(inner.slice(0, 500))) return true;
    }
  }
  if (Array.isArray(json.errors)) {
    for (const e of json.errors.slice(0, 5)) {
      const m = isPlainObject(e) ? e.message : e;
      if (typeof m === "string" && DENIAL_RE.test(m.slice(0, 500))) return true;
    }
  }
  return false;
}

function fieldsOf(record: unknown): string[] {
  return isPlainObject(record) ? Object.keys(record).slice(0, 12) : [];
}

function summarize(records: number, first: unknown): ExposedData {
  const fields = fieldsOf(first);
  return { records, fields, sensitiveFields: fields.filter((f) => SENSITIVE_FIELD_RE.test(f)) };
}

/** The data in a parsed JSON answer, or null when it carries none. */
export function readExposedData(json: unknown): ExposedData | null {
  if (Array.isArray(json)) {
    const records = json.filter(isPopulated);
    return records.length > 0 ? summarize(records.length, records[0]) : null;
  }
  if (!isPlainObject(json)) return null;
  if (saysDenied(json)) return null;
  for (const [key, value] of Object.entries(json)) {
    if (!COLLECTION_KEYS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      const records = value.filter(isPopulated);
      if (records.length > 0) return summarize(records.length, records[0]);
    } else if (isPlainObject(value)) {
      // `{ data: { users: [...] } }` or `{ data: { id, email, ... } }`.
      const inner = readExposedData(value);
      if (inner) return inner;
    }
  }
  const dataKeys = Object.keys(json).filter(
    (k) => !ENVELOPE_KEYS.has(k.toLowerCase()) && !COLLECTION_KEYS.has(k.toLowerCase()) && isPopulated(json[k])
  );
  if (dataKeys.length < 2) return null;
  const fields = dataKeys.slice(0, 12);
  return { records: 1, fields, sensitiveFields: fields.filter((f) => SENSITIVE_FIELD_RE.test(f)) };
}

function looksLikeHtml(response: AdminProbeResponse): boolean {
  return response.contentType.includes("html") || response.body.trimStart().startsWith("<");
}

/** Judge one probe answer. */
export function classifyAdminResponse(response: AdminProbeResponse): AdminVerdict {
  const { status } = response;
  if (status === 401 || status === 403) return { kind: "enforced" };
  if (status >= 300 && status < 400) return { kind: "redirected" };
  if (status < 200 || status >= 300) return { kind: "other-status" };
  if (looksLikeHtml(response)) return { kind: "not-data" };
  const text = response.body.trim();
  if (response.truncated) {
    // Longer than the cap: not parseable, but a JSON list or object this large
    // is data. Lower confidence, since its contents were not read in full.
    const jsonish = response.contentType.includes("json") && (text.startsWith("[") || text.startsWith("{"));
    if (!jsonish || DENIAL_RE.test(text.slice(0, 500))) return { kind: "not-data" };
    return { kind: "exposed", data: { records: 1, fields: [], sensitiveFields: [], truncated: true } };
  }
  if (!text.startsWith("[") && !text.startsWith("{")) return { kind: "not-data" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "not-data" };
  }
  if (isPlainObject(json) && saysDenied(json)) return { kind: "enforced" };
  const data = readExposedData(json);
  return data ? { kind: "exposed", data } : { kind: "not-data" };
}

// ── client-side role checks ─────────────────────────────────────────

// A role check in client code: `isAdmin`, `hasRole("admin")`,
// `role === "admin"`, `roles.includes("admin")`. Not global, driven by `test`
// only, every repetition bounded: linear in the input.
const ROLE_CHECK_RE =
  /\b(?:is_?(?:super_?)?admin\b|isStaff\b|hasRole\s*\(\s*["'`](?:super_?)?admin|roles?\s{0,4}[!=]==?\s{0,4}["'`](?:super_?admin|admin|staff|owner)["'`]|roles?\s{0,4}\.\s{0,4}includes\s*\(\s*["'`](?:super_?admin|admin|staff)["'`])/i;

/** Same-origin scripts whose code contains a client-side role check (URLs, at most 5). */
export function findClientRoleChecks(ctx: Pick<RuleContext, "site">): string[] {
  const siteOrigin = originOf(ctx.site?.baseUrl ?? "");
  if (!siteOrigin) return [];
  const hits: string[] = [];
  let scanned = 0;
  for (const script of ctx.site?.scripts ?? []) {
    if (scanned >= MAX_ROLE_CHECK_SCRIPTS || hits.length >= 5) break;
    if (!script.content || originOf(script.url) !== siteOrigin) continue;
    scanned++;
    if (ROLE_CHECK_RE.test(script.content.slice(0, MAX_ROLE_CHECK_SCAN_CHARS))) hits.push(script.url);
  }
  return hits;
}

// ── the rule ────────────────────────────────────────────────────────

const LIMIT_NOTE =
  "An unauthenticated probe shows the endpoint answers anyone; it cannot show whether one signed-in user can read another's data.";

function describeExposure(data: ExposedData): string {
  if (data.truncated) return "a JSON answer larger than 256 KB, too large to read in full";
  const what = data.records === 1 ? "1 record" : `${data.records} records`;
  const fields = data.fields.length > 0 ? ` (fields: ${data.fields.slice(0, 6).join(", ")})` : "";
  return `${what}${fields}`;
}

export const clientSideAuthzRule: Rule = {
  meta: {
    id: "security/client-side-authz",
    name: "Client-Side-Only Authorization",
    description:
      "Finds admin and other privileged API endpoints referenced in the site's own JavaScript, sends each one GET without cookies or credentials, and flags an endpoint that answers with data. If an admin API answers anyone, the frontend is the only gate. Runs only when probing is active or aggressive.",
    solution:
      "Enforce authorization on the server, in every admin route or in middleware in front of all of them: read the session or token, look up the caller's role server-side, and answer 401 when nobody is signed in and 403 when the caller lacks the role. Hiding a link or a screen in the frontend is not access control, because anyone can read the bundle and call the API directly. In Next.js, check the session inside each route handler or server action (middleware alone can be bypassed); in Express or Fastify, mount an auth guard on the whole `/api/admin` router; with Supabase or Firebase, enforce it in row-level security or security rules, not in the client. Then re-run with `--probe active` to confirm each endpoint answers 401 or 403.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no admin endpoint was probed. Run with --probe active to check whether admin APIs answer without credentials.",
      });
      return { checks };
    }

    const selection = selectAdminCandidates(ctx);
    const details = {
      skippedStateChanging: selection.skippedStateChanging,
      skippedWriteOnly: selection.skippedWriteOnly,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    if (selection.candidates.length === 0) {
      const robotsNote =
        selection.skippedRobots > 0
          ? ` (${selection.skippedRobots} disallowed by robots.txt; --probe aggressive probes them)`
          : "";
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No same-origin admin API endpoint referenced in the site's pages or scripts could be probed${robotsNote}`,
        details,
      });
      return { checks };
    }

    const roleCheckScripts = findClientRoleChecks(ctx);
    let probed = 0;
    let enforced = 0;
    let errored = 0;
    let budgetStopped = false;
    const exposed: Array<{ candidate: AdminCandidate; status: number; data: ExposedData }> = [];
    for (const candidate of selection.candidates) {
      const outcome = await sendAdminProbe(ctx.probe, candidate.url);
      if (!outcome.sent) {
        budgetStopped = true;
        break;
      }
      probed++;
      if ("error" in outcome) {
        errored++;
        continue;
      }
      const verdict = classifyAdminResponse(outcome.response);
      if (verdict.kind === "enforced") enforced++;
      if (verdict.kind === "exposed") {
        exposed.push({ candidate, status: outcome.response.status, data: verdict.data });
      }
    }

    if (probed === 0) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any admin endpoint was probed",
        details,
      });
      return { checks };
    }

    if (errored === probed) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-errors",
        message: `Every admin endpoint probe failed with a network error or timeout (${probed} endpoint(s)), so authorization was not checked`,
        details: { ...details, probed, errored },
      });
      return { checks };
    }

    const roleNote =
      roleCheckScripts.length > 0 ? " The site's JavaScript also checks the user's role client-side." : "";
    for (const { candidate, status, data } of exposed) {
      checks.push({
        name: CHECK,
        status: "fail",
        message: `Admin endpoint ${candidate.url} answered a request with no credentials: ${status} with ${describeExposure(data)}. The server does not check who is asking, so the frontend is the only gate.${roleNote} ${LIMIT_NOTE}`,
        items: [
          {
            id: candidate.url,
            label: `${candidate.url}: ${status}, ${describeExposure(data)}`,
            meta: {
              method: "GET",
              status,
              records: data.records,
              fields: data.fields,
              sensitiveFields: data.sensitiveFields,
              ...(data.truncated ? { truncated: true, confidence: "lower" } : {}),
              discoveredVia: candidate.discoveredVia,
            },
          },
        ],
        details: {
          endpoint: candidate.url,
          status,
          ...data,
          ...(roleCheckScripts.length > 0 ? { clientRoleCheckScripts: roleCheckScripts } : {}),
        },
      });
    }

    // A run the budget cut short is not a clean result: the endpoints it never
    // reached could be open.
    if (exposed.length === 0 && budgetStopped) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-budget",
        message: `The probe budget ran out after ${probed} of ${selection.candidates.length} admin endpoint(s). None of those probed answered with data, but the rest were not checked`,
        details: { ...details, probed, enforced, errored, budgetStopped },
      });
    } else if (exposed.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No admin endpoint answered with data without credentials (${probed} endpoint(s) probed, ${enforced} refused with 401 or 403)`,
        details: { ...details, probed, enforced, errored, budgetStopped },
      });
    }
    return { checks };
  },
};
