// Crawl controller - runs crawl only without analysis

import { Effect, Stream } from "effect";

import type { Config } from "@/config";
import type { CrawlerEvent } from "@/crawler/core/types";
import type { TlsEvent } from "@/crawler/fetcher";
import type { CrawlerConfigSnapshot } from "@/crawler/storage/types";

import { loadConfig } from "@/config";
import { MAX_PAGES_CAP } from "@/constants";
import {
  deriveUserSetConcurrency,
  LOOPBACK_FAST_CONCURRENCY,
  resolveCrawlConcurrency,
  shouldUseLoopbackFastPath,
} from "@/controllers/audit";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { createCrawler } from "@/crawler/core";
import { createStorage, domainToProjectName } from "@/crawler/storage";
import { initRequestTool } from "@/tools/request";
import { configureLogger, logger } from "@/utils/logger";
import { checkReachability } from "@/utils/reachability";
import { getHostname, isLoopbackHost, parseUserUrl } from "@/utils/url";
import { resolveStickyUserAgent } from "@/utils/user-agent";

export type { CrawlerEvent } from "@/crawler/core/types";

/**
 * Fields that affect crawl scope - changes require fresh crawl_id
 * Type-checked against CrawlerConfigSnapshot to catch field renames at compile time
 */
const DIRTY_CONFIG_FIELDS = [
  "include",
  "exclude",
  "allowedDomains",
  "allowQueryParams",
  "dropQueryPrefixes",
] as const satisfies ReadonlyArray<keyof CrawlerConfigSnapshot>;

/**
 * Check if config changes require a fresh crawl (scope-affecting fields changed)
 */
function isDirtyConfig(
  oldConfig: CrawlerConfigSnapshot,
  newConfig: Partial<CrawlerConfigSnapshot>
): boolean {
  for (const field of DIRTY_CONFIG_FIELDS) {
    const oldVal = JSON.stringify(oldConfig[field]);
    const newVal = JSON.stringify(newConfig[field]);
    if (oldVal !== newVal) {
      logger.debug("dirty config field", field, oldVal, "→", newVal);
      return true;
    }
  }
  return false;
}

export interface CrawlProgress {
  phase: "crawling" | "complete";
  current?: number;
  total?: number;
}

export type CrawlProgressCallback = (progress: CrawlProgress) => void;

export type CrawlerEventCallback = (event: CrawlerEvent) => void;

export interface CrawlOptions {
  url: string;
  configPath?: string;
  maxPages?: number;
  coverageMode?: "quick" | "surface" | "full";
  refresh?: boolean;
  freshUa?: boolean; // re-roll the project's sticky random user-agent (#875)
  resume?: boolean;
  onProgress?: CrawlProgressCallback;
  onEvent?: CrawlerEventCallback;
  projectName?: string; // custom project name (for local addresses)
  // Crawl parallelism overrides (#1068/#1084): global worker pool + per-host
  // cap. Positive integers; override [crawler] concurrency /
  // per_host_concurrency and suppress the loopback fast path.
  concurrency?: number;
  perHostConcurrency?: number;
}

export interface CrawlResult {
  crawlId: string;
  pagesCount: number;
  baseUrl: string;
  durationMs: number;
  /**
   * True when the crawl stored as many pages as the cap allows — i.e. the page
   * limit was the binding constraint. Compared against the crawler's exact cap
   * basis (`getPageCount` = `COUNT(*) FROM pages`), so it stays correct on
   * cache-heavy / resumed / failure-heavy crawls. (#124)
   */
  limitReached: boolean;
}

/**
 * Fold --concurrency / --per-host (#1084) into [crawler] concurrency knobs,
 * mirroring mergeOptionsToConfig's crawler-block merge in controllers/audit.ts.
 * resolveCrawlConcurrency's non-loopback/non-render fallback reads straight off
 * `config.crawler.*`, so the flags must land there BEFORE it's called — passing
 * the raw config would silently ignore them. Exported for tests.
 */
export function mergeCrawlConcurrencyOptions(
  config: Config,
  options: Pick<CrawlOptions, "concurrency" | "perHostConcurrency">
): Config {
  return {
    ...config,
    crawler: {
      ...config.crawler,
      ...(typeof options.concurrency === "number"
        ? { concurrency: Math.max(1, Math.floor(options.concurrency)) }
        : {}),
      ...(typeof options.perHostConcurrency === "number"
        ? {
            per_host_concurrency: Math.max(
              1,
              Math.floor(options.perHostConcurrency)
            ),
          }
        : {}),
    },
  };
}

/**
 * Run crawl only (no analysis)
 * Stores pages, links, images to SQLite
 * Sets status to "crawled"
 */
