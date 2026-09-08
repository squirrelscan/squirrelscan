// Per-page rule-result cache (#1990) — what makes a re-audit of an unchanged
// page cheap.
//
// THE PROBLEM. Crawl reuse already skips the fetch: a second audit of an
// unchanged 2,500-page site fetches nothing (`pagesFetched: 0`) and is 11% faster,
// all of it crawl. Parse, page rules, the page-time collectors and the report are
// paid again in full on every page, so the saving is capped at the crawl's share
// of the run — 9-14% against a local origin. This module removes the rest: a page
// whose inputs are byte-for-byte what they were last time replays its stored
// verdicts and is never parsed.
//
// WHAT MAKES IT SOUND. Replay asserts that re-running the page rules would
// produce exactly what is stored, so the key has to cover every input those rules
// read. There are four groups, and each one is here for a reason:
//
//  1. **The page's exact bytes** — `PageRecord.htmlHash`, NOT `contentHash`.
//     `contentHash` is whitespace-NORMALIZED (`computeNormalizedContentHash`) so
//     the incremental crawler can call a reformatted page unchanged; two pages
//     that differ only in whitespace share it and parse to different word counts,
//     inline-script lengths and `<pre>` text. Keying on it would replay one page's
//     verdicts onto another's markup. A page with no `htmlHash` never caches.
//  2. **Everything else on the page record the rules or `extractPageFeatures`
//     read** — url, final url, status, depth, size, the response + security
//     headers (`buildHeadersMap`), the redirect chain, the fetcher id (which is
//     how `rendered` is decided, so the render mode is covered), and the three
//     timings, because `performance/ttfb` reads `page.ttfb` and
//     `page.downloadTime`. Timings are why replay pays off on a REUSED page and
//     not on a re-fetched one: a genuine re-fetch of identical bytes gets new
//     timings, a different key, and runs its rules again. That is the conservative
//     answer, and it is the case crawl reuse already avoids.
//  3. **The page's soft-404 confirmation**, which the site-fetch phase computes
//     per page (it can hit the network) and threads onto `parsed` before the rules
//     run.
//  4. **The run context** — {@link computeRunContextHash}: the engine build (the
//     CLI's release version, because the `@squirrelscan/rules` package version
//     never moves), the enabled page rules IN ORDER with their resolved options,
//     the Stage-0 site metadata, the prefetched cloud results, and the three
//     `SiteData` fields page rules actually read.
//
// WHAT IS GATED OUT RATHER THAN APPROXIMATED. Two run-level inputs cannot be
// reduced to a hash, so their presence turns the cache OFF for the whole run
// instead of being ignored:
//
//  - **Threat intel** (`ctx.intel`). `IntelContext` is `lookupUrl` +
//    `matchSignatures` over feeds that refresh daily behind a memoized handle.
//    Its `providers` + `signatureCount` are an identity of the CONFIGURATION, not
//    of the verdicts, so a feed that changed overnight would replay yesterday's
//    answer under an unchanged key. There is no cheap exact identity available, so
//    an intel-enabled run does not replay.
//  - **A `SiteData` field no page rule reads today.** The three that ARE read
//    (`baseUrl`, `scripts`, `resourceSizes`) are hashed, and within the last two
//    only the ENTRY fields rules read — see {@link PAGE_RULE_SCRIPT_FIELDS} and
//    {@link PAGE_RULE_RESOURCE_FIELDS}. Hashing whole entries looked safer and was
//    not: `cacheReason` is null on a cold run and set on a warm one, so it made
//    the run context differ between exactly the two runs meant to match, and the
//    cache silently returned nothing. `pages` is excluded outright, because it
//    holds every page's scalars and hashing it would make any single page's change
//    invalidate the whole site — precisely the case this feature exists for.
//    All of that is a claim about the rule set, so it is a DECLARATION with a
//    falsifier: `page-rule-site-context.test.ts` hands the page-rule pass a proxied
//    `SiteData`, down to the individual script and resource entries, and fails on
//    any read outside the declared sets.
//
// TEMPLATE FAN-OUT (#1951) DOES NOT COMPOSE WITH THIS, and the cache wins: a run
// with a cache does not build a fan-out at all (see streaming.ts). A fanned
// verdict belongs to the page's CLUSTER, so no per-page key can capture what it
// depends on — change a cluster's representative and its members' cached verdicts
// are stale with nothing about those members having changed. Two designs were
// tried and rejected before this one; the reasoning is in streaming.ts, and making
// them compose means caching the cluster's verdict against its representative's
// identity, which is a whole-crawl property rather than a per-page one.

