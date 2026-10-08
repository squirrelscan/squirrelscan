// Shared GraphQL probing for security/graphql-introspection and
// security/graphql-get-mutations: which endpoints may be probed, the only
// requests that may be sent to them, and how a response is read.
//
// What may be probed. A candidate comes from the endpoint discovery pass
// (`ctx.endpointSurface`) or from a short list of conventional paths. Every one
// of these must hold, and `selectGraphqlCandidates` enforces all of them:
//
//  - Same origin as the audited base URL (scheme, host and port), checked here
//    again. `probeEligible` only says same-origin; it does not say safe to send.
//  - A GraphQL-looking path: a `graphql` or `gql` path segment.
//  - Not a state-changing path. A call site can name `/graphql/logout` or
//    `/api/delete-account/graphql`; any path with a word such as logout,
//    delete, update or reset is never probed, whatever the method.
//  - Not a call site that declares PUT, PATCH or DELETE.
//  - Not disallowed by robots.txt, unless the run is aggressive (aggressive
//    probing requests robots-disallowed paths on purpose, see the docs).
//  - At most MAX_GRAPHQL_ENDPOINTS endpoints per rule, one request each (the
//    introspection rule may add one POST per endpoint when aggressive).
//
// What may be sent. `sendGraphqlProbe` takes an operation name, not a query, so
// a caller cannot send anything else: the read-only introspection query
// `{__schema{types{name}}}` (GET, or POST when aggressive), and the no-op
// mutation `mutation{__typename}` (GET only), which names no schema field and
// cannot write. Requests carry no cookies, do not follow redirects, are bounded
// by the shared probe budget and a per-request timeout, and read at most a
// fixed number of response bytes.
//
// Rules ask `ctx.probe.allows(...)` through `sendGraphqlProbe`, which also
// records the request, so a passive run or an absent `ctx.probe` sends nothing.

import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { EndpointCandidate } from "../endpoint-surface";
import type { ProbeBudget } from "../probe-budget";
import type { RuleContext } from "../types";

/** Paths probed on every site, besides the ones the discovery pass found. */
export const GRAPHQL_CONVENTION_PATHS: readonly string[] = ["/graphql", "/api/graphql"];

/** Endpoints one rule probes per run. */
export const MAX_GRAPHQL_ENDPOINTS = 5;

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const GRAPHQL_PROBE_TIMEOUT_MS = 10_000;

/** The read-only introspection query: type names only. */
export const INTROSPECTION_QUERY = "{__schema{types{name}}}";

/** The no-op mutation: selects only `__typename`, so no resolver runs and nothing is written. */
export const NOOP_MUTATION = "mutation{__typename}";

/** Response bytes read for each operation. A longer body is not parsed. */
export const GRAPHQL_RESPONSE_CAPS = {
  introspection: 1024 * 1024,
  "noop-mutation": 64 * 1024,
} as const;

/** The only requests this module sends. */
export type GraphqlProbeRequest =
  | { op: "introspection"; method: "GET" | "POST" }
  | { op: "noop-mutation"; method: "GET" };

const QUERIES: Record<GraphqlProbeRequest["op"], string> = {
  introspection: INTROSPECTION_QUERY,
  "noop-mutation": NOOP_MUTATION,
};

const GRAPHQL_PATH_RE = /(?:^|\/)(?:graphql|gql)(?:\/|$)/i;
const UNSAFE_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

// Words that mark a path as state-changing. Matched against whole words of the
// path (split at punctuation and camelCase), so `/graphql` and `/api/gql` stay
// clean while `/graphql/logout`, `/deleteUser/graphql` and `/update-gql` do not.
const STATE_CHANGING_WORDS = new Set([
  "logout",
  "logoff",
  "signout",
  "delete",
  "del",
  "remove",
  "destroy",
  "update",
  "edit",
  "create",
  "insert",
  "upsert",
  "save",
  "submit",
  "unsubscribe",
  "subscribe",
  "cancel",
  "revoke",
  "reset",
  "purge",
  "disable",
  "deactivate",
  "drop",
  "wipe",
  "clear",
  "kill",
  "terminate",
  "approve",
  "reject",
  "transfer",
  "pay",
  "checkout",
  "mutate",
  "mutation",
  "mutations",
  "write",
  "set",
]);
// Two-word forms (`log-out`, `sign_out`, `logOut`).
const STATE_CHANGING_PAIRS = new Set(["log out", "log off", "sign out"]);

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

