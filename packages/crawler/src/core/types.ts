// Core crawler types - events, config, and interfaces

import type { DocumentFetcher } from "@squirrelscan/fetchers";
import type { Stream, Effect } from "effect";

import type { RedirectChain } from "@squirrelscan/core-contracts";

import type { CrawlStorage, CrawlStats, StorageError } from "../storage/types";
import type { TlsEvent } from "../fetcher";

// ============================================
// CRAWLER CONFIG
// ============================================

export type CoverageMode = "quick" | "surface" | "full";

export interface CrawlerConfig {
  /** Maximum pages to crawl */
  maxPages: number;
  /** Optional crawl-depth ceiling (#318): seed/sitemap = depth 0. Unset = unlimited. */
  maxDepth?: number;
  /** Global concurrency limit */
  concurrency: number;
  /** Per-host concurrency limit */
  perHostConcurrency: number;
  /** Global delay between requests (ms) */
  delayMs: number;
  /** Per-host delay between requests (ms) */
  perHostDelayMs: number;
  /** Request timeout (ms) */
  timeoutMs: number;
  /** User agent string */
  userAgent: string;
  /**
   * Custom HTTP request headers attached to every request (pages, assets,
   * robots.txt, sitemap, llms.txt, markdown probes). Empty by default. Values
   * are secrets — never log them. Threaded into FetchOptions.headers.
   */
  headers?: Record<string, string>;
  /** Follow redirects */
  followRedirects: boolean;
  /**
   * Enforce robots.txt Disallow rules and honor Crawl-delay (capped at
   * `MAX_ROBOTS_CRAWL_DELAY_MS`). robots.txt is ALWAYS fetched/parsed
   * regardless of this flag — sitemap discovery and the crawl/robots-txt rule
   * need it. Default false (#790): squirrelscan audits are site-owner
   * initiated, so robots directives aren't enforced unless opted in.
   */
  respectRobots: boolean;
  /** Enable incremental crawling (conditional GET) */
  incremental: boolean;
  /**
   * Honor origin Cache-Control max-age / Expires to skip the request entirely
   * when a cached entry is still fresh (browser-cache emulation). Only takes
   * effect when `incremental` is also true. Default: true.
   */
  useCacheControl: boolean;
  /**
   * Hard cap (seconds) on how stale a "fresh" cached entry may be regardless of
   * the origin's declared max-age. Bounds trust in absurd max-age values within
   * a single audit. Default: 24h.
   */
  maxStalenessSeconds: number;
  /** URL patterns to include */
  include: string[];
  /** URL patterns to exclude */
  exclude: string[];
  /** Query params to preserve */
  allowQueryParams: string[];
  /** Query param prefixes to drop */
  dropQueryPrefixes: string[];
  /** Allowed domains for multi-domain projects (empty = base URL host only) */
  allowedDomains: string[];
  /** Enable breadth-first crawling to sample all site sections */
  breadthFirst: boolean;
  /** Max percentage of budget any single prefix can consume (0.0-1.0) */
  maxPrefixBudgetRatio: number;
  /** Coverage mode: quick, surface, or full */
  coverageMode: CoverageMode;
  /** Disable link discovery (for quick mode) */
  disableLinkDiscovery: boolean;
  /**
   * Grace window (ms) after stop() before the crawl pool is hard-interrupted
   * (#923). stop() flips isRunning=false so idle workers exit at their loop-top
   * check; this window lets an in-flight fetch that's about to return commit
   * its page, then any still-wedged in-flight op is interrupted so a stuck
   * fetch can't extend the crawl past cap + grace (it previously ran to the
   * ~180s per-URL watchdog, adding a second multiple of the wall-clock budget).
   * Default: 5s.
   */
  stopGraceMs: number;
  /** Number of URLs found in sitemaps (set at runtime by crawler) */
  sitemapUrlCount: number;
  /**
   * Number of sitemap URLs that actually became `pending` after robots/scope
   * filtering (set at runtime, before the seed is enqueued). 0 means the
   * sitemap yielded nothing crawlable → re-enable link discovery.
   */
  sitemapPendingCount: number;
  /**
   * Pages holding open carried findings, seeded into the frontier at high
   * priority ahead of generic discovery so their findings get re-checked within
   * budget (#1146). Already capped upstream to a share of maxPages so new-page
   * discovery is never starved. Empty/unset = no seeding (today's behavior).
   */
  carriedSeedUrls?: string[];
  /**
   * Recently-removed (404/410) page URLs (#1146). De-prioritized in the frontier
   * so dead URLs stop eating budget slots ahead of live pages. Empty/unset = no
   * de-prioritization.
   */
  deprioritizedUrls?: string[];
  /** Optional pluggable document fetcher implementation */
  documentFetcher?: DocumentFetcher;
  /**
   * Optional hook for structured TLS/status-0 failure + standard-fetch fallback
   * events. Lets consumers (CLI/cloud) surface these with TLS context instead
   * of them being swallowed into a generic network error. Defaults to unset.
   */
  onTlsEvent?: (event: TlsEvent) => void;
}