export async function runCrawl(
  options: CrawlOptions
): Promise<Result<CrawlResult>> {
  // Parse and normalize URL
  const parsed = parseUserUrl(options.url);
  if (!parsed.ok) {
    return err(commandError(ErrorCodes.INVALID_URL, parsed.error));
  }
  const url = parsed.url;
  const baseUrl = new URL(url).origin;

  // Load config first (needed for TLS settings before reachability check)
  // Silent since CLI already logged the config path
  const config = await loadConfig(options.configPath, { silent: true });
  const onProgress = options.onProgress ?? (() => {});
  const startTime = Date.now();

  try {
    configureLogger({ debug: false });
    logger.debug("starting crawl-only", url);

    // Only concurrency knobs go through the merge helper — max_pages stays a
    // plain `options.maxPages ?? config.crawler.max_pages` read below because
    // it's a Math.min clamp, order-independent regardless of merge timing.
    const mergedConfig = mergeCrawlConcurrencyOptions(config, options);

    // Loopback fast path (#1068/#1084): boost concurrency for the user's own
    // dev server unless concurrency was set explicitly (flag, or config that
    // differs from the schema default — zod erases the "was it set" bit).
    // `crawl` is always plain-HTTP (no document fetcher), so this is the only
    // concurrency path — no cloud-render clamp to consider.
    const loopbackCtx = {
      isLoopback: isLoopbackHost(getHostname(url)),
      userOverride: deriveUserSetConcurrency(options, mergedConfig),
    };
    const crawlConcurrency = resolveCrawlConcurrency(
      mergedConfig,
      undefined,
      undefined,
      loopbackCtx
    );
    if (shouldUseLoopbackFastPath(undefined, loopbackCtx)) {
      logger.debug(
        `loopback fast path: concurrency ${LOOPBACK_FAST_CONCURRENCY}, no per-host delay`
      );
    }

    // Initialize request tool with config
    initRequestTool({
      timeout: config.crawler.timeout_ms,
    });

    // Check reachability
    logger.debug("checking reachability", url);
    const reachability = await checkReachability(url);
    if (!reachability.reachable) {
      return err(
        commandError(
          ErrorCodes.UNREACHABLE,
          `Cannot reach ${url}: ${reachability.error}`
        )
      );
    }

    // Create storage with project name (use provided name or derive from domain)
    const projectName = options.projectName ?? domainToProjectName(url);
    logger.debug("creating storage", projectName);

    const storage = await Effect.runPromise(createStorage({ projectName }));

    try {
      // Resolve user-agent: empty string = random browser UA, pinned per
      // project so re-runs serve the same markup (#875)
      const { userAgent, source: uaSource } = await Effect.runPromise(
        resolveStickyUserAgent(config.crawler.user_agent, storage, {
          freshUa: options.freshUa,
        })
      );
      logger.debug(`using ${uaSource} user-agent`, userAgent);

      // Resolve coverage mode: option > config > default (surface)
      const coverageMode =
        options.coverageMode ?? config.crawler.coverage ?? "surface";

      // Create crawler with config
      const crawler = await Effect.runPromise(
        createCrawler({
          config: {
            maxPages: Math.min(
              options.maxPages ?? config.crawler.max_pages,
              MAX_PAGES_CAP
            ),
            concurrency: crawlConcurrency.concurrency,
            perHostConcurrency: crawlConcurrency.perHostConcurrency,
            delayMs: config.crawler.delay_ms,
            perHostDelayMs: crawlConcurrency.perHostDelayMs,
            timeoutMs: config.crawler.timeout_ms,
            userAgent,
            followRedirects: config.crawler.follow_redirects,
            respectRobots: config.crawler.respect_robots,
            incremental: !options.refresh, // default true unless --refresh
            include: config.crawler.include,
            exclude: config.crawler.exclude,
            allowQueryParams: config.crawler.allow_query_params,
            dropQueryPrefixes: config.crawler.drop_query_prefixes,
            allowedDomains: config.project.domains,
            breadthFirst: config.crawler.breadth_first,
            maxPrefixBudgetRatio: config.crawler.max_prefix_budget,
            coverageMode,
            disableLinkDiscovery: coverageMode === "quick",
          },
          storage,
        })
      );

      logger.debug("starting crawler", url);
      onProgress({ phase: "crawling" });

      // Subscribe to event stream if callback provided
      const onEvent = options.onEvent;
      if (onEvent) {
        // Run event stream consumer in background
        Effect.runFork(
          Stream.runForEach(crawler.events, (event) =>
            Effect.sync(() => onEvent(event))
          )
        );
      }

      // Detect redirects first to get final URL
      const finalUrl = await Effect.runPromise(crawler.detectRedirects(url));

      // Check for existing crawl to determine resume vs new crawl
      const existingCrawl = await Effect.runPromise(
        storage.getCrawlByUrl(baseUrl)
      );

      const crawlerConfig = {
        maxPages: Math.min(
          options.maxPages ?? config.crawler.max_pages,
          MAX_PAGES_CAP
        ),
        concurrency: crawlConcurrency.concurrency,
        perHostConcurrency: crawlConcurrency.perHostConcurrency,
        delayMs: config.crawler.delay_ms,
        perHostDelayMs: crawlConcurrency.perHostDelayMs,
        timeoutMs: config.crawler.timeout_ms,
        userAgent,
        followRedirects: config.crawler.follow_redirects,
        respectRobots: config.crawler.respect_robots,
        incremental: !options.refresh,
        include: config.crawler.include,
        exclude: config.crawler.exclude,
        allowQueryParams: config.crawler.allow_query_params,
        dropQueryPrefixes: config.crawler.drop_query_prefixes,
        allowedDomains: config.project.domains,
        breadthFirst: config.crawler.breadth_first,
        maxPrefixBudgetRatio: config.crawler.max_prefix_budget,
        coverageMode,
        disableLinkDiscovery: coverageMode === "quick",
        onTlsEvent: (event: TlsEvent) => {
          // Surface TLS/status-0 failures so they aren't silent.
          if (event.kind === "fallback_failed" || event.kind === "error") {
            logger.warn("tls fetch failed", event);
          } else {
            logger.debug("tls fetch event", event);
          }
        },
      };

      // Resume decision logic
      const shouldResume =
        options.resume && // User explicitly requested resume
        !!existingCrawl &&
        !options.refresh && // Can't resume if refresh requested
        // "stopped" = interrupted mid-frontier by the crawl-phase backstop
        // (#969); the frontier still has pending URLs, so resume continues it.
        (existingCrawl.status === "running" ||
          existingCrawl.status === "paused" ||
          existingCrawl.status === "stopped") &&
        !isDirtyConfig(existingCrawl.config, crawlerConfig);

      let crawlId: string;
      if (shouldResume) {
        // Resume interrupted crawl
        logger.info(`resuming interrupted crawl ${existingCrawl.id}`);
        await Effect.runPromise(crawler.resumeFromStorage(existingCrawl.id));
        crawlId = existingCrawl.id;
      } else {
        // Create new crawl
        // Warn if resume conditions not met
        if (options.resume && !existingCrawl) {
          logger.warn("--resume requested but no previous crawl found");
        } else if (
          options.resume &&
          existingCrawl &&
          existingCrawl.status === "completed"
        ) {
          logger.warn(
            "--resume requested but previous crawl completed, starting new"
          );
        } else if (
          options.resume &&
          existingCrawl &&
          isDirtyConfig(existingCrawl.config, crawlerConfig)
        ) {
          logger.warn("--resume requested but config changed, starting new");
        } else if (options.resume && options.refresh) {
          logger.warn(
            "--resume and --refresh are mutually exclusive, using --refresh"
          );
        }

        // Log reason for new crawl
        if (options.refresh) {
          logger.debug("refresh requested, starting new crawl");
        } else if (!existingCrawl) {
          logger.debug("first crawl for domain");
        } else if (
          existingCrawl &&
          isDirtyConfig(existingCrawl.config, crawlerConfig)
        ) {
          logger.debug("config changed, starting fresh crawl");
        } else {
          logger.debug("starting new crawl (previous completed)");
        }

        crawlId = await Effect.runPromise(crawler.start(finalUrl, url));
      }

      // Update status to "crawled" (not "completed")
      await Effect.runPromise(
        storage.updateCrawl(crawlId, { status: "crawled" })
      );

      // Get final stats
      const stats = await Effect.runPromise(storage.getStats(crawlId));
      const pagesCount = stats?.pagesFetched ?? 0;
      // Compare against the crawler's exact cap basis: COUNT(*) FROM pages
      // (getPageCount). pagesFetched undercounts (excludes cache hits) and
      // pagesTotal overcounts (includes failed/skipped that store no page), so
      // both would mis-trigger the limit hint. (#124)
      const storedPageCount = await Effect.runPromise(
        storage.getPageCount(crawlId)
      );
      const limitReached = storedPageCount >= crawlerConfig.maxPages;
      const durationMs = Date.now() - startTime;

      logger.debug("crawl complete", `pages=${pagesCount}`);

      onProgress({
        phase: "complete",
        current: pagesCount,
        total: pagesCount,
      });

      return ok({
        crawlId,
        pagesCount,
        baseUrl,
        durationMs,
        limitReached,
      });
    } finally {
      await Effect.runPromise(storage.close());
    }
  } catch (error) {
    logger.debug("crawl error", error);
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Crawl failed: ${(error as Error).message}`
      )
    );
  }
}
