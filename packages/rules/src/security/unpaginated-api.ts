// security/unpaginated-api - collection endpoints that return a whole table
//
// A probing rule, like security/unauthenticated-api: it runs only when
// `ctx.probe` allows a quiet probe (active or aggressive) and sends nothing on
// a passive run. Generated CRUD backends often expose `GET /api/<table>` that
// answers every full record in one response, with no page, limit or filter.
//
// Candidates come from the same discovery pass and the same selection as
// unauthenticated-api (`selectApiCandidates`): same origin, GET only, no
// state-changing path, robots.txt respected, at most MAX_API_ENDPOINTS. The
// first GET is the anonymous one that rule sends, so one audit requests the
// endpoint once for both (the answer is shared, sendApiProbe).
//
// An endpoint is a candidate for a finding when the answer is a list of full
// records (objects with at least MIN_RECORD_FIELDS fields) with at least
// MIN_ROWS rows, or at least MIN_BYTES of body and MIN_BYTES_ROWS rows. A body
// longer than the read cap counts as over the size threshold.
//
// It is then not flagged when it shows it paginates: pagination metadata in
// the answer (a next link or cursor, has_more, total pages), a `Link: rel=next`
// header, or a second GET that adds limit and page parameters and gets fewer
// rows back. That second GET is sent only for an endpoint already over the
// threshold, so it costs one request per such endpoint, within the shared
// probe budget. An answer to the second GET that cannot be read leaves the
// endpoint unflagged: the rule never accuses on a guess.
//
// A finding carries the endpoint, the row count and the response size. It never
// carries a record value, a field name or a sample.
//
// Honest limit: a complete lookup table (countries, currencies) is also a whole
// table. The row threshold keeps small ones out; a large one that is meant to
// be complete will be flagged as informational advice to confirm.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";

import type {
  CheckItem,
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
} from "../types";
import type { ApiCandidate, ApiProbeResponse } from "./unauthenticated-api";

import {
  ANONYMOUS_GET_CAP,
  buildAnonymousGet,
  fetchAnonymousGet,
  isThrottledOrChallenged,
  isUnverifiedReply,
} from "./probe-http";
import {
  API_PROBE_TIMEOUT_MS,
  findRecords,
  selectApiCandidates,
  sendApiProbe,
} from "./unauthenticated-api";

/** Rows at which a full-record list counts as a whole table. */
export const MIN_ROWS = 100;
/** Body bytes at which a list counts as large even below MIN_ROWS. */
export const MIN_BYTES = 128 * 1024;
/** Rows needed alongside MIN_BYTES, so one huge record is not a table. */
export const MIN_BYTES_ROWS = 10;
/** Fields a record needs to be a full record rather than an id or a label. */
export const MIN_RECORD_FIELDS = 3;

/** Query parameters the second GET adds; one page of one row under any common name. */
export const PAGING_QUERY =
  "limit=1&per_page=1&page_size=1&pageSize=1&size=1&take=1&top=1&_limit=1&page=1";

export const UNPAGINATED_API_RULE_ID = "security/unpaginated-api";

const CHECK_FLAGGED = "unpaginated-api-list";
const CHECK_CLEAN = "unpaginated-api";
const CHECK_UNCHECKED = "unpaginated-api-unchecked";

// ── pagination evidence ─────────────────────────────────────────────

const PAGINATION_KEYS = new Set([
  "next",
  "nextpage",
  "nextpageurl",
  "nextcursor",
  "nexttoken",
  "nextlink",
  "@odata.nextlink",
  "cursor",
  "endcursor",
  "pageinfo",
  "hasmore",
  "hasnext",
  "hasnextpage",
  "totalpages",
  "pagecount",
  "pagination",
  "paging",
  "perpage",
  "pagesize",
  "page",
  "offset",
  "limit",
]);