// Fallback merged in by createCrawler when a caller passes no/partial config.
// Production callers (CLI, cloud runner) always pass a full crawlerConfig
// derived from @squirrelscan/config's schema, which is the authoritative source
// of truth. The concurrency knobs mirror those schema defaults (#1068) — keep in
// sync with DEFAULT_CRAWLER_CONCURRENCY / _PER_HOST_CONCURRENCY / _PER_HOST_DELAY_MS.
// delayMs is inert as a scheduler input: the host scheduler staggers on
// perHostDelayMs only; config.delayMs is merely recorded on the crawl-session
// row. Left 0 here; the schema still defaults it to 100 for that record.
export const DEFAULT_CRAWLER_CONFIG: CrawlerConfig = {
  maxPages: 100,
  concurrency: 5,
  perHostConcurrency: 5,
  delayMs: 0,
  perHostDelayMs: 50,
  timeoutMs: 30000,
  userAgent: "", // empty = random browser UA per crawl
  headers: {},
  followRedirects: true,
  respectRobots: false,
  incremental: false,
  useCacheControl: true,
  maxStalenessSeconds: 24 * 60 * 60,
  include: [],
  exclude: [],
  allowQueryParams: [],
  dropQueryPrefixes: ["utm_", "gclid", "fbclid", "mc_", "ref"],
  allowedDomains: [],
  breadthFirst: true,
  maxPrefixBudgetRatio: 0.25,
  coverageMode: "quick",
  disableLinkDiscovery: false,
  stopGraceMs: 5_000,
  sitemapUrlCount: 0,
  sitemapPendingCount: 0,
};

// ============================================
// CRAWLER EVENTS
// ============================================

export type CrawlerEvent =
  | CrawlerStartedEvent
  | CrawlerPageFetchingEvent
  | CrawlerPageFetchedEvent
  | CrawlerPageFailedEvent
  | CrawlerPageSkippedEvent
  | CrawlerPageUnchangedEvent
  | CrawlerUrlDiscoveredEvent
  | CrawlerUrlEnqueuedEvent
  | CrawlerProgressEvent
  | CrawlerPausedEvent
  | CrawlerResumedEvent
  | CrawlerCompletedEvent
  | CrawlerErrorEvent;

export interface CrawlerStartedEvent {
  type: "started";
  crawlId: string;
  baseUrl: string;
  timestamp: number;
}

export interface CrawlerPageFetchingEvent {
  type: "page:fetching";
  url: string;
  depth: number;
  timestamp: number;
}

export interface CrawlerPageFetchedEvent {
  type: "page:fetched";
  url: string;
  status: number;
  loadTimeMs: number;
  sizeBytes: number;
  depth: number;
  timestamp: number;
  /** Browser render cost only, set only for browser-queue-rendered pages (#826). */
  renderTimeMs?: number;
  /** Queue delivery lag + browser-pool acquisition + concurrency-slot wait, set only for browser-queue-rendered pages (#826). */
  queueWaitMs?: number;
}

export interface CrawlerPageFailedEvent {
  type: "page:failed";
  url: string;
  error: string;
  retryable: boolean;
  depth: number;
  timestamp: number;
}

export interface CrawlerPageSkippedEvent {
  type: "page:skipped";
  url: string;
  reason: string;
  depth: number;
  timestamp: number;
}

export interface CrawlerPageUnchangedEvent {
  type: "page:unchanged";
  url: string;
  reason:
    | "304"
    | "hash_match"
    | "etag_match"
    // Served from cache without any request (origin freshness honored)
    | "max-age"
    | "s-maxage"
    | "expires"
    | "immutable"
    // Served stale from cache while a background revalidation refreshes it
    | "stale-while-revalidate";
  depth: number;
  timestamp: number;
}

export interface CrawlerUrlDiscoveredEvent {
  type: "url:discovered";
  url: string;
  fromUrl: string;
  depth: number;
  timestamp: number;
}

export interface CrawlerUrlEnqueuedEvent {
  type: "url:enqueued";
  url: string;
  priority: number;
  source: "seed" | "sitemap" | "discovered" | "carried";
  depth: number;
  timestamp: number;
}

