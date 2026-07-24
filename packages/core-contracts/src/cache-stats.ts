// Cache-stats aggregation (#108) — pure, dependency-free so any layer (CLI
// report reconstruction, cloud runner, tests) can derive the same numbers.
//
// Aggregates per-audit cache reuse across PAGES (from CrawlStats, captured by
// the crawler hot-path) and SUB-RESOURCES (from ResourceSizeRecord[], captured
// by the resource checker). The result is persisted on the report and surfaced
// in the dashboard panel + the compact CLI/HTML report line.

import type {
  CacheHitReason,
  CacheHitsByReason,
  CacheStats,
  CrawlStats,
  ResourceSizeRecord,
} from "./storage";

/**
 * Canonical set of cache-hit reasons — the single source of truth shared by the
 * crawler hot-path (page reuse) and the storage layer (persisted resource
 * cache_reason validation). Keep in sync with the {@link CacheHitReason} union.
 */
export const CACHE_HIT_REASONS: readonly CacheHitReason[] = [
  "max-age",
  "s-maxage",
  "expires",
  "immutable",
  "304",
  "hash_match",
  "stale-while-revalidate",
];

const CACHE_HIT_REASON_SET = new Set<string>(CACHE_HIT_REASONS);

/** Type guard: is `value` a known CacheHitReason? */
export function isCacheHitReason(
  value: string | null | undefined
): value is CacheHitReason {
  return value != null && CACHE_HIT_REASON_SET.has(value);
}

/** Sum two hits-by-reason maps into a fresh object (no mutation). */
function mergeHitsByReason(
  a: CacheHitsByReason,
  b: CacheHitsByReason
): CacheHitsByReason {
  const out: CacheHitsByReason = { ...a };
  for (const [reason, count] of Object.entries(b) as [
    CacheHitReason,
    number,
  ][]) {
    out[reason] = (out[reason] ?? 0) + (count ?? 0);
  }
  return out;
}

/** Total of all per-reason counts. */
function sumReasons(byReason: CacheHitsByReason): number {
  let total = 0;
  for (const count of Object.values(byReason)) total += count ?? 0;
  return total;
}

/**
 * Build the per-audit {@link CacheStats} aggregate from crawl stats + the
 * sub-resource records collected this run.
 *
 * Page side: `pagesUnchanged` is the count of pages reused from cache by ANY
 * reason (304 / hash / origin-fresh / SWR); `cacheHitsByReason` (on CrawlStats)
 * carries the breakdown. `bytesCacheSaved` is the page bytes saved (origin-fresh
 * skips). Page total = pagesFetched + pagesUnchanged (every page that produced a
 * row), so the hit rate is "of the cacheable pages, how many avoided a fetch".
 *
 * Resource side: each record with a non-null `cacheReason` is a hit; its
 * `cacheReason` feeds the breakdown and `sizeBytes` (the body avoided this run)
 * the saving — NOT `transferBytes`, which is 0 on a hit by construction.
 *
 * Returns `null` when there were ZERO cache hits — a first/cold crawl (or a
 * forced --refresh) has nothing to report, so the field stays absent rather
 * than rendering a misleading "0% hit rate" panel/line. Stats only appear once
 * there is actual reuse to show.
 */
export function buildCacheStats(
  stats: CrawlStats | null | undefined,
  resources: readonly ResourceSizeRecord[] = []
): CacheStats | null {
  const pageHitsByReason: CacheHitsByReason = stats?.cacheHitsByReason ?? {};
  const pageHits = stats?.pagesUnchanged ?? 0;
  const pageTotal = (stats?.pagesFetched ?? 0) + pageHits;
  const pageBytesSaved = stats?.bytesCacheSaved ?? 0;

  // Sub-resource side: a hit is any record carrying a cacheReason. Bytes saved
  // is the body we AVOIDED transferring this run — the resource's full size.
  // (transferBytes is 0 on a hit by construction, so it must NOT be used here.)
  let resourceHits = 0;
  let resourceBytesSaved = 0;
  let resourceByReason: CacheHitsByReason = {};
  const resourceTotal = resources.length;
  for (const r of resources) {
    if (!r.cacheReason) continue;
    resourceHits++;
    resourceBytesSaved += r.sizeBytes ?? 0;
    resourceByReason = mergeHitsByReason(resourceByReason, {
      [r.cacheReason]: 1,
    });
  }

  const hits = pageHits + resourceHits;
  // No reuse to report — a first/cold crawl (or forced --refresh). Omit the
  // panel/line entirely rather than render a misleading "0% hit rate".
  if (hits === 0) return null;

  const total = pageTotal + resourceTotal;
  const bytesSaved = pageBytesSaved + resourceBytesSaved;
  const hitsByReason = mergeHitsByReason(pageHitsByReason, resourceByReason);

  return {
    total,
    hits,
    hitRate: total > 0 ? hits / total : 0,
    bytesSaved,
    hitsByReason,
    pages: { total: pageTotal, hits: pageHits, bytesSaved: pageBytesSaved },
    resources: {
      total: resourceTotal,
      hits: resourceHits,
      bytesSaved: resourceBytesSaved,
    },
  };
}

/** Re-exported for callers that only need the reason total. */
export { sumReasons as sumCacheReasons };