import type { CheckResult, PageFeatureRow, PageRecord } from "@squirrelscan/core-contracts";
import type { ParsedPage, RuleMeta, SiteData } from "@squirrelscan/rules";

/** Bumped when the payload shape or the key's ingredients change; old rows then miss. */
export const RULE_CACHE_FORMAT = "prc-1";

/**
 * The `SiteData` keys page-scope rules read, and therefore the only ones the run
 * context hashes.
 *
 * Derived by inspection (`content/dev-leakage` reads `baseUrl`;
 * `integrity/kit-signature`, `performance/js-libraries`, `performance/source-maps`
 * and `performance/unminified-js` read `scripts`; `performance/unminified-css`
 * reads `resourceSizes`) and held there by `page-rule-site-context.test.ts`, which
 * fails on any other key being read. Widening this list is safe; forgetting to
 * widen it when a rule starts reading another field is what the test exists to
 * catch, because the cost of that mistake is a stale verdict, not a crash.
 */
export const PAGE_RULE_SITE_FIELDS = ["baseUrl", "scripts", "resourceSizes"] as const;

/**
 * The fields of a `ctx.site.scripts` entry page rules read.
 *
 * The rest of `ScriptContentData` is not hashed, and one of them is why this list
 * exists rather than hashing the whole entry: `contentEncoding` is documented as
 * `undefined` on a content-store cache hit, so it says how THIS run obtained the
 * script, not what the script is. Hashing it would move the key on the second
 * audit of an unchanged site and hand back zero reuse — the exact failure this
 * feature exists to fix, arriving silently as "the cache does nothing".
 */
export const PAGE_RULE_SCRIPT_FIELDS = [
  "url",
  "finalUrl",
  "sizeBytes",
  "content",
  "sourceMapHeader",
  "sourcePages",
] as const;

/**
 * The fields of a `ctx.site.resourceSizes` entry page rules read
 * (`performance/unminified-css` reads url + size; nothing page-scoped reads more).
 *
 * `cacheReason` is the field that forced this: "cache-hit reason if reused from a
 * prior crawl; null on a real fetch". It is null on every cold run and set on
 * every warm one, so hashing the whole entry made the run context differ between
 * exactly the two runs that are supposed to match.
 */
export const PAGE_RULE_RESOURCE_FIELDS = ["url", "sizeBytes"] as const;

/** Keep only `fields`, in a fixed order, from each entry of `entries`. */
function projectEntries(
  entries: unknown,
  fields: readonly string[]
): Array<Array<unknown>> | null {
  if (!Array.isArray(entries)) return null;
  return entries.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return fields.map((field) => record[field]);
  });
}

/**
 * The site context a page rule can see, reduced to what it can actually READ.
 *
 * Array ORDER is preserved rather than sorted: a rule iterates these arrays, so
 * order is potentially observable in its output. If it ever churned between runs
 * the key would churn with it and the run would lose its reuse — conservative,
 * and never a stale verdict.
 */
export function pageRuleSiteContext(siteData: SiteData): Record<string, unknown> {
  const resourceSizes = siteData.resourceSizes;
  return {
    baseUrl: siteData.baseUrl,
    scripts: projectEntries(siteData.scripts, PAGE_RULE_SCRIPT_FIELDS),
    resourceSizes: resourceSizes
      ? {
          css: projectEntries(resourceSizes.css, PAGE_RULE_RESOURCE_FIELDS),
          images: projectEntries(resourceSizes.images, PAGE_RULE_RESOURCE_FIELDS),
        }
      : null,
  };
}

