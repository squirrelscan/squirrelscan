// Main crawler implementation
// Decoupled from AuditContext, uses storage layer and emits events

import { Effect, Stream, PubSub, Duration, Deferred } from "effect";

import type { LinkData, SitemapData } from "@squirrelscan/core-contracts";
import { isCacheHitReason } from "@squirrelscan/core-contracts";
import { COVERAGE_PAGE_LIMITS, REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import { extractCrawlableUrls } from "@squirrelscan/parser/extractors";
import { parseDocument, parsePage, type ParsedPageCache } from "@squirrelscan/parser";
import { findClientRedirects } from "@squirrelscan/utils/client-redirects";
import { urlHostKey } from "@squirrelscan/utils/url";

import { computeSitemapUrlCap, discoverSitemaps, selectSitemapUrls } from "../sitemaps";

import type { RobotsEvaluator } from "../robots";
import type {
  CacheHitReason,
  CacheHitsByReason,
  CrawlStorage,
  CrawlStats,
  PageRecord,
  FrontierRecord,
  StorageError,
  ResponseHeaders,
  SecurityHeaders,
} from "../storage/types";
import type { CrawlDecision } from "../types";
import type {
  Crawler,
  CrawlerConfig,
  CrawlerEvent,
  CrawlerPageUnchangedEvent,
  HostScheduler,
  HostState,
} from "./types";

import { fetchPageWithRetry, type CrawlFetcher } from "../fetcher";
import { normalizeUrl, isInScope } from "../frontier";
import {
  buildConditionalHeaders,
  extractChangeDetection,
  hasContentChanged,
  isNotModifiedResponse,
  type FreshReason,
} from "../incremental";
import { StorageCacheStore } from "../cache-store";
import {
  createPatternStats,
  getPatternStats,
  markPatternCrawled,
  markPatternQueued,
  clearPatternStats,
  type PatternStats,
} from "../pattern";
import { getPathPrefix } from "../prefix";
import { sitemapGateFromFrontier } from "./sitemap-gate";
import {
  calculatePriorityWithPath,
  calculatePriorityWithBreadth,
  calculatePriorityWithSurface,
  RECENTLY_REMOVED_PENALTY,
} from "../priority";
import { fetchLlmsTxt } from "../llms";
import { probeMarkdownResponse } from "../markdown";
import { fetchRobotsEvaluator as fetchRobots } from "../robots";
import { probeWellKnown } from "../well-known";
import { probeAgentAccess } from "../agent-access";
import { fetchRslLicensing } from "../rsl";
import { createTestStorage } from "../storage";
import { DEFAULT_CRAWLER_CONFIG, CrawlerError } from "./types";

const PATTERN_SAMPLE_LIMIT = 1;
// Hard cap on robots.txt Crawl-delay when respectRobots is true (#790).
// WP Engine/Yoast sites commonly ship "Crawl-delay: 10", which stretched a
// 25-page quick audit past 4 minutes of pure sleep.
const MAX_ROBOTS_CRAWL_DELAY_MS = 2000;
// Max crawl-time ParsedPage retentions (#267 cache, #858 cap). Pinned to the
// quick-coverage page limit so quick audits keep the full fast path; beyond it
// the audit re-parses (~12.5ms/page) instead of holding every DOM in memory
// for the remainder of the crawl.
const PARSED_PAGE_CACHE_MAX_PAGES = COVERAGE_PAGE_LIMITS.quick;
const logger = {
  debug: (_message: string, ..._args: unknown[]) => {},
  warn: (_message: string, ..._args: unknown[]) => {},
};

// ============================================
// HOST SCHEDULER
// ============================================

function createHostScheduler(maxConcurrent: number): HostScheduler {
  const hosts = new Map<string, HostState>();
  const waiters = new Map<string, Array<Deferred.Deferred<void, never>>>();

  const getState = (host: string): HostState => hosts.get(host) ?? { inFlight: 0, nextFetchAt: 0 };

  const setState = (host: string, state: HostState): void => {
    hosts.set(host, state);
  };

  const getWaiters = (host: string): Array<Deferred.Deferred<void, never>> => {
    let list = waiters.get(host);
    if (!list) {
      list = [];
      waiters.set(host, list);
    }
    return list;
  };

  const release = (host: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const hostWaiters = getWaiters(host);
      if (hostWaiters.length > 0) {
        // Wake up next waiter (they get the slot)
        const nextWaiter = hostWaiters.shift()!;
        yield* Deferred.succeed(nextWaiter, undefined);
        // inFlight stays the same (slot transferred to waiter)
      } else {
        // No waiters - decrement inFlight
        const state = getState(host);
        setState(host, {
          ...state,
          inFlight: Math.max(0, state.inFlight - 1),
        });
      }
    });

  const acquire = (host: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const state = getState(host);
      if (state.inFlight < maxConcurrent) {
        // Slot available - acquire immediately
        setState(host, { ...state, inFlight: state.inFlight + 1 });
        return;
      }
      // No slot available - wait for notification. If this waiter is
      // interrupted (crawl abort/timeout) the slot must not leak: while
      // still queued, just dequeue ourselves; if release() already granted
      // us the slot, pass it on so inFlight doesn't stay pinned forever.
      const deferred = yield* Deferred.make<void, never>();
      const list = getWaiters(host);
      list.push(deferred);
      yield* Deferred.await(deferred).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const idx = list.indexOf(deferred);
            if (idx >= 0) {
              list.splice(idx, 1);
            } else {
              yield* release(host);
            }
          }),
        ),
      );
      // Slot acquired by release() notifying us
    });

  return {
    acquire,
    release,

    waitForDelay: (host: string, delayMs: number) =>
      Effect.gen(function* () {
        // delayMs <= 0 disables staggering (e.g. cloud render path) — pure concurrency limit.
        if (delayMs <= 0) return;
        // Reserve an independent start slot (#265): stagger request STARTS, not completions — atomic (no yield between read+reserve).
        const state = getState(host);
        const now = Date.now();
        const scheduledStart = Math.max(now, state.nextFetchAt);
        setState(host, { ...state, nextFetchAt: scheduledStart + delayMs });
        const waitMs = scheduledStart - now;
        if (waitMs > 0) {
          yield* Effect.sleep(Duration.millis(waitMs));
        }
      }),
  };
}

// ============================================
// CRAWLER FACTORY
// ============================================

export interface CreateCrawlerOptions {
  config?: Partial<CrawlerConfig>;
  storage?: CrawlStorage;
  // Opt-in: retains each crawl-time ParsedPage so a same-process audit skips re-parse (#267)
  parsedPageCache?: ParsedPageCache;
  // Opt-in: injectable fetch seam; defaults to the real fetchPageWithRetry (#315)
  fetcher?: CrawlFetcher;
}