/** True when the path names a state-changing action. Such a path is never probed. */
export function isStateChangingPath(pathname: string): boolean {
  const words = pathWords(pathname);
  for (let i = 0; i < words.length; i++) {
    if (STATE_CHANGING_WORDS.has(words[i]!)) return true;
    if (i + 1 < words.length && STATE_CHANGING_PAIRS.has(`${words[i]} ${words[i + 1]}`)) {
      return true;
    }
  }
  return false;
}

/** True when the path has a `graphql` or `gql` segment. */
export function isGraphqlPath(pathname: string): boolean {
  return GRAPHQL_PATH_RE.test(pathname);
}

export interface GraphqlCandidate {
  /** Origin plus path: the query string and fragment of the source URL are dropped. */
  url: string;
  /** `discovered` from the endpoint discovery pass, `convention` from GRAPHQL_CONVENTION_PATHS. */
  source: "discovered" | "convention";
  /** The discovery pass's `discoveredVia`, or `convention`. */
  discoveredVia: string;
}

export interface GraphqlCandidateSelection {
  candidates: GraphqlCandidate[];
  /** GraphQL-looking candidates left out because the path or method changes state. */
  skippedStateChanging: number;
  /** Candidates left out because robots.txt disallows them (below aggressive). */
  skippedRobots: number;
  /** Candidates past MAX_GRAPHQL_ENDPOINTS. */
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
 * The GraphQL endpoints a rule may probe, in a stable order: discovered
 * endpoints first (in the discovery pass's order), then the conventional paths.
 * Deduped on origin plus path. Pure: sends nothing.
 */
export function selectGraphqlCandidates(
  ctx: Pick<RuleContext, "site" | "endpointSurface" | "probe">
): GraphqlCandidateSelection {
  const empty: GraphqlCandidateSelection = {
    candidates: [],
    skippedStateChanging: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  if (!baseUrl) return empty;
  const siteOrigin = originOf(baseUrl);
  if (!siteOrigin) return empty;

  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const seen = new Set<string>();
  const out: GraphqlCandidate[] = [];
  let skippedStateChanging = 0;
  let skippedRobots = 0;
  let skippedCap = 0;

  const consider = (
    rawUrl: string,
    source: GraphqlCandidate["source"],
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
    if (!isGraphqlPath(u.pathname)) return;
    const url = `${u.origin}${u.pathname}`;
    if (seen.has(url)) return;
    if (isStateChangingPath(u.pathname) || (method && UNSAFE_METHODS.has(method.toUpperCase()))) {
      seen.add(url);
      skippedStateChanging++;
      return;
    }
    seen.add(url);
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
      skippedRobots++;
      return;
    }
    if (out.length >= MAX_GRAPHQL_ENDPOINTS) {
      skippedCap++;
      return;
    }
    out.push({ url, source, discoveredVia });
  };

  for (const c of ctx.endpointSurface?.candidates ?? []) {
    if (!c.probeEligible || !c.sameOrigin) continue;
    consider(c.url, candidateSource(c), c.discoveredVia, c.method);
  }
  for (const path of GRAPHQL_CONVENTION_PATHS) {
    consider(path, "convention", "convention", "GET");
  }
  return { candidates: out, skippedStateChanging, skippedRobots, skippedCap };
}

function candidateSource(c: EndpointCandidate): GraphqlCandidate["source"] {
  return c.source === "convention" ? "convention" : "discovered";
}

// ── sending ─────────────────────────────────────────────────────────

export interface GraphqlProbeResponse {
  status: number;
  contentType: string;
  /** The body as text, at most the operation's byte cap. */
  body: string;
  /** True when the body was longer than the cap; `body` is then a prefix. */
  truncated: boolean;
}

export type GraphqlProbeOutcome =
  | { sent: false; reason: "not-allowed" }
  | { sent: true; response: GraphqlProbeResponse }
  | { sent: true; error: string };

/** Build the exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildGraphqlProbe(
  endpointUrl: string,
  request: GraphqlProbeRequest
): { url: string; init: RequestInit } {
  const query = QUERIES[request.op];
  const u = new URL(endpointUrl);
  u.search = "";
  u.hash = "";
  const headers: Record<string, string> = {
    Accept: "application/graphql-response+json, application/json;q=0.9",
    "User-Agent": SQUIRRELSCAN_USER_AGENT,
  };
  const base: RequestInit = { credentials: "omit", redirect: "manual", headers };
  if (request.method === "GET") {
    u.searchParams.set("query", query);
    return { url: u.href, init: { ...base, method: "GET" } };
  }
  // POST is only ever the introspection query.
  if (request.op !== "introspection") throw new Error("only introspection may be sent as POST");
  return {
    url: u.href,
    init: {
      ...base,
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    },
  };
}

// The per-chunk cap is the guard; `content-length` is not trusted. A stalled
// body is bounded by the request signal, which also aborts `reader.read()`.
async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

/**
 * Send one probe, if the shared budget allows it. GET is a quiet probe (needs
 * `active`); the introspection POST is loud (needs `aggressive`). Returns
 * `{ sent: false }` without touching the network when it is not allowed.
 */
export async function sendGraphqlProbe(
  probe: ProbeBudget | undefined,
  endpointUrl: string,
  request: GraphqlProbeRequest
): Promise<GraphqlProbeOutcome> {
  const kind = request.method === "GET" ? "quiet" : "loud";
  if (!probe || !probe.allows(kind)) return { sent: false, reason: "not-allowed" };
  const { url, init } = buildGraphqlProbe(endpointUrl, request);
  const signal = AbortSignal.any([probe.signal(), AbortSignal.timeout(GRAPHQL_PROBE_TIMEOUT_MS)]);
  // Counted before the request leaves, so a request that fails still uses budget.
  probe.record();
  try {
    const res = await globalThis.fetch(url, { ...init, signal });
    const { text, truncated } = await readCapped(res, GRAPHQL_RESPONSE_CAPS[request.op]);
    return {
      sent: true,
      response: {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        body: text,
        truncated,
      },
    };
  } catch (err) {
    return { sent: true, error: err instanceof Error ? err.name || err.message : String(err) };
  }
}

// ── reading ─────────────────────────────────────────────────────────

export interface GraphqlError {
  message: string;
}

/** A GraphQL-shaped JSON response, or null for anything else. */
export interface GraphqlBody {
  /** `data` as sent: an object, null, or undefined when absent. */
  data: Record<string, unknown> | null | undefined;
  errors: GraphqlError[];
}

const GRAPHQL_TOP_LEVEL_KEYS = new Set(["data", "errors", "extensions"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a response as a GraphQL response, strictly: a JSON object (not HTML,
 * not truncated) whose keys are only `data`, `errors` and `extensions`, with
 * `data` an object or null, and `errors` a non-empty array of objects that each
 * carry a string `message`. A catch-all page, an HTML error, a REST error body
 * or a JSON:API error object is null. The status is not read here.
 */
export function parseGraphqlBody(response: GraphqlProbeResponse): GraphqlBody | null {
  if (response.truncated) return null;
  if (response.contentType.includes("html")) return null;
  const text = response.body.trim();
  if (!text.startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(json)) return null;
  const keys = Object.keys(json);
  if (keys.length === 0 || !keys.every((k) => GRAPHQL_TOP_LEVEL_KEYS.has(k))) return null;
  const hasData = "data" in json;
  const hasErrors = "errors" in json;
  if (!hasData && !hasErrors) return null;

  let data: GraphqlBody["data"];
  if (hasData) {
    if (json.data !== null && !isPlainObject(json.data)) return null;
    data = json.data as GraphqlBody["data"];
  }
  const errors: GraphqlError[] = [];
  if (hasErrors) {
    if (!Array.isArray(json.errors) || json.errors.length === 0) return null;
    for (const e of json.errors) {
      if (!isPlainObject(e) || typeof e.message !== "string") return null;
      errors.push({ message: e.message });
    }
  }
  // `data: null` with no errors says nothing about GraphQL.
  if (!hasErrors && data === null) return null;
  return { data, errors };
}

const TRUNCATED_SCHEMA_PREFIX_RE = /^\s*\{\s*"data"\s*:\s*\{\s*"__schema"\s*:\s*\{\s*"types"\s*:\s*\[/;

/**
 * Type names from the first bytes of an introspection answer that was longer
 * than the cap, or null. The prefix must open exactly as an introspection
 * answer does (`{"data":{"__schema":{"types":[`), so a large page that is not
 * GraphQL is never read as a schema. Only complete `"name":"..."` pairs count,
 * so the result is a lower bound.
 */
export function truncatedSchemaTypeNames(response: GraphqlProbeResponse): string[] | null {
  if (!response.truncated || response.contentType.includes("html")) return null;
  if (!TRUNCATED_SCHEMA_PREFIX_RE.test(response.body)) return null;
  const names: string[] = [];
  for (const m of response.body.matchAll(/"name"\s*:\s*"([^"\\]{1,200})"/g)) names.push(m[1]!);
  return names.length > 0 ? names : null;
}

/** True for a 2xx status. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The first error messages, trimmed, for a check's details. */
export function errorSummary(body: GraphqlBody, max = 2): string[] {
  return body.errors.slice(0, max).map((e) => e.message.slice(0, 200));
}