/** One page's cached rules-phase output, exactly as the streamed loop produced it. */
export interface PageRuleCacheEntry {
  /**
   * `[ruleId, checks]` in the order the runner emitted them, which is enabled-rule
   * order. The flat `pageResults` list is the concatenation, so it is rebuilt
   * rather than stored twice. `RuleRunResult.meta` is per-RULE and comes from the
   * live registry, never from the cache — a stale `meta` would be a different bug.
   */
  readonly ruleResults: ReadonlyArray<readonly [string, CheckResult[]]>;
  /** What `extractPageFeatures` returned, replayed via `upsertPageFeatures`. */
  readonly features: PageFeatureRow;
  /** Per-collector snapshot: collector id -> whatever its `collect` returned. */
  readonly signals: Readonly<Record<string, unknown>>;
}

/**
 * Why a run is not replaying anything, when a cache WAS available.
 *
 * These two are the engine's; a caller may report its own reason (the CLI reports
 * `refresh-requested` and `disabled-by-env`), which is why the report field is a
 * plain string rather than this union.
 */
export type RuleCacheDisabledReason = "threat-intel-enabled" | "unhashable-run-context";

// ============================================
// HASHING
// ============================================

/**
 * SHA-256 of a string, hex. `crypto.subtle` rather than `node:crypto` because
 * this package is deliberately Worker-clean — it has no `node:` imports and the
 * cloud audit path bundles it.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Deterministic JSON for hashing: object keys sorted, `undefined` distinguished
 * from absent, `Map`/`Set` given an explicit form, and anything that is not plain
 * data (a function, a symbol, a class instance, a cycle) THROWN on rather than
 * silently serialized to `{}`.
 *
 * Throwing is the whole point. A run context that quietly hashed a live handle to
 * `{}` would give two genuinely different runs the same key and replay the wrong
 * verdicts; the callers turn a throw into "no cache this run", which costs time
 * and never correctness.
 */
export function canonicalJson(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === undefined) return "u";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    // Distinct forms, not one "not finite" bucket: NaN, Infinity and -Infinity are
    // three different rule-option values and must not share a key.
    // `Object.is` distinguishes -0 from 0 and `JSON.stringify` does not, so the
    // sign is spelled out rather than lost.
    if (Number.isFinite(value as number)) {
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    }
    return Number.isNaN(value as number) ? "nan" : (value as number) > 0 ? "inf" : "-inf";
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "bigint") return `bi:${(value as bigint).toString()}`;
  if (t === "function" || t === "symbol") {
    throw new TypeError(`canonicalJson: cannot hash a ${t}`);
  }
  if (seen.has(value)) throw new TypeError("canonicalJson: cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // LENGTH-prefixed, and a HOLE is its own token: `.map` skips holes, so
      // `new Array(1)` and `[]` would otherwise canonicalize the same, and a hole
      // is observable (`0 in arr`) so it is not `undefined` either.
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        items.push(i in value ? canonicalJson(value[i], seen) : "h");
      }
      return `[${value.length}|${items.join(",")}]`;
    }
    if (value instanceof Set) {
      // Insertion order preserved: it is observable through iteration, so two Sets
      // holding the same members in a different order are not interchangeable.
      return `S[${[...value].map((v) => canonicalJson(v, seen)).join(",")}]`;
    }
    if (value instanceof Map) {
      return `M[${[...value].map(([k, v]) => `${canonicalJson(k, seen)}:${canonicalJson(v, seen)}`).join(",")}]`;
    }
    if (value instanceof Date) return `D:${value.getTime()}`;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: not plain data (${proto?.constructor?.name ?? "?"})`);
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], seen)}`)
      .join(",");
    return `{${body}}`;
  } finally {
    seen.delete(value);
  }
}

// ============================================
// KEYS
// ============================================

