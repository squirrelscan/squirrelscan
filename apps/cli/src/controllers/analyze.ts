// Analyze controller - runs rules on existing crawl data

import type { PageResultSink } from "@squirrelscan/audit-engine";
import type { EntityMap } from "@squirrelscan/core-contracts";

import { createEntityMapCollector } from "@squirrelscan/audit-engine/entity-map/collect";
import { clearRequestAsync } from "@squirrelscan/rules";
import { Effect } from "effect";
import { existsSync, readdirSync } from "node:fs";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";
import type {
  CrawlStorage,
  CrawlMetadata,
  CrawlStatus,
} from "@/crawler/storage/types";
import type { CheckResult } from "@/types";

import { runStreamingPreRules, runStreamingRules } from "@/audit/adapter";
import { startLeaseForStorage } from "@/audit/crawl-lease";
import { entityMapSite, storeEntityMap } from "@/audit/entity-map";
import {
  auditMayRetire,
  retainRecentAudits,
  RetentionReclaimError,
  type RetentionOutcome,
} from "@/audit/retention";
import { createTlsProbe } from "@/audit/tls-probe";
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
import { createScriptContentCache } from "@/crawler/storage/script-cache";
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

    onProgress({ phase: "rules" });

    // Streamed (#1021): the pages are walked in batches, never held as one
    // array, and each batch's checks go to `rule_results` as they are produced.
    // The entity map (#2091) is built during the walk because the thirteen
    // `schema/entity-*` rules read it (#2093); a failure degrades to undefined
    // and those rules skip, it never fails an analyze.
    const sqlite = storage as SQLiteStorage;
    const tally = createCheckTally();
    const writer = createReplacingRuleResultsWriter(sqlite, crawlId);
    const { ruleResults, entityMap, pageStatuses } = await Effect.runPromise(
      analyzeStoredCrawl(sqlite, crawl, config, {
        pageSink: {
          writePage(pageUrl, entries) {
            for (const [, checks] of entries) tally.add(checks);
            return writer.writePage(pageUrl, entries);
          },
          flush: () => writer.flush(),
        },
      })
    );
    for (const checks of ruleResults.siteRuleResults.values()) {
      tally.add(checks);
    }
    await writer.writeSite(ruleResults.siteRuleResults);

    // The map built during the walk is written to the project store, exactly as
    // `squirrel audit` does, so re-analyzing a crawl refreshes its entity rows
    // instead of leaving the last audit's behind.
    if (entityMap && "saveEntityMap" in storage) {
      await storeEntityMap({
        storage: sqlite,
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
      pages: pageStatuses,
      project,
      byId: Boolean(options.crawlId),
      config,
      onRetention: options.onRetention,
    });

    const { checksTotal, passed, warnings, failed } = tally.totals();
    const rulesRun = ruleResults.tallies.size;

    logger.debug("analysis complete", `rules=${rulesRun}`);

    onProgress({
      phase: "complete",
      current: rulesRun,
      total: rulesRun,
    });

    return ok({
      crawlId,
      baseUrl,
      rulesRun,
      checksTotal,
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
      evidenceArchiveDir: config.storage.evidence_archive_dir,
      onHeldBack: (ids) =>
        logger.info(
          `kept ${ids.length} audit(s) past keep_audits: no verified evidence bundle in evidence_archive_dir`
        ),
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

type RuleRows = { ruleId: string; checks: CheckResult[] }[];

/**
 * Writes an analyze run's rule results in place of the crawl's previous ones
 * (#844), as the streaming pipeline produces them (#1021). `squirrel analyze`
 * re-runs the rules over a stored crawl, so a plain insert would append a second
 * copy of every check and the report would merge the two.
 *
 * The first write deletes the crawl's old results in the same SQLite
 * transaction as its inserts, so a first batch that fails to write keeps the
 * previous results. Later batches append. A run killed after the first batch
 * leaves a partial set, the same as `squirrel audit`'s spilled results; the
 * crawl is then left at its earlier status and the next analyze replaces it.
 * Nothing holds more than one batch of checks.
 */
export function createReplacingRuleResultsWriter(
  storage: SQLiteStorage,
  crawlId: string
) {
  let pending = new Map<string, RuleRows>();
  let replaced = false;

  const write = async (rows: Map<string, RuleRows>) => {
    if (rows.size === 0 && replaced) return;
    await Effect.runPromise(
      storage.saveRuleResultsBatch(crawlId, rows, { replace: !replaced })
    );
    replaced = true;
  };

  return {
    writePage(
      pageUrl: string,
      entries: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>
    ) {
      pending.set(
        pageUrl,
        entries.map(([ruleId, checks]) => ({
          ruleId,
          checks: checks as CheckResult[],
        }))
      );
    },
    async flush() {
      if (pending.size === 0) return;
      // Swap rather than clear: the write is async and the next batch's pages
      // must not land in a transaction already in flight.
      const rows = pending;
      pending = new Map();
      await write(rows);
    },
    /** Site-scope results under the empty page_url convention; always the last write. */
    async writeSite(siteResults: ReadonlyMap<string, CheckResult[]>) {
      await this.flush();
      const rows = new Map<string, RuleRows>();
      if (siteResults.size > 0) {
        rows.set(
          "",
          Array.from(siteResults, ([ruleId, checks]) => ({ ruleId, checks }))
        );
      }
      await write(rows);
    },
  };
}

/** Counts checks the way the analyze summary reports them, without keeping any. */
export function createCheckTally() {
  let checksTotal = 0;
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  return {
    add(checks: ReadonlyArray<unknown>) {
      for (const check of checks as CheckResult[]) {
        checksTotal++;
        if (check.status === "pass") passed++;
        else if (check.status === "warn") warnings++;
        else if (check.status === "fail") failed++;
      }
    },
    totals: () => ({ checksTotal, passed, warnings, failed }),
  };
}

/**
 * The asset phase, then the rules, over a stored crawl, both with the
 * crawl's own config ({@link configForCrawl}): the same asset phase
 * `squirrel audit` runs (#768, #799), through the same streaming pipeline
 * (#1021): one page batch is resident at a time, never the whole crawl.
 *
 * With a `pageSink` the page-scope checks go to it as they are produced and
 * the result carries site rules only; without one they are retained in the
 * result maps (tests and small callers).
 */
export function analyzeStoredCrawl(
  storage: SQLiteStorage,
  crawl: CrawlMetadata,
  config: Config,
  opts?: { pageSink?: PageResultSink; batchSize?: number }
) {
  const crawlConfig = configForCrawl(config, crawl);
  return Effect.gen(function* () {
    logger.debug("fetching resource assets", crawl.id);
    // Entity map (#2091): folded during the walk, built before the rules.
    const collector = createEntityMapCollector();
    let entityMapFailed = false;
    // normalizedUrl-free: status only, for the run status the retention pass derives.
    const pageStatuses: Array<{ status: number }> = [];
    const preRules = yield* runStreamingPreRules(
      storage,
      crawl.id,
      crawlConfig,
      {
        ...(opts?.batchSize ? { batchSize: opts.batchSize } : {}),
        resourceOverrides: {
          // squirrelscan/repo#3430: the site's own hosts are vetted and pinned.
          pinOwnHosts: pinOwnHosts(),
          scriptContentCache: createScriptContentCache(),
        },
        onBatchContext: (batchContext) => {
          for (const { page } of batchContext) {
            pageStatuses.push({ status: page.status });
          }
          if (entityMapFailed) return;
          try {
            collector.absorb(batchContext);
          } catch (error) {
            entityMapFailed = true;
            logger.warn(
              `Could not build the entity map: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        },
      }
    );
    let entityMap: EntityMap | undefined;
    if (!entityMapFailed) {
      try {
        entityMap = collector.build(entityMapSite(crawl));
      } catch (error) {
        logger.warn(
          `Could not build the entity map: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // Offline over stored data: no request tool, so a live-probe rule reports not-checked (#1269).
    clearRequestAsync();
    logger.debug("running rules on crawl", crawl.id);
    const ruleResults = yield* runStreamingRules(
      storage,
      crawl.id,
      crawlConfig,
      preRules.assets,
      {
        ...(entityMap ? { entityMap } : {}),
        // #712: security/tls-certificate's handshake, vetted and pinned. It
        // reads the certificate the site serves now, not at the crawl: the
        // one check here that does not come from the stored crawl.
        tlsProbe: createTlsProbe({
          siteUrl: crawl.baseUrl,
          proxyResolvesNames:
            crawlConfig.crawler?.tls_proxy_resolves_names === true,
        }),
      },
      {
        ...(opts?.batchSize ? { batchSize: opts.batchSize } : {}),
        ...(opts?.pageSink
          ? { pageSink: opts.pageSink, retainPageResults: false }
          : {}),
        // repo#3430: the end-of-crawl probes vet and pin the site's own hosts.
        pinOwnHosts: pinOwnHosts(),
      }
    );
    return { assets: preRules.assets, ruleResults, entityMap, pageStatuses };
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