export interface CrawlerProgressEvent {
  type: "progress";
  fetched: number;
  pending: number;
  failed: number;
  skipped: number;
  unchanged: number;
  total: number;
  bytesTotal: number;
  avgLoadTimeMs: number;
  timestamp: number;
}

export interface CrawlerPausedEvent {
  type: "paused";
  reason: string;
  timestamp: number;
}

export interface CrawlerResumedEvent {
  type: "resumed";
  timestamp: number;
}

export interface CrawlerCompletedEvent {
  type: "completed";
  stats: CrawlStats;
  durationMs: number;
  timestamp: number;
}

export interface CrawlerErrorEvent {
  type: "error";
  error: string;
  fatal: boolean;
  timestamp: number;
}

// ============================================
// CRAWLER ERROR
// ============================================

export class CrawlerError extends Error {
  readonly _tag = "CrawlerError";

  constructor(
    readonly code: CrawlerErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CrawlerError";
  }

  static network(message: string, cause?: unknown): CrawlerError {
    return new CrawlerError("NETWORK_ERROR", message, cause);
  }

  static timeout(url: string): CrawlerError {
    return new CrawlerError("TIMEOUT", `Request timed out: ${url}`);
  }

  static robotsBlocked(url: string): CrawlerError {
    return new CrawlerError("ROBOTS_BLOCKED", `Blocked by robots.txt: ${url}`);
  }

  static scopeExcluded(url: string): CrawlerError {
    return new CrawlerError("SCOPE_EXCLUDED", `URL excluded by scope: ${url}`);
  }

  static maxPagesReached(): CrawlerError {
    return new CrawlerError("MAX_PAGES_REACHED", "Maximum pages limit reached");
  }

  static storage(message: string, cause?: unknown): CrawlerError {
    return new CrawlerError("STORAGE_ERROR", message, cause);
  }

  static parse(message: string, cause?: unknown): CrawlerError {
    return new CrawlerError("PARSE_ERROR", message, cause);
  }
}

export type CrawlerErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ROBOTS_BLOCKED"
  | "SCOPE_EXCLUDED"
  | "MAX_PAGES_REACHED"
  | "STORAGE_ERROR"
  | "PARSE_ERROR"
  | "UNKNOWN";

// ============================================
// CRAWLER INTERFACE
// ============================================

export interface Crawler {
  /** Detect and follow both HTTP and client-side redirects, returning the final URL */
  detectRedirects(targetUrl: string): Effect.Effect<string, never, never>;

  /** Start a new crawl from the given base URL (runs synchronously until complete) */
  start(
    baseUrl: string,
    originalUrl?: string,
  ): Effect.Effect<string, CrawlerError | StorageError, never>;

  /** Pause the current crawl */
  pause(): Effect.Effect<void, CrawlerError, never>;

  /** Resume a paused crawl */
  resume(): Effect.Effect<void, CrawlerError, never>;

  /** Stop the current crawl (can be resumed later) */
  stop(): Effect.Effect<void, CrawlerError, never>;

  /** Resume a crawl from storage by ID */
  resumeFromStorage(crawlId: string): Effect.Effect<void, CrawlerError | StorageError, never>;

  /** Restart an existing crawl with new config (clears frontier, re-crawls) */
  restartCrawl(
    crawlId: string,
    newConfig: Partial<CrawlerConfig>,
  ): Effect.Effect<string, CrawlerError | StorageError, never>;

  /** Event stream for live updates */
  readonly events: Stream.Stream<CrawlerEvent, never, never>;

  /** Direct access to storage */
  readonly storage: CrawlStorage;

  /** Current crawl ID (if any) */
  readonly currentCrawlId: string | null;

  /** Whether the crawler is currently running */
  readonly isRunning: boolean;

  /** Whether the crawler is paused */
  readonly isPaused: boolean;
}

// ============================================
// FETCH RESULT
// ============================================

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  body: string;
  headers: Record<string, string>;
  contentType: string | null;
  sizeBytes: number;
  loadTimeMs: number;
  redirectChain: RedirectChain;
}

// ============================================
// ROBOTS EVALUATOR
// ============================================

export interface RobotsEvaluator {
  isAllowed(url: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
}

// ============================================
// HOST SCHEDULER STATE
// ============================================

export interface HostState {
  inFlight: number;
  // Earliest permitted next fetch START (#265): reserved per-slot so requests stagger.
  nextFetchAt: number;
}

export interface HostScheduler {
  acquire(host: string): Effect.Effect<void, never, never>;
  release(host: string): Effect.Effect<void, never, never>;
  waitForDelay(host: string, delayMs: number): Effect.Effect<void, never, never>;
}