/** Everything outside a single page that a page rule's verdict can depend on. */
export interface RunContextInput {
  /**
   * The build the rules came from. It must change whenever any rule's CODE can
   * have changed, which the `@squirrelscan/rules` package version does not: it has
   * sat at 0.0.1 since the repo began and is never bumped, so keying on it would
   * happily replay pre-upgrade verdicts after a `squirrel self update`. The CLI
   * passes its release version, which is what actually moves.
   */
  readonly engineVersion: string;
  /** The enabled PAGE rules, in execution order, with their resolved options. */
  readonly pageRules: ReadonlyArray<{ id: string; options: unknown }>;
  /** The site data handed to page rules; only {@link PAGE_RULE_SITE_FIELDS} is read. */
  readonly siteData: SiteData;
  /** `RunnerScope.siteMetadata` — drives `appliesWhen` gating and `ctx.siteMetadata`. */
  readonly siteMetadata: unknown;
  /** `RunnerScope.cloudResults` — plain `Map<service, Map<key, envelope>>`. */
  readonly cloudResults: unknown;
  /**
   * `rules.ignore_applicability` — the escape hatch that makes every enabled rule
   * run regardless of the Stage-0 profile. It changes a rule's output from a
   * `skipped` check to its real verdict WITHOUT changing the rule list or any
   * rule's options, so it has to be here or flipping it replays the skips.
   */
  readonly ignoreApplicability: boolean;
  /**
   * The current UTC year. `content/stale-copyright` is the only PAGE rule that
   * reads a clock (`new Date().getUTCFullYear()`), so this is the exact
   * granularity the cache has to invalidate on: a pass cached on 31 December must
   * not replay on 1 January. Year and not day, because a day would make every
   * re-audit after midnight cold for nothing.
   *
   * It is resolved once, before the pages run, so an audit that STRADDLES midnight
   * on 31 December stores the new year's verdicts under the old year's key. Those
   * rows are then unreachable — the next audit resolves the new year and misses
   * every one of them — so the cost is one run's writes, once a year, and never a
   * stale verdict served. The straddle itself is not new: a fresh audit crossing
   * midnight already gives its earlier and later pages different verdicts.
   */
  readonly utcYear: number;
  /**
   * The runtime's IANA time zone. `content/date-agreement` resolves a schema date
   * through `Date.parse`, which reads a bare "01/01/2026 00:30:00" in LOCAL time,
   * so the same page yields a different year under `UTC` and under
   * `Australia/Sydney`. A laptop that moved, or a CI runner that does not match the
   * machine that filled the cache, is otherwise an unchanged key over a changed
   * answer.
   */
  readonly timeZone: string;
}

/**
 * One hash standing for every non-page input, or a reason the run cannot cache.
 *
 * `pages` is excluded from the site-data projection on purpose; see the header.
 */
export async function computeRunContextHash(
  input: RunContextInput
): Promise<{ hash: string } | { disabled: RuleCacheDisabledReason }> {
  try {
    const projection = pageRuleSiteContext(input.siteData);
    const canonical = canonicalJson([
      RULE_CACHE_FORMAT,
      input.engineVersion,
      input.pageRules.map((r) => [r.id, r.options]),
      projection,
      input.siteMetadata ?? null,
      input.cloudResults ?? null,
      input.ignoreApplicability,
      input.utcYear,
      input.timeZone,
    ]);
    // A cache that quietly stops hitting looks exactly like a cache that is
    // working, so the one question worth answering cheaply is "which ingredient
    // moved?". `SQUIRREL_RULE_CACHE_DEBUG=1` prints a digest per ingredient; run
    // two audits and compare. It found the defect this projection exists for —
    // `cacheReason`, null on a cold run and set on a warm one, was moving the
    // whole run context and every page was missing.
    if (process.env.SQUIRREL_RULE_CACHE_DEBUG === "1") {
      const parts: Array<[string, unknown]> = [
        ["engineVersion", input.engineVersion],
        ["pageRules", input.pageRules.map((r) => [r.id, r.options])],
        ["baseUrl", projection.baseUrl],
        ["scripts", projection.scripts],
        ["resourceSizes", projection.resourceSizes],
        ["siteMetadata", input.siteMetadata ?? null],
        ["cloudResults", input.cloudResults ?? null],
        ["ignoreApplicability", input.ignoreApplicability],
        ["utcYear", input.utcYear],
        ["timeZone", input.timeZone],
      ];
      for (const [name, value] of parts) {
        const digest = (await sha256Hex(canonicalJson(value))).slice(0, 16);
        console.error(`[rule-cache] run-context ${name} = ${digest}`);
      }
    }
    return { hash: await sha256Hex(canonical) };
  } catch {
    return { disabled: "unhashable-run-context" };
  }
}