export function createCrawler(
  options: CreateCrawlerOptions = {},
): Effect.Effect<Crawler, StorageError, never> {
  const config: CrawlerConfig = {
    ...DEFAULT_CRAWLER_CONFIG,
    ...options.config,
  };

  // Recently-removed (404/410) URLs to de-prioritize (#1146). Values are already
  // normalized (they come from a prior crawl's normalized_url), so membership is
  // tested against enqueueUrl's `normalized`. Built once — the set is static.
  const recentlyRemovedSet = new Set(config.deprioritizedUrls ?? []);

  // Injected fetcher or the real retrying fetcher (#315).
  const fetchPage = options.fetcher ?? fetchPageWithRetry;

  return Effect.gen(function* () {
    // Initialize storage (in-memory for tests, or provided storage)
    const storage = options.storage ?? (yield* createTestStorage());

    // Create event pubsub
    const eventHub = yield* PubSub.unbounded<CrawlerEvent>();

    // State
    let currentCrawlId: string | null = null;
    let isPaused = false;
    let isRunning = false;
    // Completed by stop() to trigger the crawl loop's grace-then-interrupt hard
    // cap (#923). Overwritten with a fresh Deferred at the start of each
    // runCrawlLoop; null only before the first run. A stray stop() between runs
    // hits an orphaned Deferred whose stopGuard already resolved or lost its
    // race, so Deferred.succeed has no awaiter and is an inert no-op.
    let stopSignal: Deferred.Deferred<void, never> | null = null;
    let robots: RobotsEvaluator | null = null;
    let baseUrl: string = "";
    // In-memory mirror of getPageCount (rows in `pages`): seeded at
    // runCrawlLoop start (resume-safe), bumped per upsertPage — avoids a
    // hot-path COUNT(*) per enqueue/dispatch (#268).
    let pagesCommitted = 0;

    // Breadth-first tracking
    const prefixStats = new Map<string, { crawled: number; queued: number }>();
    let pendingDepth1Count = 0;

    // Pattern tracking for surface mode
    const patternStats: PatternStats = createPatternStats();

    // Breadth-first helper: update stats after URL completion (fetched/failed/unchanged)
    const markPrefixCrawled = (url: string, depth: number) => {
      if (!config.breadthFirst) return;
      const prefix = getPathPrefix(url);
      const stats = prefixStats.get(prefix) ?? { crawled: 0, queued: 0 };
      prefixStats.set(prefix, {
        crawled: stats.crawled + 1,
        queued: Math.max(0, stats.queued - 1),
      });
      if (depth === 1) {
        pendingDepth1Count = Math.max(0, pendingDepth1Count - 1);
      }
    };

    // Breadth-first helper: update stats after failure (no crawled increment)
    const markPrefixFailed = (url: string, depth: number) => {
      if (!config.breadthFirst) return;
      const prefix = getPathPrefix(url);
      const stats = prefixStats.get(prefix) ?? { crawled: 0, queued: 0 };
      prefixStats.set(prefix, {
        ...stats,
        queued: Math.max(0, stats.queued - 1),
      });
      if (depth === 1) {
        pendingDepth1Count = Math.max(0, pendingDepth1Count - 1);
      }
    };

    // Emit event helper
    const emit = (event: CrawlerEvent) => PubSub.publish(eventHub, event);

    // Host scheduler
    const hostScheduler = createHostScheduler(config.perHostConcurrency);

    // Shared cache seam (#147): same lookup logic runs local + cloud.
    const cacheStore = new StorageCacheStore(storage);

    // ----------------------------------------
    // URL Normalization and Scope
    // ----------------------------------------

    const normalizeAndCheckScope = (
      rawUrl: string,
    ): { normalized: string | null; decision: CrawlDecision } => {
      const normalized = normalizeUrl(rawUrl, {
        baseUrl,
        allowQueryParams: config.allowQueryParams,
        dropQueryPrefixes: config.dropQueryPrefixes,
      });

      if (!normalized) {
        return {
          normalized: null,
          decision: { allowed: false, reason: "invalid_url" },
        };
      }

      const decision = isInScope(normalized, {
        baseUrl,
        include: config.include,
        exclude: config.exclude,
        allowedDomains: config.allowedDomains,
      });

      return { normalized, decision };
    };

    // ----------------------------------------
    // Enqueue URL
    // ----------------------------------------

    const enqueueUrl = (
      crawlId: string,
      rawUrl: string,
      depth: number,
      parentUrl: string | undefined,
      source: "seed" | "sitemap" | "discovered" | "carried",
      sitemapPriority?: number,
      linkCountCache?: Map<string, number>,
    ): Effect.Effect<void, StorageError, never> =>
      Effect.gen(function* () {
        const { normalized, decision } = normalizeAndCheckScope(rawUrl);

        if (!normalized) return;

        // Depth ceiling (#318): never enqueue past maxDepth. Unset = unlimited (no-op).
        if (config.maxDepth != null && depth > config.maxDepth) return;

        // Check if already in frontier
        const existing = yield* storage.getFrontierEntry(crawlId, normalized);
        if (existing) return;

        // Oversize URLs (#1229): the publish schema caps pages[].url et al at
        // REPORT_LIMITS.maxUrlLength STRICT (no clamp — they're join keys the
        // smart-audits merge matches verbatim). Skip here rather than truncate
        // — a truncated URL is a different resource — so a crawled >2048-char
        // URL never reaches the report and 400s the whole publish. Recorded as
        // a skipped frontier entry like the scope/robots decisions below, so
        // it's diagnosable.
        if (normalized.length > REPORT_LIMITS.maxUrlLength) {
          logger.debug("url skipped (too long)", `${normalized.length} chars`);
          yield* storage.upsertFrontier(crawlId, {
            normalizedUrl: normalized,
            rawUrl,
            depth,
            parentUrl,
            priority: 0,
            status: "skipped",
            source,
            enqueuedAt: Date.now(),
            retryCount: 0,
            reason: "url_too_long",
          });
          return;
        }

        // Check scope
        if (!decision.allowed) {
          logger.debug("url skipped (scope)", `${normalized} — ${decision.reason}`);
          yield* storage.upsertFrontier(crawlId, {
            normalizedUrl: normalized,
            rawUrl,
            depth,
            parentUrl,
            priority: 0,
            status: "skipped",
            source,
            enqueuedAt: Date.now(),
            retryCount: 0,
            reason: decision.reason,
          });
          return;
        }

        // Check robots
        if (config.respectRobots && robots && !robots.isAllowed(normalized)) {
          logger.debug("url skipped (robots)", normalized);
          yield* storage.upsertFrontier(crawlId, {
            normalizedUrl: normalized,
            rawUrl,
            depth,
            parentUrl,
            priority: 0,
            status: "skipped",
            source,
            enqueuedAt: Date.now(),
            retryCount: 0,
            reason: "robots_disallowed",
          });
          return;
        }

        // Check max pages (in-memory; the dispatch loop is the authoritative cap)
        if (pagesCommitted >= config.maxPages) {
          return;
        }

        // Calculate priority (use cache if available to eliminate N+1 queries)
        const incomingLinkCount = linkCountCache
          ? (linkCountCache.get(normalized) ?? 0)
          : yield* storage.getIncomingLinkCount(crawlId, normalized);

        // Get prefix stats for breadth-first mode
        const prefix = getPathPrefix(normalized);
        const stats = prefixStats.get(prefix) ?? { crawled: 0, queued: 0 };

        // Calculate priority based on coverage mode
        let priority: number;
        const priorityFactors = {
          depth,
          sitemapPriority,
          incomingLinkCount,
          source,
        };
        const breadthFactors = {
          prefixCrawledCount: stats.crawled,
          totalPrefixes: Math.max(prefixStats.size, 1),
          maxPages: config.maxPages,
          depth,
          pendingDepth1Count,
          maxPrefixBudgetRatio: config.maxPrefixBudgetRatio,
        };

        if (source === "carried") {
          // Carried-finding seeds (#1146): use the path-only score so the source
          // bonus stands — never the breadth/pattern penalties, which would sink
          // many carried pages sharing one prefix (e.g. /blog/*) below discovery
          // and defeat the re-check. They're already budget-capped upstream.
          priority = calculatePriorityWithPath(priorityFactors, normalized);
        } else if (
          (config.coverageMode === "surface" && config.breadthFirst) ||
          config.coverageMode === "quick"
        ) {
          // Surface + quick mode: add pattern penalty for already-sampled patterns
          const patternEntry = getPatternStats(patternStats, normalized);
          priority = calculatePriorityWithSurface(priorityFactors, normalized, breadthFactors, {
            patternCrawledCount: patternEntry?.crawledCount ?? 0,
            patternSampleLimit: PATTERN_SAMPLE_LIMIT,
          });
          markPatternQueued(patternStats, normalized);
        } else if (config.breadthFirst) {
          priority = calculatePriorityWithBreadth(priorityFactors, normalized, breadthFactors);
        } else {
          priority = calculatePriorityWithPath(priorityFactors, normalized);
        }

        // De-prioritize recently-removed (404/410) URLs (#1146) so dead URLs sink
        // below the live frontier and stop eating budget slots.
        if (recentlyRemovedSet.has(normalized)) {
          priority += RECENTLY_REMOVED_PENALTY;
        }

        // Enqueue first, then update counters on success
        yield* storage.upsertFrontier(crawlId, {
          normalizedUrl: normalized,
          rawUrl,
          depth,
          parentUrl,
          priority,
          status: "pending",
          source,
          enqueuedAt: Date.now(),
          retryCount: 0,
        });

        // Update prefix queued count AFTER successful enqueue
        if (config.breadthFirst) {
          prefixStats.set(prefix, { ...stats, queued: stats.queued + 1 });
          if (depth === 1) {
            pendingDepth1Count++;
          }
        }

        yield* emit({
          type: "url:enqueued",
          url: normalized,
          priority,
          source,
          depth,
          timestamp: Date.now(),
        });

        // Emit discovered event only for URLs found during crawling
        if (source === "discovered") {
          yield* emit({
            type: "url:discovered",
            url: normalized,
            fromUrl: parentUrl ?? normalized,
            depth,
            timestamp: Date.now(),
          });
        }
      });

    // ----------------------------------------
    // Reuse a cached page (304 / hash-match / origin-fresh / SWR)
    // ----------------------------------------
    // Shared by every "no real fetch needed" path: copy the cached page +
    // links + images into the current crawl for reporting, re-discover links to
    // keep the frontier draining, mark done, emit an unchanged event, and bump
    // stats. `cacheFresh` distinguishes "served from cache with no request at
    // all" (origin freshness/SWR) from a conditional-GET hit (304/hash).
    const reuseCachedPage = (
      crawlId: string,
      entry: FrontierRecord,
      cachedPage: PageRecord,
      reason: CrawlerPageUnchangedEvent["reason"],
      opts: { cacheFresh: boolean },
    ): Effect.Effect<void, StorageError, never> =>
      Effect.gen(function* () {
        // Copy cached page into the current crawl for reporting.
        yield* storage.upsertPage(crawlId, {
          ...cachedPage,
          depth: entry.depth,
          parentUrl: entry.parentUrl,
        });
        pagesCommitted++;

        // Copy links + images from the cached page.
        const cachedLinks = yield* storage.getLinksByPage(entry.normalizedUrl);
        for (const link of cachedLinks) {
          yield* storage.upsertLink(crawlId, link);
        }
        const cachedImages = yield* storage.getImagesByPage(entry.normalizedUrl);
        for (const img of cachedImages) {
          yield* storage.upsertImage(crawlId, img);
        }

        // Re-discover URLs from cached data to keep crawling. Fast path: use
        // pre-parsed link data; fall back to re-parsing cached HTML.
        let crawlableUrls: string[] = [];
        if (cachedPage.parsedData) {
          try {
            const parsed = JSON.parse(cachedPage.parsedData) as {
              links?: LinkData[];
            };
            if (parsed.links) {
              crawlableUrls = parsed.links
                .filter((link) => link.isInternal && !link.isNofollow)
                .map((link) => {
                  try {
                    const url = new URL(link.url);
                    url.hash = "";
                    return url.toString();
                  } catch {
                    return null;
                  }
                })
                .filter((url): url is string => url !== null);
            }
          } catch {
            // Fall through to HTML parsing
          }
        }
        if (
          crawlableUrls.length === 0 &&
          cachedPage.html &&
          (isHtmlContentType(cachedPage.contentType) ||
            (!cachedPage.contentType && looksLikeHtml(cachedPage.html)))
        ) {
          const doc = parseDocument(cachedPage.html);
          crawlableUrls = extractCrawlableUrls(doc, cachedPage.finalUrl);
        }
        for (const url of crawlableUrls) {
          yield* enqueueUrl(crawlId, url, entry.depth + 1, entry.normalizedUrl, "discovered");
        }

        yield* storage.updateFrontierStatus(crawlId, entry.normalizedUrl, "done");
        yield* emit({
          type: "page:unchanged",
          url: entry.normalizedUrl,
          reason,
          depth: entry.depth,
          timestamp: Date.now(),
        });
        // Record the hit reason for the per-audit hits-by-reason breakdown
        // (#108). reuseCachedPage is only ever called with reasons that are
        // valid CacheHitReasons (304/hash_match/origin-fresh/SWR), never
        // etag_match, so this map is safe.
        const cacheHitsByReason = isCacheHitReason(reason) ? { [reason]: 1 } : undefined;
        yield* updateStats(crawlId, {
          pagesUnchanged: 1,
          ...(cacheHitsByReason ? { cacheHitsByReason } : {}),
          // Origin-fresh / SWR reuse skipped the request entirely — track the
          // saved request + (approx) bytes for cache-hit reporting.
          ...(opts.cacheFresh
            ? {
                pagesCacheFresh: 1,
                bytesCacheSaved: cachedPage.sizeBytes ?? 0,
              }
            : {}),
        });
        markPrefixCrawled(entry.normalizedUrl, entry.depth);
      });

    // ----------------------------------------
    // Process Single URL
    // ----------------------------------------

    const processUrl = (
      crawlId: string,
      entry: FrontierRecord,
    ): Effect.Effect<void, CrawlerError | StorageError, never> =>
      Effect.gen(function* () {
        const host = urlHostKey(entry.normalizedUrl);
        // Crawl-delay only overrides per_host_delay_ms when respectRobots is
        // true (#790), and is capped — some sites ship absurd values (10s+).
        const delayMs =
          config.respectRobots && robots?.crawlDelayMs != null
            ? Math.min(robots.crawlDelayMs, MAX_ROBOTS_CRAWL_DELAY_MS)
            : config.perHostDelayMs;

        // Acquire host slot
        yield* hostScheduler.acquire(host);

        // Release the slot on EVERY exit — success, failure, or interruption.
        // A plain try/finally here does NOT run on Effect failure/interrupt
        // (the generator is abandoned, not thrown into), so a store error
        // (upsertPage) or a stop()/watchdog interrupt would leak the per-host
        // slot and deadlock every later same-host fetch on acquire (#924/#923).
        // Effect.ensuring is the guaranteed-finalizer seam.
        yield* Effect.gen(function* () {
          // Cache lookup + freshness short-circuit run BEFORE the per-host
          // stagger (#824): a fully-cached page does zero network, so it must not
          // pay the delay. Only the paths that actually hit the network below
          // wait — conditional GET (stale) and full fetch.
          // Build conditional headers for incremental crawl
          const conditionalHeaders: Record<string, string> = {};
          let cachedPage: PageRecord | null = null;
          // Request headers we vary the cache on (must match what the fetcher
          // actually sends; a stable, minimal set keeps Vary keying meaningful).
          const requestContext = buildCacheRequestContext(config);
          if (config.incremental) {
            // Lookup goes through the shared StorageCacheStore seam (#147): it
            // owns getCachedPage + Vary keying + freshness, so local and cloud
            // make identical decisions from one source of truth. The crawl loop
            // still owns the orchestration below (SWR, conditional-GET fallback,
            // frontier/stats) — lookup hands back the entry + freshness it needs.
            const cacheLookup = yield* cacheStore.lookup(
              entry.normalizedUrl,
              { requestHeaders: requestContext },
              { maxStalenessSeconds: config.maxStalenessSeconds },
            );

            if (cacheLookup.entry) {
              // Narrowing on the lookup union guarantees freshness is present.
              cachedPage = cacheLookup.entry;
              // Browser-like freshness: if the origin says the entry is still
              // fresh (Cache-Control max-age / Expires / immutable), skip the
              // request ENTIRELY — bounded by maxStalenessSeconds so an absurd
              // max-age can't silently freeze a whole audit. SWR serves stale
              // now and revalidates in the background.
              if (config.useCacheControl) {
                const freshness = cacheLookup.freshness;

                if (freshness.state === "fresh") {
                  // For state === "fresh", calculateFreshness only emits a
                  // FreshReason (max-age/s-maxage/expires/immutable); the cast
                  // bridges the independent state/reason fields.
                  const reason = freshnessReasonToEvent(freshness.reason as FreshReason);
                  yield* reuseCachedPage(crawlId, entry, cachedPage, reason, {
                    cacheFresh: true,
                  });
                  return;
                }

                if (freshness.state === "revalidate") {
                  // stale-while-revalidate: serve the stale copy immediately
                  // without blocking on a request. We deliberately do NOT write
                  // a background refresh into THIS crawl — the page row is the
                  // report row for the current audit (keyed by crawl_id +
                  // normalized_url) and was not re-parsed for links/images/
                  // rules, so overwriting it mid-audit would corrupt the report.
                  // The next audit revalidates it cheaply via conditional GET.
                  //
                  // cacheFresh:false — the content is STALE (past max-age), so
                  // it must not inflate pagesCacheFresh/bytesCacheSaved (which
                  // mean "origin said fresh"). It still counts in pagesUnchanged.
                  yield* reuseCachedPage(crawlId, entry, cachedPage, "stale-while-revalidate", {
                    cacheFresh: false,
                  });
                  return;
                }
              }

              // Stale (or cache-control disabled): fall back to a conditional
              // GET so the server can answer 304 if nothing changed.
              const cond = buildConditionalHeaders({
                etag: cachedPage.etag,
                lastModified: cachedPage.lastModified,
                contentHash: cachedPage.contentHash,
              });
              if (cond["If-None-Match"])
                conditionalHeaders["If-None-Match"] = cond["If-None-Match"];
              if (cond["If-Modified-Since"])
                conditionalHeaders["If-Modified-Since"] = cond["If-Modified-Since"];
            }
          }

          // Network path only: pay the per-host stagger, then announce and fetch.
          // Cache hits above already returned without waiting (#824).
          yield* hostScheduler.waitForDelay(host, delayMs);

          yield* emit({
            type: "page:fetching",
            url: entry.normalizedUrl,
            depth: entry.depth,
            timestamp: Date.now(),
          });

          // Fetch page
          const fetchResult = yield* Effect.either(
            fetchPage(entry.normalizedUrl, {
              userAgent: config.userAgent,
              timeoutMs: config.timeoutMs,
              followRedirects: config.followRedirects,
              // Custom headers first; conditional (If-None-Match / If-Modified-Since) wins on collision.
              headers: { ...config.headers, ...conditionalHeaders },
              fetcher: config.documentFetcher,
              // Stored normalized-source hash so the render-all gate can reuse the
              // cached render when the origin rolls its validators (#839). Its
              // presence also tells the gate a stored page exists, so it probes
              // even when the cached entry had no etag/Last-Modified.
              storedSourceHash: cachedPage?.sourceHash ?? undefined,
              // Forward TLS/status-0 failures + standard-fetch fallbacks to the
              // consumer's hook (CLI/cloud) — the single visibility sink, so
              // events aren't double-logged. (page:failed events also carry the
              // TLS-prefixed message for failed pages.)
              onTlsEvent: config.onTlsEvent,
            }),
          );

          if (fetchResult._tag === "Left") {
            const error = fetchResult.left;
            // 403/429 refusals fail the fetch before any page record exists, so
            // a walled root page leaves 0 stored pages. Count them separately
            // (subset of pagesFailed) so status derivation can say `blocked`
            // instead of a generic empty crawl (#792).
            const blockedFetch = error.type === "blocked" || error.type === "rate_limit";
            yield* storage.updateFrontierStatus(
              crawlId,
              entry.normalizedUrl,
              "failed",
              error.message,
            );
            yield* emit({
              type: "page:failed",
              url: entry.normalizedUrl,
              error: error.message,
              retryable: false,
              depth: entry.depth,
              timestamp: Date.now(),
            });
            yield* updateStats(crawlId, {
              pagesFailed: 1,
              ...(blockedFetch ? { pagesBlocked: 1 } : {}),
            });
            markPrefixFailed(entry.normalizedUrl, entry.depth);
            return;
          }

          const result = fetchResult.right;

          // Handle 304 Not Modified — reuse cached page (conditional-GET hit).
          if (isNotModifiedResponse(result.status)) {
            if (cachedPage) {
              yield* reuseCachedPage(crawlId, entry, cachedPage, "304", {
                cacheFresh: false,
              });
            } else {
              // 304 without a cached body should not happen (we only send
              // conditional headers when we have one), but never leave the
              // frontier entry stuck on "fetching". Emit page:unchanged to keep
              // the event stream aligned with the pagesUnchanged stat bump
              // (consumers/tests rely on that 1:1 correspondence).
              yield* storage.updateFrontierStatus(crawlId, entry.normalizedUrl, "done");
              yield* emit({
                type: "page:unchanged",
                url: entry.normalizedUrl,
                reason: "304",
                depth: entry.depth,
                timestamp: Date.now(),
              });
              yield* updateStats(crawlId, {
                pagesUnchanged: 1,
                cacheHitsByReason: { "304": 1 },
              });
              markPrefixCrawled(entry.normalizedUrl, entry.depth);
            }
            return;
          }

          // Handle error status - save page with error status for broken link detection
          if (result.status >= 400) {
            // Save minimal page record so broken-links rule can detect 4xx/5xx pages
            const errorPageRecord: PageRecord = {
              url: entry.rawUrl,
              normalizedUrl: entry.normalizedUrl,
              finalUrl: result.finalUrl,
              depth: entry.depth,
              parentUrl: entry.parentUrl,
              redirectChain: result.redirectChain,
              status: result.status,
              contentType: result.contentType,
              sizeBytes: 0,
              loadTimeMs: result.loadTime,
              ttfb: result.ttfb,
              downloadTime: result.downloadTime,
              fetchedAt: Date.now(),
              etag: null,
              lastModified: null,
              contentHash: "",
              html: null, // Don't store HTML for error pages
              parsedData: null, // No parsing for error pages
              headers: {
                contentType: result.contentType,
                contentEncoding: null,
                cacheControl: null,
                vary: null,
                etag: null,
                server: null,
                lastModified: null,
                link: null,
                serverTiming: null,
                age: null,
                xCache: null,
                cfCacheStatus: null,
                xVercelCache: null,
                altSvc: null,
                acceptRanges: null,
              },
              securityHeaders: {
                hsts: null,
                csp: null,
                xFrameOptions: null,
                xContentTypeOptions: null,
                referrerPolicy: null,
                permissionsPolicy: null,
                xRobotsTag: null,
              },
              // Which egress/method served this page + any fallback reason (#512).
              fetcherId: result.fetcherId,
              fallbackReason: result.fallbackReason,
            };
            yield* storage.upsertPage(crawlId, errorPageRecord);
            pagesCommitted++;

            yield* storage.updateFrontierStatus(
              crawlId,
              entry.normalizedUrl,
              "failed",
              `HTTP ${result.status}`,
            );
            yield* emit({
              type: "page:failed",
              url: entry.normalizedUrl,
              error: `HTTP ${result.status}`,
              retryable: result.status >= 500,
              depth: entry.depth,
              timestamp: Date.now(),
            });
            yield* updateStats(crawlId, { pagesFailed: 1 });
            markPrefixFailed(entry.normalizedUrl, entry.depth);
            return;
          }

          // Extract change detection metadata
          // Convert ResponseHeaders to Record<string, string> for extractChangeDetection
          const headersRecord: Record<string, string> = {};
          if (result.headers.contentType)
            headersRecord["content-type"] = result.headers.contentType;
          if (result.headers.etag) headersRecord["etag"] = result.headers.etag;
          if (result.headers.lastModified)
            headersRecord["last-modified"] = result.headers.lastModified;
          if (result.headers.cacheControl)
            headersRecord["cache-control"] = result.headers.cacheControl;

          const changeDetection = extractChangeDetection(headersRecord, result.body);

          // Check if content changed (for incremental crawl)
          if (config.incremental && cachedPage) {
            const contentChanged = hasContentChanged(
              {
                etag: cachedPage.etag,
                lastModified: cachedPage.lastModified,
                contentHash: cachedPage.contentHash,
              },
              changeDetection,
            );
            if (!contentChanged) {
              // Content unchanged after a real fetch — reuse cached page (we
              // still spent the request, so this is not a cache-fresh skip).
              // If the render gate computed a fresh normalized-source hash this
              // run, persist it onto the reused row so the NEXT run's probe can
              // hash-match and skip the render entirely (#839). The crawler just
              // deemed the content unchanged, so the hash represents current
              // content and is safe to trust.
              if (result.sourceHash) cachedPage.sourceHash = result.sourceHash;
              yield* reuseCachedPage(crawlId, entry, cachedPage, "hash_match", {
                cacheFresh: false,
              });
              return;
            }
          }

          // Build page record - use headers from result
          const headers: ResponseHeaders = {
            contentType: result.contentType,
            contentEncoding: result.headers.contentEncoding ?? null,
            cacheControl: result.headers.cacheControl ?? null,
            expires: result.headers.expires ?? null,
            vary: result.headers.vary ?? null,
            etag: result.headers.etag ?? null,
            server: result.headers.server ?? null,
            lastModified: changeDetection.lastModified,
            link: result.headers.link ?? null,
            serverTiming: result.headers.serverTiming ?? null,
            age: result.headers.age ?? null,
            xCache: result.headers.xCache ?? null,
            cfCacheStatus: result.headers.cfCacheStatus ?? null,
            xVercelCache: result.headers.xVercelCache ?? null,
            altSvc: result.headers.altSvc ?? null,
            acceptRanges: result.headers.acceptRanges ?? null,
            // security/cookie-flags rule (#748).
            setCookie: result.headers.setCookie ?? null,
          };

          const securityHeaders: SecurityHeaders = {
            hsts: result.securityHeaders.hsts ?? null,
            csp: result.securityHeaders.csp ?? null,
            xFrameOptions: result.securityHeaders.xFrameOptions ?? null,
            xContentTypeOptions: result.securityHeaders.xContentTypeOptions ?? null,
            referrerPolicy: result.securityHeaders.referrerPolicy ?? null,
            permissionsPolicy: result.securityHeaders.permissionsPolicy ?? null,
            xRobotsTag: result.securityHeaders.xRobotsTag ?? null,
          };

          // Parse and discover URLs if HTML (before storing page)
          let parsedData: string | null = null;
          if (
            isHtmlContentType(result.contentType) ||
            (!result.contentType && looksLikeHtml(result.body))
          ) {
            // Parse page data once (includes parseDocument internally)
            const parsed = parsePage(result.body, result.finalUrl);

            // Retain the live ParsedPage so a same-process audit reuses its
            // DOM (#267) — capped: each retained DOM costs MBs for the rest
            // of the crawl while the re-parse it saves costs ~12.5ms, so on
            // 100+ page crawls unbounded retention trades GBs for ~1s (#858).
            if (
              options.parsedPageCache &&
              options.parsedPageCache.size < PARSED_PAGE_CACHE_MAX_PAGES
            ) {
              options.parsedPageCache.set(entry.normalizedUrl, parsed);
            }

            // Reuse document for URL extraction (no second parse)
            // Note: document can be null for error pages (4xx/5xx)
            // Skip link discovery in quick mode unless no sitemap URLs found
            const shouldDiscoverLinks =
              !config.disableLinkDiscovery || config.sitemapPendingCount === 0;
            if (parsed.document && shouldDiscoverLinks) {
              const crawlableUrls = extractCrawlableUrls(parsed.document, result.finalUrl);

              for (const url of crawlableUrls) {
                yield* enqueueUrl(crawlId, url, entry.depth + 1, entry.normalizedUrl, "discovered");
              }
            }

            // Remove document (not serializable) before storing
            const { document: _doc, ...serializableParsed } = parsed;
            parsedData = JSON.stringify(serializableParsed);
          }

          const pageRecord: PageRecord = {
            url: entry.rawUrl,
            normalizedUrl: entry.normalizedUrl,
            finalUrl: result.finalUrl,
            depth: entry.depth,
            parentUrl: entry.parentUrl,
            redirectChain: result.redirectChain,
            status: result.status,
            contentType: result.contentType,
            sizeBytes: result.sizeBytes,
            loadTimeMs: result.loadTime,
            ttfb: result.ttfb,
            downloadTime: result.downloadTime,
            fetchedAt: Date.now(),
            etag: changeDetection.etag,
            lastModified: changeDetection.lastModified,
            contentHash: changeDetection.contentHash,
            html: result.body,
            parsedData, // Parsed above if HTML
            headers,
            securityHeaders,
            // Persist the request headers we varied on so a future audit can
            // honor this response's Vary header for cache keying.
            requestHeaders: requestContext,
            // Which egress/method served this page + any fallback reason (#512).
            fetcherId: result.fetcherId,
            fallbackReason: result.fallbackReason,
            // Normalized-source hash from the render-all gate's probe, when it
            // rendered — persisted so the next re-run can reuse this render (#839).
            sourceHash: result.sourceHash,
          };

          yield* storage.upsertPage(crawlId, pageRecord);
          pagesCommitted++;
          yield* storage.updateFrontierStatus(crawlId, entry.normalizedUrl, "done");

          yield* emit({
            type: "page:fetched",
            url: entry.normalizedUrl,
            status: result.status,
            loadTimeMs: result.loadTime,
            sizeBytes: result.sizeBytes,
            depth: entry.depth,
            timestamp: Date.now(),
            renderTimeMs: result.renderTimeMs,
            queueWaitMs: result.queueWaitMs,
          });

          yield* updateStats(crawlId, {
            pagesFetched: 1,
            bytesTotal: result.sizeBytes,
          });

          markPrefixCrawled(entry.normalizedUrl, entry.depth);

          // Update pattern stats for surface + quick mode
          if (config.coverageMode === "surface" || config.coverageMode === "quick") {
            markPatternCrawled(patternStats, entry.normalizedUrl);
          }

          // Emit progress
          yield* emitProgress(crawlId);
        }).pipe(Effect.ensuring(hostScheduler.release(host)));
      });

    // ----------------------------------------
    // Stats Helpers
    // ----------------------------------------

    const updateStats = (
      crawlId: string,
      updates: Partial<CrawlStats>,
    ): Effect.Effect<void, StorageError, never> =>
      Effect.gen(function* () {
        const current = yield* storage.getStats(crawlId);
        if (!current) return;

        const newStats: CrawlStats = {
          ...current,
          pagesTotal:
            current.pagesTotal +
            (updates.pagesFetched ?? 0) +
            (updates.pagesFailed ?? 0) +
            (updates.pagesSkipped ?? 0) +
            (updates.pagesUnchanged ?? 0),
          pagesFetched: current.pagesFetched + (updates.pagesFetched ?? 0),
          pagesFailed: current.pagesFailed + (updates.pagesFailed ?? 0),
          pagesBlocked: (current.pagesBlocked ?? 0) + (updates.pagesBlocked ?? 0),
          pagesSkipped: current.pagesSkipped + (updates.pagesSkipped ?? 0),
          pagesUnchanged: current.pagesUnchanged + (updates.pagesUnchanged ?? 0),
          pagesCacheFresh: (current.pagesCacheFresh ?? 0) + (updates.pagesCacheFresh ?? 0),
          bytesCacheSaved: (current.bytesCacheSaved ?? 0) + (updates.bytesCacheSaved ?? 0),
          cacheHitsByReason: mergeCacheHitsByReason(
            current.cacheHitsByReason,
            updates.cacheHitsByReason,
          ),
          bytesTotal: current.bytesTotal + (updates.bytesTotal ?? 0),
        };

        // Update average load time
        if (updates.pagesFetched && newStats.pagesFetched > 0) {
          // Simplified average update (could be more accurate with running average)
        }

        yield* storage.updateStats(crawlId, newStats);
      });

    const emitProgress = (crawlId: string): Effect.Effect<void, StorageError, never> =>
      Effect.gen(function* () {
        const stats = yield* storage.getStats(crawlId);
        if (!stats) return;

        const pending = yield* storage.getPendingCount(crawlId);

        yield* emit({
          type: "progress",
          fetched: stats.pagesFetched,
          pending,
          failed: stats.pagesFailed,
          skipped: stats.pagesSkipped,
          unchanged: stats.pagesUnchanged,
          total: stats.pagesTotal,
          bytesTotal: stats.bytesTotal,
          avgLoadTimeMs: stats.avgLoadTimeMs,
          timestamp: Date.now(),
        });
      });

    // ----------------------------------------
    // Crawl Loop
    // ----------------------------------------

    const runCrawlLoop = (
      crawlId: string,
    ): Effect.Effect<void, CrawlerError | StorageError, never> =>
      Effect.gen(function* () {
        const startTime = Date.now();
        // Fresh stop signal for this run — stop() completes it to arm the
        // grace-then-interrupt hard cap below (#923).
        stopSignal = yield* Deferred.make<void, never>();
        const runStopSignal = stopSignal;
        // Seed the in-memory page count from storage: 0 on a fresh start, N on resume.
        pagesCommitted = yield* storage.getPageCount(crawlId);
        // Streaming worker pool: a fixed pool of `concurrency` workers, each
        // pulling the next eligible URL from the frontier as soon as it frees
        // up. No batch barrier — one slow fetch (e.g. a 35s cloud render)
        // never stalls unrelated URLs, and links discovered mid-flight become
        // fetchable immediately. Per-host parallelism + politeness delays are
        // still enforced by the host scheduler inside processUrl.
        const workerCount = Math.max(1, config.concurrency);

        // Watchdog: a single fetch is bounded by per-fetch timeout × retries
        // plus host delays — far below this ceiling. If it still doesn't
        // return, something is wedged (scheduler, DNS, blackholed socket) and
        // we'd otherwise hang the whole audit forever.
        const urlTimeoutMs = Math.max(120_000, config.timeoutMs * 6);

        // Shared pool state. Fibers in this loop run on a single JS thread,
        // so plain mutation between yields is safe; the dispatch lock below
        // makes the read-check-pop sequence atomic across workers.
        let stopRequested = false;
        // URLs dispatched to a worker and not yet finished. Each in-flight
        // URL may produce at most one page, so budget checks reserve
        // `pageCount + inFlight` against maxPages — never overshooting even
        // when all workers dispatch near the cap (failures free the budget).
        let inFlight = 0;
        // Zero-success circuit breaker. Finishing this many attempts having
        // stored ZERO pages means the site (or the local page store) is
        // rejecting every page — stop now instead of grinding the whole
        // frontier to the wall-clock backstop, which also keeps dispatching
        // (and, in render mode, paying for) doomed pages. Disarms the instant
        // any page commits, so a healthy site with a few early failures is
        // unaffected. Sized above one worker wave. Guards the systematic
        // per-page failure class (e.g. the #839 source_hash migration gap that
        // made every upsertPage throw).
        const zeroSuccessAbortThreshold = Math.max(8, config.concurrency * 2);
        let attemptsFinished = 0;
        // Tracks how long we've been waiting on "fetching" rows that no
        // in-process fiber owns (orphaned by a crash/interrupt) — the pool
        // would otherwise spin on sleep indefinitely.
        let stallSince: number | null = null;
        // Batch-popped URLs awaiting dispatch (#314): popped k-at-a-time under
        // the lock to amortize the priority SELECT+UPDATE tx, counted in
        // `inFlight` at pop time, then drained one per dispatch. On interrupt
        // these stay `fetching` like any dying in-flight fetch — the stall
        // watchdog below reclaims orphaned `fetching` rows.
        const dispatchBuffer: FrontierRecord[] = [];

        const dispatchLock = yield* Effect.makeSemaphore(1);

        type Dispatch =
          | { readonly kind: "url"; readonly entry: FrontierRecord }
          | { readonly kind: "wait" }
          | { readonly kind: "done" };

        // Atomically: drain a buffered URL, else check budget and pop a fresh
        // batch (clamped to the remaining maxPages reservation), reserving an
        // in-flight slot per popped URL. Serialized so concurrent workers can't
        // collectively overshoot maxPages on a stale page count.
        const nextDispatch: Effect.Effect<Dispatch, StorageError, never> = dispatchLock.withPermits(
          1,
        )(
          Effect.gen(function* () {
            // Already-popped (already-reserved) URLs dispatch first.
            const buffered = dispatchBuffer.shift();
            if (buffered) {
              return { kind: "url", entry: buffered } as const;
            }

            if (pagesCommitted >= config.maxPages) {
              logger.debug("max pages reached", `${pagesCommitted}/${config.maxPages}`);
              stopRequested = true;
              return { kind: "done" } as const;
            }
            // Budget not yet reserved by committed pages or in-flight fetches.
            // Pop at most this many so a batch never overshoots the cap (a
            // failed fetch later frees its reservation).
            const budget = config.maxPages - pagesCommitted - inFlight;
            if (budget <= 0) {
              // Budget fully reserved by in-flight fetches — wait for one to
              // free its slot.
              return { kind: "wait" } as const;
            }
            // budget > 0 here; the floor of 1 only guards a misconfigured concurrency <= 0.
            const batchSize = Math.min(Math.max(1, config.concurrency), budget);

            // Cap per host so a single host can't fill the batch while its
            // per-host throttle stalls the extra workers (#440). Floor at 1 so
            // a misconfigured perHostConcurrency <= 0 stays capped (fail safe)
            // instead of silently going uncapped.
            const entries = yield* storage.popNextUrls(
              crawlId,
              batchSize,
              Math.max(1, config.perHostConcurrency),
            );
            const first = entries[0];
            if (!first) {
              if (inFlight > 0) {
                // Workers are still fetching; they may discover new links.
                stallSince = null;
                return { kind: "wait" } as const;
              }
              const fetchingCount = yield* storage.getFetchingCount(crawlId);
              if (fetchingCount === 0) {
                // Frontier drained and nothing in flight — done!
                return { kind: "done" } as const;
              }
              // Orphaned "fetching" rows (no fiber in this pool owns them)
              // can never complete — finish with partial results instead of
              // spinning forever.
              stallSince ??= Date.now();
              if (Date.now() - stallSince > urlTimeoutMs) {
                logger.warn(
                  "crawl stalled",
                  `${fetchingCount} url(s) stuck in fetching state — finishing with partial results`,
                );
                stopRequested = true;
                return { kind: "done" } as const;
              }
              return { kind: "wait" } as const;
            }

            stallSince = null;
            inFlight += entries.length;
            // Dispatch the highest-priority entry; buffer the rest in priority
            // order for subsequent lock acquisitions.
            if (entries.length > 1) {
              dispatchBuffer.push(...entries.slice(1));
            }
            return { kind: "url", entry: first } as const;
          }),
        );

        // Per-URL watchdog interrupts a wedged fetch and marks it failed so
        // the frontier keeps draining and the crawl ends.
        const processEntry = (entry: FrontierRecord): Effect.Effect<void, never, never> =>
          processUrl(crawlId, entry).pipe(
            Effect.timeout(Duration.millis(urlTimeoutMs)),
            Effect.catchTag("TimeoutException", () =>
              Effect.gen(function* () {
                logger.warn(
                  "url watchdog fired",
                  `${entry.normalizedUrl} interrupted after ${urlTimeoutMs}ms`,
                );
                yield* storage.getFrontierEntry(crawlId, entry.normalizedUrl).pipe(
                  Effect.flatMap((row) =>
                    row?.status === "fetching"
                      ? storage.updateFrontierStatus(
                          crawlId,
                          entry.normalizedUrl,
                          "failed",
                          "watchdog timeout",
                        )
                      : Effect.void,
                  ),
                  Effect.catchAll(() => Effect.void),
                );
              }),
            ),
            Effect.catchAll((error) => {
              logger.debug("process error", entry.normalizedUrl, error.message);
              return storage
                .updateFrontierStatus(crawlId, entry.normalizedUrl, "failed", error.message)
                .pipe(Effect.catchAll(() => Effect.void));
            }),
          );

        const worker: Effect.Effect<void, StorageError, never> = Effect.gen(function* () {
          while (true) {
            // Check if stopped (in-flight fetches in other workers finish)
            if (!isRunning || stopRequested) {
              return;
            }

            // Check if paused
            if (isPaused) {
              yield* Effect.sleep(Duration.millis(100));
              continue;
            }

            const dispatch = yield* nextDispatch;
            if (dispatch.kind === "done") {
              return;
            }
            if (dispatch.kind === "wait") {
              yield* Effect.sleep(Duration.millis(50));
              continue;
            }

            yield* processEntry(dispatch.entry).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  inFlight--;
                }),
              ),
            );

            // Trip the zero-success breaker after the attempt settles (so a
            // page committed this round disarms it). pagesCommitted is bumped
            // by processUrl on a successful store.
            attemptsFinished++;
            if (
              !stopRequested &&
              pagesCommitted === 0 &&
              attemptsFinished >= zeroSuccessAbortThreshold
            ) {
              stopRequested = true;
              logger.warn(
                "crawl aborted",
                `${attemptsFinished} pages attempted, none stored — the site or local page store is rejecting every page; stopping instead of draining the frontier`,
              );
            }
          }
        });

        // Run the pool; workers exit individually when the frontier is
        // drained, maxPages is reached, or the crawl is stopped.
        const pool = Effect.all(
          Array.from({ length: workerCount }, () => worker),
          { concurrency: "unbounded", discard: true },
        );

        // Hard-cap the crawl on stop() (#923): the backstop timer sets
        // isRunning=false so idle workers exit at their loop-top check, but a
        // worker wedged INSIDE an in-flight fetch is only unwound by the ~180s
        // per-URL watchdog — a second multiple of the wall-clock budget. Race
        // the pool against "stop signalled + a bounded grace window"; if that
        // wins, the pool is interrupted, tearing down every in-flight fiber
        // (each releases its host slot via Effect.ensuring). Normal completion
        // wins the race well before the grace elapses, so unwedged crawls are
        // unaffected.
        const stopGuard = Effect.zipRight(
          Deferred.await(runStopSignal),
          Effect.sleep(Duration.millis(config.stopGraceMs)),
        );
        yield* Effect.raceFirst(pool, stopGuard);

        // Crawl loop exited. Distinguish a clean drain from a backstop
        // hard-interrupt (#969): stop() clears isRunning before it can win the
        // grace race OR make idle workers exit at their loop-top check, so
        // isRunning===false here means the loop was cut short mid-frontier, not
        // that the whole site was crawled. (The epilogue itself only clears
        // isRunning below, after this write, so nothing else can have cleared it
        // yet.) Give that its own terminal status so a direct CrawlStorage
        // consumer can't read a partial crawl as "completed". Both backstop
        // callers — the CLI controller and audit-engine's cloud-runner — still
        // overwrite this from their own crawlPhaseStopped flag right after
        // start() returns, so their behavior is unchanged.
        const wasStopped = !isRunning;
        const stats = yield* storage.getStats(crawlId);
        const durationMs = Date.now() - startTime;

        yield* storage.updateCrawl(crawlId, {
          status: wasStopped ? "stopped" : "completed",
          completedAt: Date.now(),
        });

        yield* emit({
          type: "completed",
          stats: stats ?? {
            pagesTotal: 0,
            pagesFetched: 0,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
          durationMs,
          timestamp: Date.now(),
        });

        // Log crawl completion (file-only, use debug level)
        logger.debug("crawl completed", {
          crawlId,
          durationMs,
          pagesFetched: stats?.pagesFetched ?? 0,
          pagesFailed: stats?.pagesFailed ?? 0,
          pagesSkipped: stats?.pagesSkipped ?? 0,
          bytesTotal: stats?.bytesTotal ?? 0,
        });

        isRunning = false;
      });

    // ----------------------------------------
    // Crawler Methods
    // ----------------------------------------

    /**
     * Detect and follow both HTTP and client-side redirects
     * Returns the final URL after following up to MAX_REDIRECTS hops
     */
    const detectRedirects = (targetUrl: string): Effect.Effect<string, never, never> =>
      Effect.promise(async () => {
        try {
          const MAX_REDIRECTS = 10;
          const REDIRECT_TIMEOUT_MS = 10_000;
          let currentUrl = targetUrl;
          const visited = new Set<string>();

          for (let i = 0; i < MAX_REDIRECTS; i++) {
            // Prevent loops
            if (visited.has(currentUrl)) {
              logger.debug("redirect loop detected, stopping", currentUrl);
              break;
            }
            visited.add(currentUrl);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS);
            const response = await fetch(currentUrl, {
              method: "GET",
              signal: controller.signal,
              redirect: "follow",
            }).finally(() => clearTimeout(timeout));

            // Check if HTTP redirect occurred
            if (response.url !== currentUrl) {
              logger.debug("HTTP redirect", currentUrl, "→", response.url);
              currentUrl = response.url;
              continue;
            }

            // Check for client-side redirects (meta refresh, JS)
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("text/html")) {
              const html = await response.text();
              const clientRedirect = findClientRedirects(html, currentUrl);

              if (clientRedirect && clientRedirect !== currentUrl) {
                logger.debug("client-side redirect", currentUrl, "→", clientRedirect);
                currentUrl = clientRedirect;
                continue;
              }
            }

            // No more redirects
            break;
          }

          return currentUrl;
        } catch (error) {
          // Log error before falling back
          logger.debug("redirect detection failed", targetUrl, error);
          return targetUrl;
        }
      });

    const start = (
      targetUrl: string,
      originalUrl?: string,
    ): Effect.Effect<string, CrawlerError | StorageError, never> =>
      Effect.gen(function* () {
        // Follow redirects to get final URL (both HTTP and client-side)
        const finalTargetUrl = yield* detectRedirects(targetUrl);
        // Use provided originalUrl or fall back to targetUrl for backwards compat
        const userProvidedUrl = originalUrl || targetUrl;

        if (finalTargetUrl !== targetUrl) {
          logger.debug("final URL after redirects", targetUrl, "→", finalTargetUrl);

          // Warn if cross-domain redirect
          const originalOrigin = new URL(targetUrl).origin;
          const finalOrigin = new URL(finalTargetUrl).origin;
          if (originalOrigin !== finalOrigin) {
            logger.warn("cross-domain redirect detected", originalOrigin, "→", finalOrigin);
          }
        }

        baseUrl = new URL(finalTargetUrl).origin;

        // Reset breadth-first state for new crawl
        prefixStats.clear();
        pendingDepth1Count = 0;

        // Reset pattern stats for new crawl
        clearPatternStats(patternStats);

        // Create crawl session
        const crawlId = yield* storage.createCrawl({
          baseUrl,
          seedUrl: finalTargetUrl,
          originalUrl: userProvidedUrl,
          startedAt: Date.now(),
          status: "running",
          config: {
            maxPages: config.maxPages,
            concurrency: config.concurrency,
            perHostConcurrency: config.perHostConcurrency,
            delayMs: config.delayMs,
            perHostDelayMs: config.perHostDelayMs,
            timeoutMs: config.timeoutMs,
            userAgent: config.userAgent,
            followRedirects: config.followRedirects,
            respectRobots: config.respectRobots,
            incremental: config.incremental,
            include: config.include,
            exclude: config.exclude,
            allowQueryParams: config.allowQueryParams,
            dropQueryPrefixes: config.dropQueryPrefixes,
            allowedDomains: config.allowedDomains,
          },
          stats: {
            pagesTotal: 0,
            pagesFetched: 0,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
        });

        currentCrawlId = crawlId;
        isRunning = true;
        isPaused = false;

        yield* emit({
          type: "started",
          crawlId,
          baseUrl,
          timestamp: Date.now(),
        });

        // Log crawl start with config (file-only, use debug level)
        logger.debug("crawl started", {
          crawlId,
          baseUrl,
          maxPages: config.maxPages,
          concurrency: config.concurrency,
          perHostConcurrency: config.perHostConcurrency,
          delayMs: config.delayMs,
          incremental: config.incremental,
          respectRobots: config.respectRobots,
        });

        // Fetch robots.txt — ALWAYS, regardless of respectRobots (#790):
        // sitemap discovery and the crawl/robots-txt rule need it. Only
        // Disallow enforcement and Crawl-delay honoring are conditional.
        const robotsResult = yield* Effect.either(
          fetchRobots(baseUrl, config.userAgent, true, config.headers),
        );
        if (robotsResult._tag === "Right") {
          robots = robotsResult.right;

          // Store robots.txt data
          yield* storage.setRobotsTxt(crawlId, {
            url: `${baseUrl}/robots.txt`,
            exists: robotsResult.right.data.exists,
            content: robotsResult.right.data.content,
            sizeBytes: robotsResult.right.data.sizeBytes,
            sitemaps: robotsResult.right.data.sitemaps,
            fetchedAt: Date.now(),
          });
        }

        // Fetch llms.txt + llms-full.txt at the root once, independent of robots.
        const llms = yield* fetchLlmsTxt(baseUrl, config.userAgent, config.headers);
        yield* storage.setLlmsTxt(crawlId, {
          llmsTxt: {
            url: llms.llmsTxt.url,
            exists: llms.llmsTxt.exists,
            content: llms.llmsTxt.content,
            sizeBytes: llms.llmsTxt.sizeBytes,
          },
          llmsFullTxt: {
            url: llms.llmsFullTxt.url,
            exists: llms.llmsFullTxt.exists,
            content: llms.llmsFullTxt.content,
            sizeBytes: llms.llmsFullTxt.sizeBytes,
          },
          fetchedAt: Date.now(),
        });

        // Probe homepage markdown content-negotiation + .md variant once.
        const markdown = yield* probeMarkdownResponse(baseUrl, config.userAgent, config.headers);
        yield* storage.setMarkdownProbe(crawlId, { ...markdown, fetchedAt: Date.now() });

        // AX prefetches: well-known/agent files, homepage access under AI-crawler
        // UAs, and RSL licensing — fetched unconditionally like llms/markdown.
        const wellKnown = yield* probeWellKnown(baseUrl, config.userAgent, config.headers);
        yield* storage.setWellKnownProbe(crawlId, { ...wellKnown, fetchedAt: Date.now() });

        const agentAccess = yield* probeAgentAccess(baseUrl, config.userAgent, config.headers);
        yield* storage.setAgentAccess(crawlId, { ...agentAccess, fetchedAt: Date.now() });

        const rsl = yield* fetchRslLicensing(baseUrl, config.userAgent, config.headers);
        yield* storage.setRsl(crawlId, { ...rsl, fetchedAt: Date.now() });

        // Discover and fetch sitemaps (from robots.txt and common locations)
        // Cap sitemap ingestion relative to the crawl budget — huge sites
        // (news sites etc.) publish 100k+ URLs across thousands of child
        // sitemaps, but we only ever crawl maxPages. Without a cap,
        // fetching every child sitemap and enqueueing every URL row-by-row
        // into SQLite takes 10+ minutes before the crawl even starts.
        const sitemapUrlCap = computeSitemapUrlCap(config.maxPages);
        logger.debug("discovering sitemaps", `url cap ${sitemapUrlCap}`);
        const robotsData = robots?.data ?? null;
        const sitemapResult = yield* discoverSitemaps(
          baseUrl,
          robotsData
            ? {
                exists: robotsData.exists,
                url: `${baseUrl}/robots.txt`,
                content: robotsData.content,
                sizeBytes: robotsData.sizeBytes,
                sitemaps: robotsData.sitemaps,
                rules: [],
                errors: [],
              }
            : null,
          config.userAgent,
          { maxUrls: sitemapUrlCap, customHeaders: config.headers },
        );

        const sitemapByUrl = new Map(sitemapResult.all.map((sitemap) => [sitemap.url, sitemap]));

        const computeAggregateUrlCount = (sitemap: SitemapData, visited: Set<string>): number => {
          if (visited.has(sitemap.url)) {
            logger.debug("circular sitemap reference", sitemap.url);
            return 0;
          }
          visited.add(sitemap.url);

          let total = sitemap.urlCount;
          if (sitemap.type === "index") {
            for (const childUrl of sitemap.childSitemaps) {
              const child = sitemapByUrl.get(childUrl);
              if (child) {
                total += computeAggregateUrlCount(child, visited);
              }
            }
          }

          return total;
        };

        // Store ALL sitemaps (including children) so they can be validated
        // For top-level sitemap indices, compute aggregated URL count
        const discoveredSet = new Set(sitemapResult.discovered.map((s) => s.url));
        for (const sitemap of sitemapResult.all) {
          const isTopLevel = discoveredSet.has(sitemap.url);
          const totalUrls =
            isTopLevel && sitemap.type === "index"
              ? computeAggregateUrlCount(sitemap, new Set())
              : sitemap.urlCount;

          yield* storage.addSitemap(crawlId, {
            url: sitemap.url,
            type: sitemap.type,
            urlCount: totalUrls,
            childSitemaps: sitemap.childSitemaps,
            errors: sitemap.errors,
            fetchedAt: Date.now(),
          });

          // Store sitemap URLs for coverage checking
          if (sitemap.urls.length > 0) {
            yield* storage.addSitemapUrls(
              crawlId,
              sitemap.urls.map((u) => ({
                sitemapUrl: sitemap.url,
                loc: u.loc,
                lastmod: u.lastmod,
                changefreq: u.changefreq,
                priority: u.priority,
              })),
            );
          }
        }

        // Seed pages holding open carried findings ahead of generic discovery so
        // their findings get re-checked within budget (#1146). Enqueued BEFORE
        // sitemaps so that when a carried page is also a sitemap URL, the carried
        // (higher-priority) entry wins the frontier dedup. Budget-capped upstream
        // so new-page discovery is never starved.
        for (const carriedUrl of config.carriedSeedUrls ?? []) {
          yield* enqueueUrl(crawlId, carriedUrl, 0, undefined, "carried");
        }
        // Baseline so sitemapPendingCount below counts ONLY sitemap URLs that
        // became pending, not the carried seeds just enqueued (#123 re-enable
        // logic keys off a genuinely-empty sitemap result).
        const preSitemapPendingCount = yield* storage.getPendingCount(crawlId);

        // Enqueue URLs from ALL sitemaps (including children) for crawling.
        // Round-robin across sitemaps (capped) so coverage modes sample
        // every section instead of just the first sitemap file.
        const sitemapUrlsToEnqueue = selectSitemapUrls(sitemapResult.all, sitemapUrlCap);
        for (const sitemapUrl of sitemapUrlsToEnqueue) {
          yield* enqueueUrl(crawlId, sitemapUrl.loc, 0, undefined, "sitemap", sitemapUrl.priority);
        }
        config.sitemapUrlCount = sitemapUrlsToEnqueue.length;
        // How many sitemap URLs actually became pending after robots/scope
        // filtering (the seed is not enqueued yet). If 0 — every sitemap URL
        // was filtered — link discovery is re-enabled below so a fetchable
        // seed can still seed the frontier, preventing an empty/under-crawl on
        // prerender/CSR sites that disallow sitemap paths. See issue #123.
        config.sitemapPendingCount =
          (yield* storage.getPendingCount(crawlId)) - preSitemapPendingCount;
        logger.debug(
          "sitemaps discovered and stored",
          `${sitemapResult.discovered.length} discovered, ${sitemapResult.all.length} total, ${config.sitemapPendingCount}/${config.sitemapUrlCount} enqueued (rest filtered)`,
        );

        // Seed the crawl queue
        yield* enqueueUrl(crawlId, finalTargetUrl, 0, undefined, "seed");

        // If nothing is pending after sitemaps + seed, every candidate URL was
        // filtered (robots.txt / scope). The crawl loop terminates cleanly
        // (pending == 0 && inFlight == 0), but log a clear reason so this reads
        // as a deliberate finish, not a silent hang. See issue #123.
        const pendingAfterSeed = yield* storage.getPendingCount(crawlId);
        if (pendingAfterSeed === 0) {
          logger.warn(
            "nothing to crawl",
            `${config.sitemapUrlCount} sitemap URL(s) and the seed were filtered (robots.txt/scope) — finishing with no pages`,
          );
        }

        // Run crawl loop synchronously (returns when complete)
        yield* runCrawlLoop(crawlId);

        return crawlId;
      });

    const pause = (): Effect.Effect<void, CrawlerError, never> =>
      Effect.gen(function* () {
        isPaused = true;
        yield* PubSub.publish(eventHub, {
          type: "paused",
          reason: "user_requested",
          timestamp: Date.now(),
        });
      });

    const resume = (): Effect.Effect<void, CrawlerError, never> =>
      Effect.gen(function* () {
        isPaused = false;
        yield* PubSub.publish(eventHub, {
          type: "resumed",
          timestamp: Date.now(),
        });
      });

    const stop = (): Effect.Effect<void, CrawlerError, never> =>
      Effect.gen(function* () {
        isRunning = false;
        // Arm the crawl loop's grace-then-interrupt hard cap (#923). Idempotent:
        // succeed on an already-completed Deferred is a no-op.
        if (stopSignal) {
          yield* Deferred.succeed(stopSignal, undefined);
        }
        if (currentCrawlId) {
          yield* storage
            .updateCrawl(currentCrawlId, { status: "paused" })
            .pipe(Effect.catchAll(() => Effect.void));
        }
      });

    const resumeFromStorage = (
      crawlId: string,
    ): Effect.Effect<void, CrawlerError | StorageError, never> =>
      Effect.gen(function* () {
        const crawl = yield* storage.getCrawl(crawlId);
        if (!crawl) {
          return yield* Effect.fail(new CrawlerError("UNKNOWN", `Crawl not found: ${crawlId}`));
        }

        baseUrl = crawl.baseUrl;
        currentCrawlId = crawlId;
        isRunning = true;
        isPaused = false;

        // Restore config from crawl
        Object.assign(config, crawl.config);

        // Fetch robots.txt again — always, regardless of respectRobots (#790).
        const robotsResult = yield* Effect.either(
          fetchRobots(baseUrl, config.userAgent, true, config.headers),
        );
        if (robotsResult._tag === "Right") {
          robots = robotsResult.right;

          // Store robots.txt data — matches start()/restartCrawl() so a
          // resumed crawl's crawl/robots-txt rule + report data stay current.
          yield* storage.setRobotsTxt(crawlId, {
            url: `${baseUrl}/robots.txt`,
            exists: robotsResult.right.data.exists,
            content: robotsResult.right.data.content,
            sizeBytes: robotsResult.right.data.sizeBytes,
            sitemaps: robotsResult.right.data.sitemaps,
            fetchedAt: Date.now(),
          });
        }

        // Reset stale 'fetching' entries (from interrupted crawl) back to 'pending'
        const resetCount = yield* storage.resetStaleFetching(crawlId);
        if (resetCount > 0) {
          logger.debug("reset stale fetching entries", resetCount);
        }

        // Load the frontier once — shared by the gate restore and breadth-first rebuild.
        const needFrontier = config.disableLinkDiscovery || config.breadthFirst;
        const frontierEntries = needFrontier ? yield* storage.getAllFrontierEntries(crawlId) : [];

        // (#133) sitemapPendingCount isn't persisted; recompute from the frontier
        // so quick mode stays gated on resume (else it re-enables link discovery).
        if (config.disableLinkDiscovery) {
          const gate = sitemapGateFromFrontier(frontierEntries);
          config.sitemapUrlCount = gate.sitemapUrlCount;
          config.sitemapPendingCount = gate.sitemapPendingCount;
          logger.debug(
            "restored sitemap-discovery gate",
            `${gate.sitemapPendingCount}/${gate.sitemapUrlCount} sitemap URL(s) pending`,
          );
        }

        // Rebuild breadth-first state from existing frontier entries
        if (config.breadthFirst) {
          prefixStats.clear();
          pendingDepth1Count = 0;

          for (const entry of frontierEntries) {
            const prefix = getPathPrefix(entry.normalizedUrl);
            const stats = prefixStats.get(prefix) ?? { crawled: 0, queued: 0 };

            if (
              entry.status === "done" ||
              entry.status === "failed" ||
              entry.status === "skipped"
            ) {
              stats.crawled++;
            } else if (entry.status === "pending") {
              stats.queued++;
              if (entry.depth === 1) {
                pendingDepth1Count++;
              }
            }

            prefixStats.set(prefix, stats);
          }

          logger.debug(
            "restored breadth-first state",
            `prefixes=${prefixStats.size}`,
            `pendingDepth1=${pendingDepth1Count}`,
          );
        }

        // Update crawl status
        yield* storage.updateCrawl(crawlId, { status: "running" });

        yield* emit({
          type: "resumed",
          timestamp: Date.now(),
        });

        // Run crawl loop synchronously
        yield* runCrawlLoop(crawlId);
      });

    const restartCrawl = (
      crawlId: string,
      newConfig: Partial<CrawlerConfig>,
    ): Effect.Effect<string, CrawlerError | StorageError, never> =>
      Effect.gen(function* () {
        const crawl = yield* storage.getCrawl(crawlId);
        if (!crawl) {
          return yield* Effect.fail(new CrawlerError("UNKNOWN", `Crawl not found: ${crawlId}`));
        }

        baseUrl = crawl.baseUrl;
        currentCrawlId = crawlId;
        isRunning = true;
        isPaused = false;

        // Merge new config with existing
        const mergedConfig = { ...crawl.config, ...newConfig };
        Object.assign(config, mergedConfig);

        // Update crawl with new config
        yield* storage.updateCrawl(crawlId, {
          config: mergedConfig,
          status: "running",
          startedAt: Date.now(),
          completedAt: undefined,
          stats: {
            pagesTotal: 0,
            pagesFetched: 0,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
        });

        // Clear all crawl data for fresh start (prevents stale data in reports)
        yield* storage.clearCrawlData(crawlId);

        yield* emit({
          type: "started",
          crawlId,
          baseUrl,
          timestamp: Date.now(),
        });

        // Log crawl resume (file-only, use debug level)
        logger.debug("crawl resumed", {
          crawlId,
          baseUrl,
          maxPages: config.maxPages,
        });

        // Fetch robots.txt — always, regardless of respectRobots (#790).
        const robotsResult = yield* Effect.either(
          fetchRobots(baseUrl, config.userAgent, true, config.headers),
        );
        if (robotsResult._tag === "Right") {
          robots = robotsResult.right;

          yield* storage.setRobotsTxt(crawlId, {
            url: `${baseUrl}/robots.txt`,
            exists: robotsResult.right.data.exists,
            content: robotsResult.right.data.content,
            sizeBytes: robotsResult.right.data.sizeBytes,
            sitemaps: robotsResult.right.data.sitemaps,
            fetchedAt: Date.now(),
          });

          for (const sitemapUrl of robots.data.sitemaps) {
            logger.debug("sitemap discovered", sitemapUrl);
          }
        }

        // Fetch llms.txt + llms-full.txt at the root once, independent of robots.
        const llms = yield* fetchLlmsTxt(baseUrl, config.userAgent, config.headers);
        yield* storage.setLlmsTxt(crawlId, {
          llmsTxt: {
            url: llms.llmsTxt.url,
            exists: llms.llmsTxt.exists,
            content: llms.llmsTxt.content,
            sizeBytes: llms.llmsTxt.sizeBytes,
          },
          llmsFullTxt: {
            url: llms.llmsFullTxt.url,
            exists: llms.llmsFullTxt.exists,
            content: llms.llmsFullTxt.content,
            sizeBytes: llms.llmsFullTxt.sizeBytes,
          },
          fetchedAt: Date.now(),
        });

        // Probe homepage markdown content-negotiation + .md variant once.
        const markdown = yield* probeMarkdownResponse(baseUrl, config.userAgent, config.headers);
        yield* storage.setMarkdownProbe(crawlId, { ...markdown, fetchedAt: Date.now() });

        // AX prefetches: well-known/agent files, homepage access under AI-crawler
        // UAs, and RSL licensing — fetched unconditionally like llms/markdown.
        const wellKnown = yield* probeWellKnown(baseUrl, config.userAgent, config.headers);
        yield* storage.setWellKnownProbe(crawlId, { ...wellKnown, fetchedAt: Date.now() });

        const agentAccess = yield* probeAgentAccess(baseUrl, config.userAgent, config.headers);
        yield* storage.setAgentAccess(crawlId, { ...agentAccess, fetchedAt: Date.now() });

        const rsl = yield* fetchRslLicensing(baseUrl, config.userAgent, config.headers);
        yield* storage.setRsl(crawlId, { ...rsl, fetchedAt: Date.now() });

        // Seed the crawl queue with root URL
        yield* enqueueUrl(crawlId, baseUrl, 0, undefined, "seed");

        // Run crawl loop synchronously
        yield* runCrawlLoop(crawlId);

        return crawlId;
      });

    // Return crawler instance
    return {
      detectRedirects,
      start,
      pause,
      resume,
      stop,
      resumeFromStorage,
      restartCrawl,
      events: Stream.fromPubSub(eventHub),
      storage,
      get currentCrawlId() {
        return currentCrawlId;
      },
      get isRunning() {
        return isRunning;
      },
      get isPaused() {
        return isPaused;
      },
    };
  });
}

