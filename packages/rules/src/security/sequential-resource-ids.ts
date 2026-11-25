// security/sequential-resource-ids - predictable sequential ids in API endpoints (advisory)
//
// Endpoints keyed by a small integer (`/api/orders/1`, `/api/orders/2`) make an
// insecure direct object reference (IDOR) easy to exploit when the server's
// authorization check is weak: an attacker only has to count.
//
// Passive. It reads the endpoint discovery pass (`ctx.endpointSurface`), the
// URLs already found in the site's own pages and scripts, and sends no request
// at all: not with `--probe active`, not with any other level. It never
// enumerates ids and never tries a second account. Because it reads no response
// bodies, it cannot see an `id` field inside JSON; it judges the URL alone.
//
// What counts. A same-origin endpoint that looks like an API (an `api`, `rest`,
// `v1`-style or `.json` path, or a call found in script rather than a plain
// link) whose path has a small-integer segment after a collection word
// (`/orders/42`), or whose query string has an id-named key with a small
// integer (`?user_id=7`). Small means 1 to 6 digits without a leading zero.
// UUIDs, ULIDs, hashes, slugs and other opaque ids are never flagged, nor are
// page numbers, versions, years and other counters (`/page/2`, `/v1`).
//
// This is an advisory about a pattern, not a vulnerability: whether the server
// checks ownership is invisible to an unauthenticated crawl.

import type { EndpointCandidate } from "../endpoint-surface";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const CHECK = "sequential-resource-ids";

/** Findings listed per run; the rest are counted. */
export const MAX_SEQUENTIAL_ID_FINDINGS = 20;

const MAX_SEGMENT_LENGTH = 256;
const MAX_PATH_SEGMENTS = 32;
const MAX_QUERY_PARAMS = 32;

// A small integer: 1 to 6 digits, no leading zero (`0` alone excluded).
const SMALL_INT = /^[1-9]\d{0,5}$/;

// Collection words that precede a counter, not a resource id.
const COUNTER_WORDS = new Set([
  "page",
  "pages",
  "p",
  "v",
  "version",
  "versions",
  "limit",
  "offset",
  "size",
  "step",
  "year",
  "years",
  "month",
  "months",
  "day",
  "days",
  "week",
  "weeks",
  "port",
  "width",
  "height",
  "w",
  "h",
  "zoom",
  "tile",
  "tiles",
  "rev",
  "revision",
  "build",
]);

const API_WORDS = new Set(["api", "rest", "rpc", "json", "ajax", "services"]);

// Query keys that name a record id (`id`, `userId`, `order_id`, `uid`).
// Case-sensitive on purpose: a lowercase word ending in "id" (`paid`, `valid`,
// `grid`) is not an id key, so a bare suffix needs a separator or a capital I.
const ID_KEY =
  /^(?:id|uid|ID|UID|[a-z][a-z0-9]{0,31}[-_](?:id|ID)|[A-Z][A-Z0-9]{0,31}_ID|[a-z][a-z0-9]{0,31}I[dD])$/;

// Link-like discovery; a navigation link to `/blog/3` is a page, not an API.
const LINK_VIA = new Set(["link-href", "script-src", "form-action"]);

// Head links and script URLs are never a call, even on an API-looking path:
// WordPress puts a public `wp-json/wp/v2/posts/<id>` alternate link in every post.
const ALWAYS_SKIP_VIA = new Set(["link-href", "script-src"]);

// Cursor and pagination keys page through results; they name no record.
const CURSOR_KEYS = new Set([
  "maxid",
  "sinceid",
  "minid",
  "startid",
  "afterid",
  "beforeid",
  "lastid",
  "cursorid",
  "max_id",
  "since_id",
  "min_id",
  "start_id",
  "after_id",
  "before_id",
  "last_id",
  "cursor_id",
]);

export interface SequentialIdHit {
  url: string;
  /** Path with the id replaced by `{id}` so one pattern groups its endpoints. */
  pattern: string;
  /** The id value as a string (digits only). */
  id: string;
  where: "path" | "query";
  discoveredVia: string;
}

function looksLikeApiPath(segments: string[]): boolean {
  for (const seg of segments) {
    const s = seg.toLowerCase();
    if (API_WORDS.has(s) || /^v\d{1,3}$/.test(s)) return true;
  }
  const last = segments.at(-1)?.toLowerCase() ?? "";
  return last.endsWith(".json");
}