/**
 * The cache key for one page under a run context, or null when the page cannot
 * participate (no exact HTML hash — see {@link PageRecord.htmlHash}).
 *
 * The page's own url is one of the hashed inputs, so the key identifies an entry
 * on its own: two different urls serving identical bytes get different keys, and a
 * replay can never attribute one page's findings to another.
 */
export async function computePageCacheKey(
  runContextHash: string,
  page: PageRecord,
  soft404Confirmation: ParsedPage["soft404Confirmation"] | undefined
): Promise<string | null> {
  if (!page.htmlHash) return null;
  const canonical = canonicalJson([
    RULE_CACHE_FORMAT,
    runContextHash,
    page.htmlHash,
    // The NORMALIZED hash too, because `extractPageFeatures` copies it verbatim
    // into `page_features.content_hash`, where the duplicate-content grouping
    // reads it. Implied by the exact hash for anything the crawler wrote, but a
    // record whose normalized hash was written independently is not the crawler's
    // to imply.
    page.contentHash,
    // The stored parse, which `buildSiteContext` PREFERS over re-extracting from
    // the HTML. For a crawler-written record it is a pure function of the HTML and
    // the parser, both already covered — but a record whose parsed data was
    // repaired or imported separately would otherwise replay the old parse's
    // verdicts under an unchanged key.
    page.parsedData,
    page.url,
    page.normalizedUrl,
    page.finalUrl,
    page.depth,
    page.status,
    page.contentType,
    page.sizeBytes,
    page.loadTimeMs,
    page.ttfb ?? null,
    page.downloadTime ?? null,
    page.headers,
    page.securityHeaders,
    page.redirectChain ?? null,
    page.fetcherId ?? null,
    soft404Confirmation ?? null,
  ]);
  return sha256Hex(canonical);
}

// ============================================
// PAYLOAD CODEC
// ============================================
//
// JSON cannot round-trip the payload as-is: `PageFingerprint` (inside the
// collected page signal) holds four `Set<string>`, and `JSON.stringify` turns a
// Set into `{}`. Tagging is generic rather than a hand-written per-field codec so
// a Set added to any of these shapes later keeps working instead of silently
// decoding as an empty object — the failure mode a bespoke codec would have.

interface TaggedSet {
  $s: unknown[];
}
interface TaggedMap {
  $m: Array<[unknown, unknown]>;
}
interface TaggedUndefined {
  $u: 1;
}
interface TaggedEscape {
  $e: Record<string, unknown>;
}
interface TaggedDate {
  $d: number | null;
}

function isTagged(value: object): boolean {
  for (const key of Object.keys(value)) if (key.startsWith("$")) return true;
  return false;
}

/** Encode a data graph to something `JSON.stringify` round-trips exactly. */
export function encodeCacheValue(value: unknown): unknown {
  if (value === undefined) return { $u: 1 } satisfies TaggedUndefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(encodeCacheValue);
  if (value instanceof Set) return { $s: [...value].map(encodeCacheValue) } satisfies TaggedSet;
  if (value instanceof Map) {
    return {
      $m: [...value].map(([k, v]) => [encodeCacheValue(k), encodeCacheValue(v)]),
    } satisfies TaggedMap;
  }
  // A Date reaches `JSON.stringify` as an ISO string on a fresh run; walked as a
  // plain object it has no own keys and would come back `{}`. No built-in rule
  // puts one in `check.details` today, but the field's type permits it.
  // An INVALID date serializes to `null` through `JSON.stringify`, so `$d` carries
  // null for it rather than a NaN that decodes to the epoch.
  if (value instanceof Date) {
    const time = value.getTime();
    return { $d: Number.isNaN(time) ? null : time } satisfies TaggedDate;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) setOwn(out, k, encodeCacheValue(v));
  // A plain object whose own keys start with "$" would decode as a tag; wrap it.
  return isTagged(out) ? ({ $e: out } satisfies TaggedEscape) : out;
}

