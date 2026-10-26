// Analyze controller - runs rules on existing crawl data

import type { EntityMap } from "@squirrelscan/core-contracts";

import { createEntityMapCollector } from "@squirrelscan/audit-engine/entity-map/collect";
import { Effect } from "effect";
import { existsSync, readdirSync } from "node:fs";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";
import type {
  CrawlStorage,
  CrawlMetadata,
  CrawlStatus,
} from "@/crawler/storage/types";
import type { CheckResult } from "@/types";

import {
  runRulesOnStorage,
  buildSiteContext,
  fetchResourceAssets,
} from "@/audit/adapter";
import { startLeaseForStorage } from "@/audit/crawl-lease";
import { entityMapSite, storeEntityMap } from "@/audit/entity-map";
import {
  auditMayRetire,
  retainRecentAudits,
  RetentionReclaimError,
  type RetentionOutcome,
} from "@/audit/retention";
import { loadConfig, type Config } from "@/config";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { pinOwnHosts } from "@/crawl/pin-own-hosts";
import { createStorage } from "@/crawler/storage";
import { deriveCrawlRunStatus } from "@/reports/reconstruct";
import { retiredAuditReason } from "@/reports/retired";
import { getProjectsPath } from "@/self/paths";
import { configureLogger, logger } from "@/utils/logger";

export interface AnalyzeProgress {
  phase: "rules" | "complete";
  current?: number;
  total?: number;
}

export type AnalyzeProgressCallback = (progress: AnalyzeProgress) => void;

export interface AnalyzeOptions {
  crawlId?: string; // defaults to latest
  /** Called when the post-analyze retention pass retired something (#955). */
  onRetention?: (outcome: RetentionOutcome) => void;
  configPath?: string;
  onProgress?: AnalyzeProgressCallback;
}

export interface AnalyzeResult {
  crawlId: string;
  baseUrl: string;
  rulesRun: number;
  checksTotal: number;
  passed: number;
  warnings: number;
  failed: number;
}

const ANALYZE_LOOKBACK_LIMIT = 50;
const ANALYZE_READY_STATUSES = new Set<CrawlStatus>([
  "crawled",
  "analyzed",
  "completed",
  // "stopped" = partial crawl cut short by the backstop (#969); its collected
  // pages are analyzable just like "crawled".
  "stopped",
]);

export function isAnalyzeReadyStatus(status: CrawlStatus): boolean {
  return ANALYZE_READY_STATUSES.has(status);
}

export function pickLatestAnalyzeReadyCrawl(
  crawls: CrawlMetadata[]
): CrawlMetadata | null {
  let best: CrawlMetadata | null = null;

  for (const crawl of crawls) {
    if (!isAnalyzeReadyStatus(crawl.status)) continue;
    // A reclaimed audit keeps its `completed`/`analyzed` status (#1912), so a
    // status-only test picks one and analyze happily re-runs the rules over
    // whatever pages survived the prune, reporting "Analysis complete" for a
    // crawl most of whose data is gone.
    if (crawl.retiredAt !== undefined) continue;
    if (!best || crawl.startedAt > best.startedAt) {
      best = crawl;
    }
  }

  return best;
}

/** A crawl, the open store it lives in, and the project directory of that store. */
interface FoundCrawl {
  storage: CrawlStorage;
  crawl: CrawlMetadata;
  project: string;
}

/**
 * Find a crawl by ID across all project databases
 */
async function findCrawlById(crawlId: string): Promise<FoundCrawl | null> {
  const projectsPath = getProjectsPath();
  if (!existsSync(projectsPath)) return null;

  const projects = readdirSync(projectsPath);

  for (const project of projects) {
    let projectStorage: CrawlStorage | null = null;

    try {
      projectStorage = await Effect.runPromise(
        createStorage({ projectName: project })
      );

      const crawl = await Effect.runPromise(
        projectStorage
          .getCrawl(crawlId)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      );

      if (crawl) {
        const result = { storage: projectStorage, crawl, project };
        projectStorage = null; // Don't close, we're returning it
        return result;
      }
    } catch {
      // Error reading this project, continue to next
    } finally {
      // Close storage if we didn't return it
      if (projectStorage) {
        await Effect.runPromise(
          projectStorage.close().pipe(Effect.catchAll(() => Effect.void))
        );
      }
    }
  }

  return null;
}

/**
 * Find the most recent crawl across all projects
 */