// ============================================
// HELPERS
// ============================================

/** Sum two hits-by-reason maps; returns undefined when both are empty so the
 *  field stays absent in persisted stats for cold crawls. */
function mergeCacheHitsByReason(
  current: CacheHitsByReason | undefined,
  updates: CacheHitsByReason | undefined,
): CacheHitsByReason | undefined {
  if (!current && !updates) return undefined;
  const out: CacheHitsByReason = { ...current };
  if (updates) {
    for (const [reason, count] of Object.entries(updates) as [CacheHitReason, number][]) {
      out[reason] = (out[reason] ?? 0) + (count ?? 0);
    }
  }
  return out;
}

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}

function looksLikeHtml(body: string): boolean {
  const trimmed = body.trimStart().slice(0, 100).toLowerCase();
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<head")
  );
}

/**
 * The request headers the fetcher actually sends that a server might vary on.
 * Kept minimal + stable so Vary keying is meaningful. Only includes headers we
 * deterministically send: our fixed Accept-Language, and a User-Agent ONLY when
 * one is explicitly configured (the fetcher rotates UA per crawl when
 * `userAgent` is empty, so storing a value that won't match next time would
 * cause spurious misses). Accept-Encoding is intentionally omitted: it's set by
 * the runtime transport, not by us, so we can't key on it reliably.
 */
function buildCacheRequestContext(config: CrawlerConfig): Record<string, string> {
  const ctx: Record<string, string> = {
    "accept-language": "en-US,en;q=0.9",
  };
  if (config.userAgent) {
    ctx["user-agent"] = config.userAgent;
  }
  return ctx;
}

/**
 * Map a fresh-state freshness reason to the unchanged-event reason. The
 * parameter is narrowed to FreshReason, so the exhaustive switch + `never`
 * default is a COMPILE-TIME guarantee: adding a new fresh reason without
 * handling it here fails typecheck rather than silently mislabeling the event.
 */
function freshnessReasonToEvent(reason: FreshReason): CrawlerPageUnchangedEvent["reason"] {
  switch (reason) {
    case "max-age":
      return "max-age";
    case "s-maxage":
      return "s-maxage";
    case "expires":
      return "expires";
    case "immutable":
      return "immutable";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