/** Inverse of {@link encodeCacheValue}. */
export function decodeCacheValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeCacheValue);
  const obj = value as Record<string, unknown>;
  if ("$u" in obj) return undefined;
  if ("$s" in obj) return new Set((obj.$s as unknown[]).map(decodeCacheValue));
  if ("$m" in obj) {
    return new Map(
      (obj.$m as Array<[unknown, unknown]>).map(([k, v]) => [decodeCacheValue(k), decodeCacheValue(v)])
    );
  }
  // An escaped object's OWN keys start with "$", so its values must be decoded
  // without running the tag checks over it again — recursing into
  // decodeCacheValue here would read `{"$u": "text"}` as the undefined tag and
  // return undefined for the whole object.
  if ("$d" in obj) return obj.$d === null ? new Date(NaN) : new Date(obj.$d as number);
  if ("$e" in obj) return decodePlainObject(obj.$e as Record<string, unknown>);
  return decodePlainObject(obj);
}

function decodePlainObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) setOwn(out, k, decodeCacheValue(v));
  return out;
}

/**
 * Assign an OWN property, even when the key is `__proto__`.
 *
 * `JSON.parse` produces `__proto__` as an ordinary own key, but `out[k] = v`
 * routes it to the prototype setter and the key vanishes. A rule is free to put
 * one in `check.details`, and losing it would make the replayed report differ from
 * the fresh one in a way no round-trip written with `=` can see.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Serialize one entry for storage. */
export function encodePageRuleCacheEntry(entry: PageRuleCacheEntry): string {
  return JSON.stringify(encodeCacheValue(entry));
}