async function findLatestCrawl(): Promise<FoundCrawl | null> {
  const projectsPath = getProjectsPath();
  if (!existsSync(projectsPath)) return null;

  const projects = readdirSync(projectsPath);
  let result: FoundCrawl | null = null;

  for (const project of projects) {
    let projectStorage: CrawlStorage | null = null;

    try {
      projectStorage = await Effect.runPromise(
        createStorage({ projectName: project })
      );

      const crawls = await Effect.runPromise(
        projectStorage
          .listCrawls(ANALYZE_LOOKBACK_LIMIT)
          .pipe(Effect.catchAll(() => Effect.succeed([])))
      );

      const crawl = pickLatestAnalyzeReadyCrawl(crawls);
      if (crawl) {
        if (!result || crawl.startedAt > result.crawl.startedAt) {
          // Close previous result's storage if any
          if (result) {
            await Effect.runPromise(
              result.storage.close().pipe(Effect.catchAll(() => Effect.void))
            );
          }
          result = { storage: projectStorage, crawl, project };
          projectStorage = null; // Don't close, we're returning it
        }
      }
    } catch {
      // Error reading this project, continue to next
    } finally {
      // Close storage if we didn't return it
      if (projectStorage) {
        await Effect.runPromise(
          projectStorage.close().pipe(Effect.catchAll(() => Effect.void))
        );
      }
    }
  }

  return result;
}

/**
 * Run analysis (rules) on existing crawl data
 * Requires a previous crawl to exist
 */
