// Analyze controller - runs rules on existing crawl data

import { Effect } from "effect";
import { existsSync, readdirSync } from "node:fs";

import type {
  CrawlStorage,
  CrawlMetadata,
  CrawlStatus,
} from "@/crawler/storage/types";

import {
  runRulesOnStorage,
  buildSiteContext,
  fetchResourceAssets,
} from "@/audit/adapter";
import { loadConfig } from "@/config";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { createStorage } from "@/crawler/storage";
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
    if (!best || crawl.startedAt > best.startedAt) {
      best = crawl;
    }
  }

  return best;
}

/**
 * Find a crawl by ID across all project databases
 */
async function findCrawlById(
  crawlId: string
): Promise<{ storage: CrawlStorage; crawl: CrawlMetadata } | null> {
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
        const result = { storage: projectStorage, crawl };
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
async function findLatestCrawl(): Promise<{
  storage: CrawlStorage;
  crawl: CrawlMetadata;
} | null> {
  const projectsPath = getProjectsPath();
  if (!existsSync(projectsPath)) return null;

  const projects = readdirSync(projectsPath);
  let result: { storage: CrawlStorage; crawl: CrawlMetadata } | null = null;

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
          result = { storage: projectStorage, crawl };
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

  try {
    configureLogger({ debug: false });
    logger.debug("starting analyze", options.crawlId ?? "latest");

    let crawlId: string;
    let baseUrl: string;

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

    logger.debug("fetching resource assets", crawlId);
    onProgress({ phase: "rules" });

    const assets = await Effect.runPromise(
      fetchResourceAssets(storage, crawlId, siteContext, config)
    );

    logger.debug("running rules on crawl", crawlId);

    // Run rules on site context (no additional parsing)
    const ruleResults = await Effect.runPromise(
      runRulesOnStorage(storage, crawlId, siteContext, config, assets)
    );

    // Save rule results to storage using batch method for efficiency
    // Use pageRuleResults which has proper rule IDs (e.g., "core/meta-title")
    const batchResults = new Map<
      string,
      { ruleId: string; checks: import("@/types").CheckResult[] }[]
    >();
    for (const [url, ruleChecksMap] of ruleResults.pageRuleResults) {
      const pageResultsList: {
        ruleId: string;
        checks: import("@/types").CheckResult[];
      }[] = [];
      for (const [ruleId, checks] of ruleChecksMap) {
        pageResultsList.push({ ruleId, checks });
      }
      batchResults.set(url, pageResultsList);
    }

    // Add site-scope rule results (empty page_url convention)
    const siteResultsList: {
      ruleId: string;
      checks: import("@/types").CheckResult[];
    }[] = [];
    for (const [ruleId, checks] of ruleResults.siteRuleResults) {
      siteResultsList.push({ ruleId, checks });
    }
    if (siteResultsList.length > 0) {
      batchResults.set("", siteResultsList);
    }

    // Use batch save if available on storage (SQLiteStorage)
    if ("saveRuleResultsBatch" in storage) {
      await Effect.runPromise(
        (
          storage as import("@/crawler/storage/sqlite").SQLiteStorage
        ).saveRuleResultsBatch(crawlId, batchResults)
      );
    } else {
      // Fallback to individual saves
      for (const [url, results] of batchResults) {
        for (const { ruleId, checks } of results) {
          await Effect.runPromise(
            storage.saveRuleResults(crawlId, url, ruleId, checks)
          );
        }
      }
    }

    // Update crawl status to "analyzed"
    await Effect.runPromise(
      storage.updateCrawl(crawlId, { status: "analyzed" })
    );

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
    // Always close storage
    if (storage) {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
}