/** Parse one stored entry, or null when it cannot be read (treated as a miss). */
export function decodePageRuleCacheEntry(payload: string): PageRuleCacheEntry | null {
  try {
    const decoded = decodeCacheValue(JSON.parse(payload)) as PageRuleCacheEntry;
    if (!decoded || !Array.isArray(decoded.ruleResults) || !decoded.features) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ============================================
// THE STREAM'S VIEW OF THE CACHE
// ============================================

/**
 * The persistence half of the cache, in the terms a store can actually speak:
 * opaque keys and encoded payloads, no page records and no rule types.
 *
 * `runStreamingRules` owns the key derivation (it is the only place that holds
 * the run context) and wraps a store into the {@link StreamRuleCache} the stream
 * consumes. The CLI supplies a `project.db`-backed store; the cloud supplies
 * none; tests supply a Map.
 */
export interface RuleCacheStore {
  /** Stored payloads for whichever of `keys` exist. */
  load(keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Record a freshly-produced payload for this crawl. */
  putFresh(key: string, normalizedUrl: string, payload: string): void;
  /** Copy an existing entry into this crawl WITHOUT re-encoding it. */
  carryForward(key: string, normalizedUrl: string): void;
  /** Called per page batch and at the end; buffered writes land here. */
  flush?(): Promise<void>;
}

/**
 * What {@link streamPageRules} needs of a cache. Kept to four methods so the
 * engine stays storage-free: the CLI supplies an implementation backed by
 * `project.db`, the cloud supplies none, and the tests supply an in-memory one.
 */
export interface StreamRuleCache {
  /** Key for this page, or null if it cannot participate. */
  keyFor(
    page: PageRecord,
    soft404Confirmation: ParsedPage["soft404Confirmation"] | undefined
  ): Promise<string | null>;
  /** Entries for whichever of `keys` are cached. */
  load(keys: readonly string[]): Promise<ReadonlyMap<string, PageRuleCacheEntry>>;
  /** Persist what a freshly-run page produced, under this crawl. */
  putFresh(key: string, page: PageRecord, entry: PageRuleCacheEntry): void;
  /**
   * Carry a REPLAYED page's existing entry forward into this crawl.
   *
   * Split from {@link StreamRuleCache.putFresh} because it must not cost what a
   * fresh write costs: the stored bytes are already exactly right, so an
   * implementation copies the row and never re-encodes or re-compresses. Without
   * the carry-forward, `retireCrawls` deleting the crawl the entry came from would
   * make the audit after it cold again.
   */
  carryForward(key: string, page: PageRecord): void;
  /**
   * Called at every page-batch boundary and once at the end, so an implementation
   * that buffers writes never holds more than one batch of them.
   */
  flush?(): Promise<void>;
}

/** What the pass did with the cache, for the report and the benchmarks. */
export interface RuleCacheStats {
  /** Pages whose rules ran fresh (cache off, miss, or not cacheable). */
  freshPages: number;
  /** Pages that skipped parse + page rules and replayed stored verdicts. */
  replayedPages: number;
  /** Entries written for this crawl (fresh + replayed carried forward). */
  storedEntries: number;
  /** Set when the run is not replaying at all. */
  disabledReason?: RuleCacheDisabledReason;
}

/** The stats a run with no cache reports. */
export function emptyRuleCacheStats(disabledReason?: RuleCacheDisabledReason): RuleCacheStats {
  return { freshPages: 0, replayedPages: 0, storedEntries: 0, ...(disabledReason ? { disabledReason } : {}) };
}

/**
 * Bind a {@link RuleCacheStore} to a run context, producing the cache the stream
 * consumes: keys derived here, payloads encoded and decoded here, storage left to
 * speak only in keys and strings.
 *
 * A payload that will not decode is treated as a MISS, not an error — a
 * half-written or older-format row costs a page's rules and never a wrong report.
 */
export function bindRuleCache(store: RuleCacheStore, runContextHash: string): StreamRuleCache {
  // The year the run context was hashed under. A long audit can cross UTC New
  // Year while it runs, and `content/stale-copyright` reads the clock itself: a
  // page replayed after midnight would serve last year's verdict while a fresh
  // evaluation of it warns. Rather than freeze a year the rule cannot be told
  // about, replay simply stops for the rest of the run once the year moves — those
  // pages are audited normally, which is always a correct answer.
  const boundYear = new Date().getUTCFullYear();
  return {
    keyFor: (page, soft404Confirmation) =>
      new Date().getUTCFullYear() === boundYear
        ? computePageCacheKey(runContextHash, page, soft404Confirmation)
        : Promise.resolve(null),
    async load(keys) {
      const raw = await store.load(keys);
      const out = new Map<string, PageRuleCacheEntry>();
      for (const [key, payload] of raw) {
        const entry = decodePageRuleCacheEntry(payload);
        if (entry) out.set(key, entry);
      }
      return out;
    },
    putFresh(key, page, entry) {
      store.putFresh(key, page.normalizedUrl, encodePageRuleCacheEntry(entry));
    },
    carryForward(key, page) {
      store.carryForward(key, page.normalizedUrl);
    },
    flush: store.flush ? () => store.flush!() : undefined,
  };
}

/**
 * The page rules of a runner, in execution order, with their resolved options —
 * the run-context ingredient that makes a rule added, removed, reordered,
 * disabled or reconfigured invalidate every entry.
 */
export function pageRuleSelection(
  rules: ReadonlyArray<{ meta: RuleMeta }>,
  optionsOf: (rule: { meta: RuleMeta }) => unknown
): Array<{ id: string; options: unknown }> {
  return rules
    .filter((r) => r.meta.scope === "page")
    .map((r) => ({ id: r.meta.id, options: optionsOf(r) }));
}