export async function runAnalyze(
  options: AnalyzeOptions
): Promise<Result<AnalyzeResult>> {
  // Load config
  const config = await loadConfig(options.configPath);
  const onProgress = options.onProgress ?? (() => {});

  let storage: CrawlStorage | null = null;
  // Crawl lease (#946): held from here to the finally, so the analyzed / report
  // building window is covered.
  let crawlLease: { release: () => void } | undefined;

  try {
    configureLogger({ debug: false });
    logger.debug("starting analyze", options.crawlId ?? "latest");

    let crawlId: string;
    let baseUrl: string;
    let project: string;

    if (options.crawlId) {
      // Find the crawl by ID across all projects
      const found = await findCrawlById(options.crawlId);
      if (!found) {
        return err(
          commandError(
            ErrorCodes.CRAWL_NOT_FOUND,
            `Crawl not found: ${options.crawlId}`
          )
        );
      }
      storage = found.storage;
      crawlId = found.crawl.id;
      baseUrl = found.crawl.baseUrl;
      project = found.project;
    } else {
      // Find the most recent crawl
      const found = await findLatestCrawl();
      if (!found) {
        return err(
          commandError(
            ErrorCodes.CRAWL_NOT_FOUND,
            "No completed crawls found. Run 'squirrel audit <url>' first or wait for an active crawl to finish."
          )
        );
      }
      storage = found.storage;
      crawlId = found.crawl.id;
      baseUrl = found.crawl.baseUrl;
      project = found.project;
    }

    // Check crawl status
    const crawl = await Effect.runPromise(
      storage
        .getCrawl(crawlId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
    );

    if (!crawl) {
      return err(
        commandError(ErrorCodes.CRAWL_NOT_FOUND, `Crawl not found: ${crawlId}`)
      );
    }

    crawlLease = startLeaseForStorage(storage, () => crawlId);

    // Same reason as the selector above: retirement does not change the status,
    // so this has to be its own test or `analyze <id>` re-analyzes reclaimed
    // data and calls it a success.
    if (crawl.retiredAt !== undefined) {
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_READY,
          `Crawl ${retiredAuditReason(crawl.retiredAt)}: ${crawlId}`
        )
      );
    }

    if (!isAnalyzeReadyStatus(crawl.status)) {
      const statusMessage =
        crawl.status === "running"
          ? "still in progress"
          : crawl.status === "paused"
            ? "paused"
            : crawl.status === "failed"
              ? "failed"
              : `not ready (${crawl.status})`;
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_READY,
          `Crawl ${statusMessage}: ${crawlId}`
        )
      );
    }

    logger.debug("building site context", crawlId);
    const pages = await Effect.runPromise(
      storage.getPages(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])))
    );
    const siteContext = await Effect.runPromise(buildSiteContext(pages));

    onProgress({ phase: "rules" });

    // Entity map (#2091) built BEFORE the rules, because the thirteen
    // `schema/entity-*` rules read it (#2093). `siteContext` is already
    // resident here, so this costs one fold over pages that are in memory
    // regardless. A failure degrades to undefined and those rules skip; it
    // never fails an analyze.
    let entityMap: EntityMap | undefined;
    try {
      const collector = createEntityMapCollector();
      collector.absorb(siteContext);
      entityMap = collector.build(entityMapSite(crawl));
    } catch (error) {
      logger.warn(
        `Could not build the entity map: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const { ruleResults } = await Effect.runPromise(
      analyzeStoredCrawl(storage, crawl, siteContext, config, entityMap)
    );

    await saveAnalyzeRuleResults(storage, crawlId, ruleResults);

    // The map built above is written to the project store, exactly as
    // `squirrel audit` does, so re-analyzing a crawl refreshes its entity rows
    // instead of leaving the last audit's behind. Built once and reused rather
    // than folded a second time here.
    if (entityMap && "saveEntityMap" in storage) {
      await storeEntityMap({
        storage: storage as import("@/crawler/storage/sqlite").SQLiteStorage,
        crawlId,
        map: entityMap,
      });
    }

    // Update crawl status to "analyzed"
    await Effect.runPromise(
      storage.updateCrawl(crawlId, { status: "analyzed" })
    );

    await retainAfterAnalyze({
      storage,
      crawl,
      crawlId,
      pages,
      project,
      byId: Boolean(options.crawlId),
      config,
      onRetention: options.onRetention,
    });

    // Calculate stats
    const allChecks = [
      ...Array.from(ruleResults.pageResults.values()).flat(),
      ...ruleResults.siteResults,
    ];
    const scorableChecks = allChecks.filter(
      (c) => c.status !== "skipped" && c.status !== "info"
    );
    const passed = scorableChecks.filter((c) => c.status === "pass").length;
    const warnings = scorableChecks.filter((c) => c.status === "warn").length;
    const failed = scorableChecks.filter((c) => c.status === "fail").length;

    logger.debug(
      "analysis complete",
      `rules=${ruleResults.ruleResultsMap.size}`
    );

    onProgress({
      phase: "complete",
      current: ruleResults.ruleResultsMap.size,
      total: ruleResults.ruleResultsMap.size,
    });

    return ok({
      crawlId,
      baseUrl,
      rulesRun: ruleResults.ruleResultsMap.size,
      checksTotal: allChecks.length,
      passed,
      warnings,
      failed,
    });
  } catch (error) {
    logger.debug("analyze error", error);
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Analysis failed: ${(error as Error).message}`
      )
    );
  } finally {
    crawlLease?.release();
    // Always close storage
    if (storage) {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
}

/**
 * `[storage] keep_audits` retention after an analyze (#955).
 *
 * `squirrel analyze` is the step that finishes an audit in the split pipeline
 * (`crawl`, `analyze`, `report`), so it applies the same window as the end of
 * `squirrel audit`, abandoned-crawl pass included. Same gates too: a crawl
 * whose own outcome is blocked or failed never retires history, and the window
 * is only applied to the project this directory's config names, or, with no
 * name configured, to the latest crawl's own project but never to an `--id` one. Records the outcome on the crawl,
 * as the audit does, so a later pass can tell a real audit from one that
 * learned nothing. Never fails the analyze.
 */
async function retainAfterAnalyze(args: {
  storage: CrawlStorage;
  crawl: CrawlMetadata;
  crawlId: string;
  pages: ReadonlyArray<{ status: number }>;
  project: string;
  /** The crawl was named with `--id` rather than picked as the latest. */
  byId: boolean;
  config: Config;
  onRetention?: (outcome: RetentionOutcome) => void;
}): Promise<void> {
  const { storage, crawl, crawlId, pages, project, byId, config } = args;
  if (!("retireCrawlsDetailed" in storage)) return;
  const sqlite = storage as SQLiteStorage;
  const status = deriveCrawlRunStatus(crawl, pages).status;
  try {
    await Effect.runPromise(
      sqlite
        .setReportStatus(crawlId, status ?? "completed", { keepBuilding: true })
        .pipe(Effect.catchAll(() => Effect.void))
    );
    if (!auditMayRetire(status)) {
      logger.debug("retention skipped: audit status", status ?? "unknown");
      return;
    }
    // Analyze can open any project's crawl (`--id`), and another project's
    // history is not this directory's window to cut. With no project name in
    // the config, only the latest-crawl form applies it: that is the project
    // the user just crawled.
    const configured = config.project.name;
    if (configured ? configured !== project : byId) {
      logger.debug("retention skipped: crawl is in another project", project);
      return;
    }
    const retention = await retainRecentAudits(sqlite, {
      keep: config.storage.keep_audits,
      currentCrawlId: crawlId,
    });
    if (retention) {
      logger.info(
        `retired ${retention.retired} crawl(s) beyond keep_audits=${retention.keep}, freeing ${retention.freedBytes} bytes${retention.vacuumed ? " (database rebuilt)" : ""}`
      );
      args.onRetention?.(retention);
    }
  } catch (error) {
    logger.warn(`Retention pass failed: ${(error as Error).message}`);
    if (error instanceof RetentionReclaimError) {
      args.onRetention?.(error.outcome);
    }
  }
}

/**
 * Store an analyze run's rule results in place of the crawl's previous ones
 * (#844). `squirrel analyze` re-runs the rules over a stored crawl, so a plain
 * insert appended a second copy of every check and the report then merged the
 * two, showing the old items. On SQLite the delete and the inserts are one
 * transaction, so a failed write keeps the previous results.
 */
export async function saveAnalyzeRuleResults(
  storage: CrawlStorage,
  crawlId: string,
  ruleResults: {
    pageRuleResults: Map<string, Map<string, CheckResult[]>>;
    siteRuleResults: Map<string, CheckResult[]>;
  }
): Promise<void> {
  // Use pageRuleResults which has proper rule IDs (e.g., "core/meta-title")
  const batchResults = new Map<
    string,
    { ruleId: string; checks: CheckResult[] }[]
  >();
  for (const [url, ruleChecksMap] of ruleResults.pageRuleResults) {
    const pageResultsList: { ruleId: string; checks: CheckResult[] }[] = [];
    for (const [ruleId, checks] of ruleChecksMap) {
      pageResultsList.push({ ruleId, checks });
    }
    batchResults.set(url, pageResultsList);
  }

  // Add site-scope rule results (empty page_url convention)
  const siteResultsList: { ruleId: string; checks: CheckResult[] }[] = [];
  for (const [ruleId, checks] of ruleResults.siteRuleResults) {
    siteResultsList.push({ ruleId, checks });
  }
  if (siteResultsList.length > 0) {
    batchResults.set("", siteResultsList);
  }

  if ("saveRuleResultsBatch" in storage) {
    await Effect.runPromise(
      (storage as SQLiteStorage).saveRuleResultsBatch(crawlId, batchResults, {
        replace: true,
      })
    );
    return;
  }
  // Fallback for a storage without the batch writer: clear, then save each.
  if ("clearRuleResults" in storage) {
    await Effect.runPromise(
      (storage as SQLiteStorage).clearRuleResults(crawlId)
    );
  }
  for (const [url, results] of batchResults) {
    for (const { ruleId, checks } of results) {
      await Effect.runPromise(
        storage.saveRuleResults(crawlId, url, ruleId, checks)
      );
    }
  }
}

/**
 * The asset phase, then the rules, over a stored crawl, both with the
 * crawl's own config ({@link configForCrawl}): the same asset phase
 * `squirrel audit` runs (#768, #799).
 */
export function analyzeStoredCrawl(
  storage: CrawlStorage,
  crawl: CrawlMetadata,
  siteContext: Parameters<typeof fetchResourceAssets>[2],
  config: Config,
  entityMap?: EntityMap
) {
  const crawlConfig = configForCrawl(config, crawl);
  return Effect.gen(function* () {
    logger.debug("fetching resource assets", crawl.id);
    const assets = yield* fetchResourceAssets(
      storage,
      crawl.id,
      siteContext,
      crawlConfig,
      // squirrelscan/repo#3430: the site's own hosts are vetted and pinned.
      { pinOwnHosts: pinOwnHosts() }
    );
    logger.debug("running rules on crawl", crawl.id);
    // Run rules on site context (no additional parsing)
    const ruleResults = yield* runRulesOnStorage(
      storage,
      crawl.id,
      siteContext,
      crawlConfig,
      assets,
      entityMap ? { entityMap } : undefined
    );
    return { assets, ruleResults };
  });
}

/**
 * The config an analyze runs with. The crawl may be any project's (the latest
 * across all of them, or `--id`), while `config` is the squirrel.toml found
 * from this directory. So the crawl's own recorded scope and page limit decide
 * what is checked, as they did in the audit, with the strict side for a row
 * recorded without them (no extra domains). The page limit is the one the
 * crawl started with (a resumed audit keeps it). Per-host politeness stays as
 * configured here: the crawl records what its pool resolved to (a rendered or
 * loopback crawl's), not the limits the audit's own checks ran with. No custom
 * request headers are sent: this directory's belong to its own site.
 */
export function configForCrawl(config: Config, crawl: CrawlMetadata): Config {
  // Rows recorded before a field existed read back without it.
  const recorded = crawl.config as Partial<CrawlMetadata["config"]> | undefined;
  return {
    ...config,
    crawler: {
      ...config.crawler,
      max_pages: recorded?.maxPages ?? config.crawler.max_pages,
      include: recorded?.include ?? config.crawler.include,
      exclude: recorded?.exclude ?? config.crawler.exclude,
      respect_robots: recorded?.respectRobots ?? config.crawler.respect_robots,
      headers: {},
    },
    project: {
      ...config.project,
      domains: recorded?.allowedDomains ?? [],
    },
  };
}