// Containers that hold pagination metadata next to the records.
const META_KEYS = new Set(["meta", "links", "_links", "pagination", "paging"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when the parsed body, or its meta and links objects, names a paging field. */
export function hasPaginationMetadata(json: unknown): boolean {
  if (!isObject(json)) return false;
  const has = (o: Record<string, unknown>): boolean =>
    Object.keys(o).some((k) => PAGINATION_KEYS.has(normalizeKey(k)));
  if (has(json)) return true;
  for (const key of Object.keys(json)) {
    if (!META_KEYS.has(key.toLowerCase())) continue;
    const inner = json[key];
    if (isObject(inner) && has(inner)) return true;
  }
  return false;
}

/** True when a `Link` header offers rel="next". */
export function hasNextLinkHeader(headers: Headers | undefined): boolean {
  const link = headers?.get("link");
  return link ? /;\s*rel\s*=\s*"?[^",]{0,64}\bnext\b/i.test(link) : false;
}

// ── reading ─────────────────────────────────────────────────────────

export interface ListReading {
  /** Rows in the list, or null when the body was cut at the read cap. */
  rows: number | null;
  /** Decoded body bytes read. */
  bytes: number;
  truncated: boolean;
  /** The answer shows pagination metadata or a next link. */
  paginated: boolean;
}

function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

/** The record list of a 2xx JSON answer, or null when it is not a list of full records. */
export function readList(response: ApiProbeResponse): ListReading | null {
  if (response.status < 200 || response.status >= 300) return null;
  if (response.contentType.includes("html")) return null;
  const text = response.body.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  const bytes = bodyBytes(response.body);
  const linkNext = hasNextLinkHeader(response.headers);

  if (response.truncated) {
    // Cut at the read cap: the size is over any threshold, and a list of
    // objects shows as an array of objects opening the body or a wrapper key.
    if (
      !/^(?:\[\s*\{|\{\s*"[^"\\]{1,64}"\s*:\s*(?:\[\s*\{|\{\s*"data"|\{))/.test(
        text
      )
    )
      return null;
    return { rows: null, bytes, truncated: true, paginated: linkNext };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const set = findRecords(json);
  if (!set || set.count < 2) return null;
  const first = set.records[0];
  if (!first || Object.keys(first).length < MIN_RECORD_FIELDS) return null;
  return {
    rows: set.count,
    bytes,
    truncated: false,
    paginated: linkNext || hasPaginationMetadata(json),
  };
}

/** True when a list is over the row or size threshold. */
export function overThreshold(r: ListReading): boolean {
  if (r.truncated) return r.bytes >= MIN_BYTES;
  const rows = r.rows ?? 0;
  return rows >= MIN_ROWS || (r.bytes >= MIN_BYTES && rows >= MIN_BYTES_ROWS);
}

/** The URL of the second GET: the endpoint plus the paging parameters. */
export function pagedUrl(endpointUrl: string): string {
  const { url } = buildAnonymousGet(endpointUrl);
  return `${url}?${PAGING_QUERY}`;
}

/**
 * True when the answer to the paged GET has fewer rows than the first answer,
 * so the endpoint honours a page size. Null when the answer cannot say.
 */
export function honoursPaging(
  first: ListReading,
  paged: ApiProbeResponse
): boolean | null {
  if (paged.status >= 500) return null;
  if (paged.status < 200 || paged.status >= 300) return null;
  const reading = readList(paged);
  if (!reading) {
    // A 2xx JSON answer that is no longer a list of records (one row of a
    // two-field shape, an empty list) still shrank.
    return paged.body.trim().startsWith("[") ||
      paged.body.trim().startsWith("{")
      ? paged.body.length < first.bytes / 2
      : null;
  }
  if (reading.truncated) return false;
  return (reading.rows ?? 0) < (first.rows ?? MIN_ROWS);
}

// ── the rule ────────────────────────────────────────────────────────

interface Flagged {
  candidate: ApiCandidate;
  reading: ListReading;
  status: number;
}

function sizeText(bytes: number, truncated: boolean): string {
  const kb = Math.round(bytes / 1024);
  return truncated ? `at least ${kb} KB` : `${Math.max(1, kb)} KB`;
}

function itemFor(f: Flagged): CheckItem {
  const { candidate, reading } = f;
  const rows =
    reading.rows === null
      ? "an unknown number of rows"
      : `${reading.rows} rows`;
  return {
    id: candidate.url,
    label: `GET ${candidate.url}: ${rows}, ${sizeText(reading.bytes, reading.truncated)}, no pagination`,
    meta: {
      method: "GET",
      status: f.status,
      rows: reading.rows,
      bytes: reading.bytes,
      ...(reading.truncated ? { truncated: true, confidence: "lower" } : {}),
      source: candidate.source,
      discoveredVia: candidate.discoveredVia,
    },
  };
}

async function sendPagedGet(
  ctx: RuleContext,
  endpointUrl: string
): Promise<ApiProbeResponse | "not-sent" | "error"> {
  const probe = ctx.probe;
  if (!probe?.allows("quiet")) return "not-sent";
  probe.record();
  const { init } = buildAnonymousGet(endpointUrl);
  const outcome = await fetchAnonymousGet(
    pagedUrl(endpointUrl),
    init,
    probe.signal()
  );
  if (!outcome.sent || "error" in outcome) return "error";
  return outcome.response;
}

export const unpaginatedApiRule: Rule = {
  meta: {
    id: UNPAGINATED_API_RULE_ID,
    name: "Unpaginated API Endpoints",
    description:
      "Probes the site's own collection endpoints with one anonymous GET and flags a list of full records over a row or size threshold that shows no pagination and ignores limit and page parameters. Reports row count and response size, never record values. Runs only when probing is active or aggressive.",
    solution:
      "Paginate every collection endpoint: accept limit and page (or cursor) parameters, cap the page size on the server, and return a next link or cursor. Add filters so a client asks for the rows it needs. Returning a whole table in one response slows the page, wastes bandwidth and exposes every record to anyone who calls the route. If the list is a small fixed lookup table meant to be complete, you can ignore this finding.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 3,
    checks: [
      { name: CHECK_FLAGGED, outcome: "problem" },
      { name: CHECK_CLEAN, outcome: "clean", clears: [CHECK_FLAGGED] },
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
          "Probing is passive, so no API endpoint was probed. Run with --probe active to check for unpaginated API endpoints.",
      });
      return { checks };
    }

    const selection = selectApiCandidates(ctx);
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason: "no-endpoints",
        message:
          "Not checked: no API endpoints found in page code (no same-origin API endpoint that may be read with a GET), so nothing was probed",
      });
      return { checks };
    }

    let probed = 0;
    let unverified = 0;
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
        unverified++;
        continue;
      }
      const { response } = outcome;
      const reply = {
        status: response.status,
        headers: response.headers,
        text: response.body,
      };
      if (isThrottledOrChallenged(reply)) {
        pushback = true;
        unverified++;
        break;
      }
      if (isUnverifiedReply(reply)) {
        unverified++;
        continue;
      }
      const reading = readList(response);
      if (!reading || reading.paginated || !overThreshold(reading)) continue;

      // Over the threshold with no metadata: does it honour a page size?
      const paged = await sendPagedGet(ctx, candidate.url);
      if (paged === "not-sent") {
        budgetStopped = true;
        unverified++;
        break;
      }
      if (paged === "error") {
        unverified++;
        continue;
      }
      if (
        isThrottledOrChallenged({
          status: paged.status,
          headers: paged.headers,
          text: paged.body,
        })
      ) {
        pushback = true;
        unverified++;
        break;
      }
      if (honoursPaging(reading, paged) !== false) {
        // Honoured, or the answer cannot say: not flagged either way.
        if (honoursPaging(reading, paged) === null) unverified++;
        continue;
      }
      flagged.push({ candidate, reading, status: response.status });
    }

    if (probed === 0) {
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any API endpoint was probed",
      });
      return { checks };
    }

    if (flagged.length > 0) {
      const items = flagged.map(itemFor);
      checks.push({
        name: CHECK_FLAGGED,
        status: "warn",
        message: `${items.length} API endpoint(s) return a whole table in one response with no pagination, for example ${items[0]!.id}`,
        items,
        details: { endpoints: items.length, probed },
      });
    }

    if (unverified > 0) {
      const why: string[] = [];
      if (pushback)
        why.push(
          "the site throttled the probes or answered with a bot challenge"
        );
      if (budgetStopped) why.push("the probe budget ran out");
      if (why.length === 0)
        why.push(
          "some answers failed, were server errors or could not be read"
        );
      checks.push({
        name: CHECK_UNCHECKED,
        status: "skipped",
        skipReason:
          budgetStopped && !pushback
            ? "probe-budget"
            : PROBE_INCOMPLETE_SKIP_REASON,
        message: `Unpaginated API check incomplete: ${why.join("; ")}. ${unverified} API endpoint(s) were not fully checked`,
        value: "not-checked",
        details: {
          probed,
          unverified,
          timeoutMs: API_PROBE_TIMEOUT_MS,
          cap: ANONYMOUS_GET_CAP,
        },
      });
    } else if (flagged.length === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "pass",
        message: `No API endpoint returned a whole table without pagination (${probed} endpoint(s) probed)`,
        details: { probed },
      });
    }
    return { checks };
  },
};