/** The sequential-id hit for one candidate, or null. Pure. */
export function findSequentialId(
  c: EndpointCandidate,
  baseUrl: string
): SequentialIdHit | null {
  if (!c.sameOrigin) return null;
  let u: URL;
  try {
    u = new URL(c.url, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;

  // Raw segments, not decoded: a `%2F` stays inside one segment.
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  const apiPath = looksLikeApiPath(segments);
  // A plain link is a page unless its path says API; script, render and
  // convention discoveries are calls.
  if (ALWAYS_SKIP_VIA.has(c.discoveredVia)) return null;
  if (!apiPath && LINK_VIA.has(c.discoveredVia)) return null;
  if (!apiPath && c.source === "static-html") return null;

  for (let i = 1; i < segments.length; i++) {
    const raw = segments[i]!;
    if (raw.length > MAX_SEGMENT_LENGTH) continue;
    const isJson = raw.toLowerCase().endsWith(".json");
    const seg = isJson ? raw.slice(0, -5) : raw;
    if (!SMALL_INT.test(seg)) continue;
    const prev = segments[i - 1]!.toLowerCase();
    if (API_WORDS.has(prev)) continue;
    if (COUNTER_WORDS.has(prev) || /^v\d{1,3}$/.test(prev)) continue;
    // The collection word must be a word, not another number or an id.
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(prev)) continue;
    const pattern = `/${[...segments.slice(0, i), isJson ? "{id}.json" : "{id}", ...segments.slice(i + 1)].join("/")}`;
    return {
      url: u.origin + u.pathname,
      pattern,
      id: seg,
      where: "path",
      discoveredVia: c.discoveredVia,
    };
  }

  if (!apiPath) return null;
  let n = 0;
  for (const [key, value] of u.searchParams) {
    if (++n > MAX_QUERY_PARAMS) break;
    if (key.length > 64 || !ID_KEY.test(key) ||
      CURSOR_KEYS.has(key.toLowerCase()) || !SMALL_INT.test(value))
      continue;
    return {
      url: `${u.origin}${u.pathname}?${key}=${value}`,
      pattern: `${u.pathname}?${key}={id}`,
      id: value,
      where: "query",
      discoveredVia: c.discoveredVia,
    };
  }
  return null;
}

const LIMIT_NOTE =
  "This is an advisory about a predictable pattern, not a confirmed vulnerability: an unauthenticated crawl cannot show whether one signed-in user can read another's record.";

export const sequentialResourceIdsRule: Rule = {
  meta: {
    id: "security/sequential-resource-ids",
    name: "Sequential Resource IDs",
    description:
      "Advisory. Finds API endpoints in the site's own pages and scripts that are keyed by a small integer (such as /api/orders/42), a pattern that makes insecure direct object reference (IDOR) easy to exploit when authorization is weak. Reads discovered URLs only and sends no request. UUIDs and other opaque ids are not flagged.",
    solution:
      "Check on the server that the signed-in caller owns or may read the record behind every id, on every route that takes one (answer 403 or 404 otherwise). If ids are exposed to clients, prefer opaque identifiers (UUIDv4, ULID or a random public id) over auto-increment keys, but treat that as defence in depth: it does not replace the ownership check. Then test with two accounts that user A cannot read user B's record by changing the id.",
    category: "security",
    scope: "site",
    findingScope: "resource",
    severity: "info",
    weight: 3,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const candidates = ctx.endpointSurface?.candidates;
    const baseUrl = ctx.site?.baseUrl;
    if (!candidates || candidates.length === 0 || !baseUrl)
      return { checks: [] };

    // One finding per path pattern, so /api/orders/1 and /api/orders/2 are one.
    const groups = new Map<string, { hits: SequentialIdHit[] }>();
    for (const c of candidates) {
      const hit = findSequentialId(c, baseUrl);
      if (!hit) continue;
      const key = JSON.stringify([new URL(hit.url).origin, hit.pattern]);
      const g = groups.get(key) ?? { hits: [] };
      if (!g.hits.some((h) => h.url === hit.url)) g.hits.push(hit);
      groups.set(key, g);
    }

    const checks: CheckResult[] = [];
    if (groups.size === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message:
          "No discovered API endpoint is keyed by a small sequential integer id",
      });
      return { checks };
    }

    let listed = 0;
    for (const { hits } of groups.values()) {
      if (listed >= MAX_SEQUENTIAL_ID_FINDINGS) break;
      listed++;
      const first = hits[0]!;
      const ids = hits.map((h) => h.id).slice(0, 5);
      const seen =
        hits.length > 1
          ? `${hits.length} ids seen (${ids.join(", ")}${hits.length > ids.length ? ", ..." : ""})`
          : `id ${first.id} seen`;
      const origin = new URL(first.url).origin;
      checks.push({
        name: CHECK,
        status: "warn",
        message: `${origin}${first.pattern} takes a small integer id (${seen}). Sequential ids are easy to guess, so this endpoint is IDOR-prone if the server does not check ownership. ${LIMIT_NOTE}`,
        items: hits.slice(0, 10).map((h) => ({
          id: h.url,
          label: h.url,
          meta: {
            pattern: h.pattern,
            location: h.where,
            discoveredVia: h.discoveredVia,
          },
        })),
        details: {
          pattern: `${origin}${first.pattern}`,
          endpoints: hits.length,
          advisory: true,
        },
      });
    }
    const omitted = groups.size - listed;
    if (omitted > 0 && checks.length > 0) {
      const last = checks[checks.length - 1]!;
      last.details = { ...last.details, omittedPatterns: omitted };
    }
    return { checks };
  },
};
