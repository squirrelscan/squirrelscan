// Cache-store abstraction for browser-like crawl caching (#105).
//
// A CacheStore persists fetched responses per-site, cross-audit, so subsequent
// audits can reuse fresh content (no request), revalidate cheaply (conditional
// GET → 304), or detect real changes (content hash). It is the seam that makes
// freshness decisions identical local↔cloud:
//
//   - Local (logged-out CLI): backed by the per-project SQLite store in the
//     squirrel data dir (~/.squirrel/projects/<domain>/project.db) plus the
//     global content-store for body dedup/compression. No cloud needed.
//   - Cloud: backed by the same CrawlStorage interface (DO SQLite today; R2 for
//     bodies + D1/DO for metadata is a drop-in future backend). Same freshness
//     logic runs on both sides.
//
// The freshness/Vary/change-detection decisions themselves live in
// `incremental.ts` and are storage-agnostic — this module only handles
// persistence keyed by normalized URL + Vary dimensions.

import { Effect } from "effect";

import type { CrawlStorage, PageRecord, StorageError } from "./storage/types";
import { calculateFreshness, varyMatches } from "./incremental";
import type {
  FreshnessOptions,
  FreshnessResult,
} from "./incremental";

/**
 * Request headers we vary the cache on. We send a small, stable set, so this is
 * all a cached entry can legitimately depend on. Kept minimal on purpose:
 * over-keying just causes spurious cache misses.
 */
export interface CacheRequestContext {
  /** Lowercase header name → value, as sent on the request */
  requestHeaders: Record<string, string>;
}

/**
 * A cache lookup result. Discriminated on `entry`: a hit always carries a
 * freshness verdict, a miss never does — so consumers can't read freshness
 * without proving there's an entry, and an impl returning an entry without
 * freshness fails typecheck. Freshness: "fresh" = reuse without a request;
 * "revalidate" (SWR) = serve-now + refresh later; "stale" = conditional GET.
 */
export type CacheLookup =
  | { entry: null; freshness?: undefined }
  | { entry: PageRecord; freshness: FreshnessResult };

/**
 * Persistent, per-site, cross-audit response cache. Implementations must keep
 * freshness behavior identical so local and cloud audits make the same calls.
 */
export interface CacheStore {
  /**
   * Look up a cached entry for a normalized URL, honoring Vary keying against
   * the current request context, and compute its freshness.
   *
   * The crawler hot-path (core/crawler.ts) delegates its lookup to this method
   * (#147), so local and cloud make identical freshness decisions from one
   * source of truth (incremental.ts). The crawl loop retains the orchestration
   * (SWR, conditional-GET fallback, frontier/stats) — this returns the entry +
   * freshness those branches need.
   */
  lookup(
    normalizedUrl: string,
    ctx: CacheRequestContext,
    options?: FreshnessOptions
  ): Effect.Effect<CacheLookup, StorageError, never>;

  /** Persist a freshly fetched response for future audits. */
  store(
    crawlId: string,
    page: PageRecord
  ): Effect.Effect<void, StorageError, never>;
}

/**
 * Local cache-store backed by a {@link CrawlStorage} (CLI SQLite or cloud DO
 * SQLite). `getCachedPage` already returns the most-recent stored entry for a
 * URL across crawls; we layer Vary keying + freshness on top.
 */
export class StorageCacheStore implements CacheStore {
  constructor(private readonly storage: CrawlStorage) {}

  lookup(
    normalizedUrl: string,
    ctx: CacheRequestContext,
    options: FreshnessOptions = {}
  ): Effect.Effect<CacheLookup, StorageError, never> {
    return Effect.gen(this, function* () {
      // NOTE: getCachedPage returns the single most-recent row for this URL.
      // When a site serves multiple Vary variants, only the newest is checked;
      // a request matching an older variant is treated as a miss and re-fetched.
      // This is SAFE (we never serve the wrong variant) — at worst it costs one
      // extra fetch. Scanning recent rows for the newest matching variant is a
      // possible future optimization (#107 fast-follow).
      const entry = yield* this.storage.getCachedPage(normalizedUrl);
      if (!entry) return { entry: null };

      // Vary keying: if the stored response's Vary constraints aren't satisfied
      // by the current request headers, treat it as a miss (never reuse).
      if (
        !varyMatches(
          entry.headers.vary ?? null,
          entry.requestHeaders ?? null,
          ctx.requestHeaders
        )
      ) {
        return { entry: null };
      }

      const freshness = calculateFreshness(
        {
          cacheControl: entry.headers.cacheControl ?? null,
          expires: entry.headers.expires ?? null,
          age: entry.headers.age ?? null,
          fetchedAt: entry.fetchedAt,
        },
        options
      );

      return { entry, freshness };
    });
  }

  store(
    crawlId: string,
    page: PageRecord
  ): Effect.Effect<void, StorageError, never> {
    return this.storage.upsertPage(crawlId, page);
  }
}

/** Convenience factory mirroring the rest of the package's create* helpers. */
export function createStorageCacheStore(storage: CrawlStorage): CacheStore {
  return new StorageCacheStore(storage);
}
