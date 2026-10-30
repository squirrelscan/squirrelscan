// Generic report command - interface-agnostic

import { Effect } from "effect";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type {
  CrawlMetadata,
  CrawlStatus,
  PublishedReportRecord,
} from "@/crawler/storage/types";
import type {
  AuditReport,
  AuditStatus,
  AuditStatusReasonCode,
  CheckResult,
  ComponentOccurrence,
  ReportRuleResult,
  SiteResourceOccurrence,
} from "@/types";

// Extended crawl metadata with optional published info
export interface CrawlMetadataWithPublished extends CrawlMetadata {
  published?: PublishedReportRecord;
}

import { parseResolvedAuditSettings } from "@squirrelscan/core-contracts/audit-levels";
import { unpackComponentOccurrences } from "@squirrelscan/core-contracts/component-evidence";
import { unpackSiteResourceOccurrences } from "@squirrelscan/core-contracts/site-resource-evidence";
import { WITHHELD_SEED_REDIRECT_TARGET } from "@squirrelscan/report";

import {
  OUTPUT_FORMATS,
  OUTPUT_FORMATS_HELP,
  type OutputFormat,
} from "@/constants";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { warnEvictedPages } from "@/crawler/storage/eviction-notice";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import {
  reconstructReport,
  type ReconstructOptions,
} from "@/reports/reconstruct";
import { retiredAuditReason } from "@/reports/retired";
import {
  CATEGORIES,
  isValidCategory,
  normalizeCategoryCode,
} from "@/rules/categories";
import { getProjectsPath } from "@/self/paths";
import {
  isEquivalentAuditTarget,
  parseAuditTarget,
} from "@/utils/audit-target";

import { type Result, ok, err, commandError, ErrorCodes } from "./types";

export type { OutputFormat } from "@/constants";

const REPORT_READY_STATUSES = new Set<CrawlStatus>(["analyzed", "completed"]);

export function isReportReadyStatus(status: CrawlStatus): boolean {
  return REPORT_READY_STATUSES.has(status);
}

/**
 * Whether this audit can still be rendered (#1912).
 *
 * Takes the CRAWL rather than its status on purpose. `self disk --prune`
 * reclaims an audit's derived rows and leaves the crawl row saying `completed`,
 * so a status-only check reads a retired audit as renderable and the report path
 * rebuilds a confident EMPTY report from whatever pages survive. Every gate that
 * used to test the status now tests this, so a future one cannot quietly miss
 * the retired case.
 */
export function isReportRenderable(crawl: {
  status: CrawlStatus;
  retiredAt?: number;
}): boolean {
  return isReportReadyStatus(crawl.status) && crawl.retiredAt === undefined;
}

/** Why {@link isReportRenderable} said no, in the words the user should see. */
export function reportUnavailableReason(crawl: {
  status: CrawlStatus;
  retiredAt?: number;
}): string {
  if (crawl.retiredAt !== undefined) return retiredAuditReason(crawl.retiredAt);
  return getReportNotReadyReason(crawl.status);
}

export function getReportNotReadyReason(status: CrawlStatus): string {
  if (status === "running") return "still in progress";
  if (status === "paused") return "paused";
  if (status === "failed") return "failed";
  if (status === "crawled") return "crawled but not analyzed";
  if (status === "stopped") return "stopped before finishing, not yet analyzed";
  return `not reportable (${status})`;
}

export function validateReportData(
  report: AuditReport,
  crawlId: string
): Result<AuditReport> {
  if (report.totalPages === 0) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_READY,
        `Audit has no crawled pages yet: ${crawlId}`
      )
    );
  }

  const scoredChecks = report.passed + report.warnings + report.failed;
  if (scoredChecks === 0) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_READY,
        `Audit has no analyzed checks yet: ${crawlId}. Run 'squirrel analyze ${crawlId}' first.`
      )
    );
  }

  return ok(report);
}

interface SlimJsonReport {
  meta: {
    version: string;
    baseUrl: string;
    /**
     * A refused off-site seed redirect (#1418): `baseUrl` is what was graded,
     * this is where the seed pointed. `finalUrl` is null when the target was
     * withheld rather than serialized. Absent in slim JSON written before #1418.
     */
    seedRedirect?: {
      finalUrl: string | null;
      followed: false;
      note: string;
    };
    /** The start URL as given and the chain to the audited one (#1281). Untrusted. */
    originalUrl?: unknown;
    redirectChain?: unknown;
    timestamp: string;
    totalPages: number;
    /** Page cap in force (#1909); absent in slim JSON written before it. */
    maxPages?: number;
    /** Requested cap, present only when it was clamped (#1909). */
    requestedMaxPages?: number;
    /** URLs left queued, never fetched; absent when none were. Untrusted. */
    unfetched?: unknown;
    /** Smart audits (#110): this run's pages and the known ones. Untrusted. */
    coverage?: { auditedPages?: unknown };
    /** The audit level snapshot; absent in slim JSON written before audit levels. Untrusted. */
    auditLevel?: unknown;
  };
  // Audit validity (#801): absent in slim JSON written before #801 ⇒ completed.
  status?: AuditStatus;
  statusReason?: string;
  /** Machine-readable class behind `statusReason` (#1822); absent pre-#1822. */
  statusReasonCode?: AuditStatusReasonCode;
  /** What the `--max-duration` time limit cut (#1271). */
  maxDuration?: unknown;
  score: {
    overall: number | null; // null ⇒ N/A (failed/0-page audit, #586)
    grade: string;
    categories: Array<{ name: string; score: number }>;
  };
  summary: {
    passed: number;
    warnings: number;
    failed: number;
    /** Skipped-page count (#518); absent in slim JSON written before it. */
    skipped?: number;
  };
  /**
   * Evaluation gaps (#518). Not read back: skipped checks are not findings, so
   * they are never rebuilt into `ruleResults`.
   */
  skippedChecks?: unknown[];
  /** Info checks (#669). Not read back: they are notes, not findings. */
  infoChecks?: unknown[];
  issues: Array<{
    ruleId: string;
    name: string;
    description: string;
    solution?: string;
    domain: string;
    /** The category's display name ("Reliability"); absent in hand-built slim JSON. */
    category?: string;
    subcategory?: string;
    severity: "error" | "warning" | "info";
    checks: Array<{
      name: string;
      status: "fail" | "warn";
      message: string;
      affectedPages: string[];
      items?: Array<{ id: string; label?: string; sourcePages?: string[] }>;
      details?: Record<string, unknown>;
      /**
       * #2307 component evidence. Absent in slim JSON written before it, and
       * carried back through so `squirrel report -i <file>` renders the same
       * fix groups as the audit that produced the file. The serialized
       * `componentFixGroups` are deliberately NOT read back: they are derived,
       * and `groupIssuesByCategory` re-derives them from these occurrences, so
       * there is one source of truth rather than two that can disagree.
       */
      componentOccurrences?: unknown;
      /**
       * Lookup tables for the packed occurrences above. `ladders` must survive
       * the reimport: without it a repeated-subtree group re-derives from rows
       * whose ladder indices resolve to nothing, and the group id changes.
       */
      componentShapes?: { v: number; shapes: unknown[]; ladders?: unknown[] };
      componentEvidence?: CheckResult["componentEvidence"];
      /**
       * #2341 shared-resource evidence, packed. Read back for the same reason
       * as the component evidence above: the serialized `siteResourceFixGroups`
       * are derived, and `groupIssuesByCategory` re-derives them from this, so
       * there is one source of truth rather than two that can disagree.
       */
      siteResourceOccurrences?: unknown;
      siteResourceEvidence?: CheckResult["siteResourceEvidence"];
      legacyValue?: string;
    }>;
  }>;
}

function isSlimJsonReport(
  value: AuditReport | SlimJsonReport
): value is SlimJsonReport {
  return (
    typeof (value as SlimJsonReport)?.meta?.baseUrl === "string" &&
    Array.isArray((value as SlimJsonReport)?.issues)
  );
}

/** Category code for a category display name ("Reliability" → "reliability"); undefined when unknown. */
function categoryCodeByName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.trim().toLowerCase();
  return Object.values(CATEGORIES).find((c) => c.name.toLowerCase() === lower)
    ?.code;
}

/** A non-negative safe integer off user-supplied JSON, or undefined. */
function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Category code by display name, lowercased ("Reliability" → "reliability"). */
const CATEGORY_BY_NAME = new Map(
  Object.values(CATEGORIES).map((c) => [c.name.toLowerCase(), c.code as string])
);

function convertSlimReport(report: SlimJsonReport): AuditReport {
  const ruleResults: Record<string, ReportRuleResult> = {};

  for (const issue of report.issues) {
    // The issue's category NAME is what the export was rendered with, so it
    // wins (pub#836: `links/broken-links` is a Reliability rule). An export
    // whose name is unknown falls back to the id prefix, normalizing legacy
    // codes (stable `adblock/` ids under the renamed `blocking`).
    const byName =
      typeof issue.category === "string"
        ? CATEGORY_BY_NAME.get(issue.category.toLowerCase())
        : undefined;
    const categoryCandidate =
      byName ?? normalizeCategoryCode(issue.ruleId.split("/")[0] ?? "other");
    const category = isValidCategory(categoryCandidate)
      ? categoryCandidate
      : "other";

    const checks: CheckResult[] = [];

    for (const check of issue.checks) {
      // One check per affected page, so evidence is partitioned by page rather
      // than copied onto every row — the same rule `unfoldAggregateCheck`
      // follows. Copying the whole array onto each page would multiply every
      // occurrence by the page count.
      // Accepts the hoisted wire form and a plain occurrence array alike.
      const restored =
        unpackComponentOccurrences(
          check.componentShapes
            ? {
                ...check.componentShapes,
                occurrences: check.componentOccurrences,
              }
            : check.componentOccurrences
        ) ?? [];
      const occurrencesByPage = new Map<string, ComponentOccurrence[]>();
      for (const occurrence of restored) {
        const list = occurrencesByPage.get(occurrence.pageUrl);
        if (list) list.push(occurrence);
        else occurrencesByPage.set(occurrence.pageUrl, [occurrence]);
      }
      // Partitioned by page, never copied onto every row: the grouping keys on
      // which pages reference a resource, so duplicating the set across rows
      // would make every page claim every map.
      const restoredResources =
        unpackSiteResourceOccurrences(check.siteResourceOccurrences) ?? [];
      const resourcesByPage = new Map<string, SiteResourceOccurrence[]>();
      for (const occurrence of restoredResources) {
        const list = resourcesByPage.get(occurrence.pageUrl);
        if (list) list.push(occurrence);
        else resourcesByPage.set(occurrence.pageUrl, [occurrence]);
      }

      if (check.affectedPages.length > 0) {
        // Evidence for a page the serialized sample does not list cannot be
        // placed on a row without inventing one. Record the count instead.
        const sampled = new Set(check.affectedPages);
        const unplaceable = restored.filter(
          (occurrence) => !sampled.has(occurrence.pageUrl)
        );
        const evidence =
          check.componentEvidence ??
          (unplaceable.length > 0
            ? {
                state: "omitted" as const,
                reason: "page-sample-limit" as const,
                occurrenceCount: unplaceable.length,
              }
            : undefined);
        for (const [index, page] of check.affectedPages.entries()) {
          checks.push({
            name: check.name,
            status: check.status,
            message: check.message,
            pageUrl: page,
            items: check.items,
            details: check.details,
            value: check.legacyValue ?? null,
            componentOccurrences: occurrencesByPage.get(page),
            siteResourceOccurrences: resourcesByPage.get(page),
            // A whole-check fact cannot be split across rows; pin it to the
            // first, as the fold does with `details.additional`.
            componentEvidence: index === 0 ? evidence : undefined,
            siteResourceEvidence:
              index === 0 ? check.siteResourceEvidence : undefined,
          });
        }
      } else {
        checks.push({
          name: check.name,
          status: check.status,
          message: check.message,
          items: check.items,
          details: check.details,
          value: check.legacyValue ?? null,
          componentOccurrences: restored.length > 0 ? restored : undefined,
          componentEvidence: check.componentEvidence,
          siteResourceOccurrences:
            restoredResources.length > 0 ? restoredResources : undefined,
          siteResourceEvidence: check.siteResourceEvidence,
        });
      }
    }

    ruleResults[issue.ruleId] = {
      meta: {
        id: issue.ruleId,
        name: issue.name,
        description: issue.description,
        solution: issue.solution,
        category,
        ...(issue.subcategory ? { subcategory: issue.subcategory } : {}),
        scope: "page",
        severity: issue.severity,
        weight: 1,
      },
      checks,
    };
  }

  // The audit level the run used. The file is user-supplied, so the snapshot
  // is re-read through the shared parser: only valid levels and settings come
  // back, never a string the renderers would print as is.
  const auditLevel = parseResolvedAuditSettings(report.meta.auditLevel);

  // The pages this run crawled. A smart audit's `totalPages` is every known
  // page, carried ones included, so it would count a still-queued known page
  // twice next to `unfetched`, and call a run capped that never reached its
  // limit. The audit itself stamps this run's count (`report.pages.length`).
  const audited = report.meta.coverage?.auditedPages;
  const crawled = wholeCount(audited) ?? report.meta.totalPages;
  // A whole count only: the file is user-supplied, and the cloud's publish
  // schema rejects anything else.
  const unfetched = wholeCount(report.meta.unfetched);

  return {
    baseUrl: report.meta.baseUrl,
    // #1418: carry a refused off-site seed redirect back through the round
    // trip. Dropping it here would mean exporting JSON and re-rendering it
    // silently turns a report about a redirected seed back into what looks like
    // a clean audit. The file is user-supplied, so the declared type is a claim
    // and not a fact: anything that is not a string — a withheld target, or a
    // forged one — comes back as the sentinel and lands on the withheld
    // disclosure. A string is passed through and re-canonicalized at render
    // time, never trusted as-is.
    ...(report.meta.seedRedirect
      ? {
          finalUrl:
            typeof report.meta.seedRedirect.finalUrl === "string"
              ? report.meta.seedRedirect.finalUrl
              : WITHHELD_SEED_REDIRECT_TARGET,
        }
      : {}),
    // #1281: a followed start redirect, carried back through the round trip.
    // The file is user-supplied, so only strings and a bounded array of
    // {url, status} survive; the renderers re-canonicalize what is left.
    ...(typeof report.meta.originalUrl === "string"
      ? {
          originalUrl: report.meta.originalUrl,
          redirectChain: slimRedirectChain(report.meta.redirectChain),
        }
      : {}),
    timestamp: report.meta.timestamp,
    totalPages: report.meta.totalPages,
    // Rebuild the scan scope the slim JSON flattened into `meta` (#1909).
    // Without this, re-rendering a saved report loses both page limits and a
    // clamped run reads exactly like an unclamped one — which is the bug this
    // change exists to fix, reappearing one round trip later.
    ...(report.meta.maxPages !== undefined
      ? {
          scanScope: {
            origin: "cli" as const,
            maxPages: report.meta.maxPages,
            ...(report.meta.requestedMaxPages !== undefined
              ? { requestedMaxPages: report.meta.requestedMaxPages }
              : {}),
            pagesCrawled: crawled,
            capped: crawled >= report.meta.maxPages,
            ...(unfetched !== undefined ? { unfetched } : {}),
          },
        }
      : {}),
    ...(auditLevel ? { auditLevel } : {}),
    passed: report.summary.passed,
    warnings: report.summary.warnings,
    failed: report.summary.failed,
    ...(report.status ? { status: report.status } : {}),
    ...(report.statusReason ? { statusReason: report.statusReason } : {}),
    ...(report.statusReasonCode
      ? { statusReasonCode: report.statusReasonCode }
      : {}),
    ...(slimMaxDuration(report.maxDuration)
      ? { maxDuration: slimMaxDuration(report.maxDuration)! }
      : {}),
    siteChecks: [],
    pages: [],
    summary: {
      missingTitles: [],
      missingDescriptions: [],
      missingOgTags: [],
      missingTwitterCards: [],
      missingSchemas: [],
      missingAltText: [],
      multipleH1s: [],
      thinContentPages: [],
      urlIssues: [],
      redirectChains: [],
      securityIssues: [],
    },
    robotsTxt: undefined,
    sitemaps: undefined,
    healthScore: {
      overall: report.score.overall,
      categories: [],
      errorCount: report.summary.failed,
      warningCount: report.summary.warnings,
      passedCount: report.summary.passed,
    },
    ruleResults,
  };
}

/**
 * Get all project storage paths
 *
 * Exported for `controllers/entities.ts` (#2092), which walks the same set.
 */
export function getProjectStoragePaths(): string[] {
  const projectsDir = getProjectsPath();
  if (!existsSync(projectsDir)) return [];

  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(projectsDir, d.name, "project.db"))
    .filter((p) => existsSync(p));
}

/**
 * List stored audits with optional limit
 * Searches all project databases
 * Includes published report info if available
 */
export async function listStoredAudits(
  limit?: number,
  storagePath?: string
): Promise<Result<CrawlMetadataWithPublished[]>> {
  // If explicit path provided, use only that
  const dbPaths = storagePath ? [storagePath] : getProjectStoragePaths();

  if (dbPaths.length === 0) {
    return ok([]);
  }

  try {
    const allCrawls: CrawlMetadataWithPublished[] = [];

    for (const dbPath of dbPaths) {
      if (!existsSync(dbPath)) continue;

      const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
      try {
        const crawlsWithPublished = await Effect.runPromise(
          Effect.gen(function* () {
            yield* storage.init();
            const projectCrawls = yield* storage.listCrawls();

            // Batch fetch published info for all crawls (avoids N+1)
            const crawlIds = projectCrawls.map((c) => c.id);
            const publishedMap =
              yield* storage.getPublishedReportsBatch(crawlIds);

            // Enrich crawls with published info
            const enriched: CrawlMetadataWithPublished[] = projectCrawls.map(
              (crawl) => ({
                ...crawl,
                published: publishedMap.get(crawl.id) ?? undefined,
              })
            );
            return enriched;
          })
        );
        allCrawls.push(...crawlsWithPublished);
      } finally {
        await Effect.runPromise(
          storage.close().pipe(Effect.catchAll(() => Effect.void))
        );
      }
    }

    // Sort by startedAt descending (most recent first)
    allCrawls.sort((a, b) => b.startedAt - a.startedAt);

    return ok(limit ? allCrawls.slice(0, limit) : allCrawls);
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.FILE_READ_ERROR,
        `Failed to list audits: ${(error as Error).message}`
      )
    );
  }
}

/**
 * Where a loaded audit came from: the loaders below fill it in when they find
 * the audit, so a later write for that audit (`report --publish` marking it
 * published, #625) goes to the same database instead of searching for it again.
 */
export interface AuditSource {
  dbPath?: string;
}

/**
 * Get audit by ID from SQLite and reconstruct report
 * Searches all project databases if no explicit path given
 */
export async function getStoredAudit(
  auditId: string,
  storagePath?: string,
  source?: AuditSource,
  reconstruct?: ReconstructOptions
): Promise<Result<AuditReport>> {
  const dbPaths = storagePath ? [storagePath] : getProjectStoragePaths();

  if (dbPaths.length === 0) {
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        "No stored audits found. Run an audit first."
      )
    );
  }

  // Search all project databases for the audit ID
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;

    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      const crawl = await Effect.runPromise(
        Effect.gen(function* () {
          yield* storage.init();
          return yield* storage.getCrawl(auditId);
        })
      );

      if (!crawl) {
        continue;
      }

      if (!isReportRenderable(crawl)) {
        return err(
          commandError(
            ErrorCodes.CRAWL_NOT_READY,
            `Audit ${reportUnavailableReason(crawl)}: ${auditId}`
          )
        );
      }

      const report = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* reconstructReport(
            storage,
            auditId,
            undefined,
            reconstruct
          );
        })
      );
      await warnEvictedPages(storage, auditId, "report");

      const validated = validateReportData(report, auditId);
      if (!validated.ok) {
        return validated;
      }
      if (source) source.dbPath = dbPath;
      return ok(report);
    } catch {
      // Try next database
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }

  return err(
    commandError(ErrorCodes.FILE_NOT_FOUND, `Audit not found: ${auditId}`)
  );
}

/**
 * Get audit by ID prefix (8-char hex) from SQLite
 * Searches all project databases for matching IDs
 */
export async function getStoredAuditByPrefix(
  prefix: string,
  storagePath?: string,
  source?: AuditSource,
  reconstruct?: ReconstructOptions
): Promise<Result<AuditReport>> {
  const dbPaths = storagePath ? [storagePath] : getProjectStoragePaths();

  if (dbPaths.length === 0) {
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        "No stored audits found. Run an audit first."
      )
    );
  }

  // Collect all matching crawls across all DBs
  const allMatches: Array<{ crawl: CrawlMetadata; dbPath: string }> = [];

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;

    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      const matches = await Effect.runPromise(
        Effect.gen(function* () {
          yield* storage.init();
          return yield* storage.getCrawlsByPrefix(prefix);
        })
      );

      for (const crawl of matches) {
        allMatches.push({ crawl, dbPath });
      }
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }

  // No matches
  if (allMatches.length === 0) {
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        `No audit found with ID prefix: ${prefix}`
      )
    );
  }

  // Multiple matches - return list for disambiguation
  if (allMatches.length > 1) {
    const matchIds = allMatches.map((m) => m.crawl.id);
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        `Multiple audits match prefix "${prefix}":\n${matchIds.map((id) => `  ${id}`).join("\n")}\nPlease use a more specific prefix or the full ID.`
      )
    );
  }

  // Exactly one match - reconstruct report
  const match = allMatches[0];
  if (!isReportRenderable(match.crawl)) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_READY,
        `Audit ${reportUnavailableReason(match.crawl)}: ${match.crawl.id}`
      )
    );
  }

  const storage = new SQLiteStorage(match.dbPath, getGlobalContentStore());
  try {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        return yield* reconstructReport(
          storage,
          match.crawl.id,
          undefined,
          reconstruct
        );
      })
    );
    await warnEvictedPages(storage, match.crawl.id, "report");
    const validated = validateReportData(report, match.crawl.id);
    if (validated.ok && source) source.dbPath = match.dbPath;
    return validated;
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.FILE_READ_ERROR,
        `Failed to load audit: ${(error as Error).message}`
      )
    );
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
  }
}

/**
 * Get latest audit for a base URL
 * Searches all project databases
 */
export async function getLatestAudit(
  baseUrl?: string,
  storagePath?: string,
  source?: AuditSource,
  reconstruct?: ReconstructOptions
): Promise<Result<AuditReport>> {
  const dbPaths = storagePath ? [storagePath] : getProjectStoragePaths();

  if (dbPaths.length === 0) {
    return err(
      commandError(
        ErrorCodes.FILE_NOT_FOUND,
        "No stored audits found. Run an audit first."
      )
    );
  }

  try {
    // Collect all crawls from all databases
    const allCrawls: Array<{ crawl: CrawlMetadata; dbPath: string }> = [];

    for (const dbPath of dbPaths) {
      if (!existsSync(dbPath)) continue;

      const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
      try {
        const crawls = await Effect.runPromise(
          Effect.gen(function* () {
            yield* storage.init();
            const projectCrawls = yield* storage.listCrawls();
            return projectCrawls;
          })
        );

        for (const crawl of crawls) {
          allCrawls.push({ crawl, dbPath });
        }
      } finally {
        await Effect.runPromise(
          storage.close().pipe(Effect.catchAll(() => Effect.void))
        );
      }
    }

    // Filter by baseUrl if provided.
    // Prefer exact origin match first, then fallback to logical host equivalence
    // (apex/www and http/https variants).
    let filtered = allCrawls;
    if (baseUrl) {
      const requestTarget = parseAuditTarget(baseUrl);
      if (!requestTarget) {
        return err(
          commandError(ErrorCodes.INVALID_URL, `Invalid base URL: ${baseUrl}`)
        );
      }

      const exactMatches = allCrawls.filter(
        (c) => c.crawl.baseUrl === requestTarget.origin
      );
      if (exactMatches.length > 0) {
        filtered = exactMatches;
      } else {
        filtered = allCrawls.filter((c) => {
          const crawlTarget = parseAuditTarget(c.crawl.baseUrl);
          return (
            crawlTarget !== null &&
            isEquivalentAuditTarget(requestTarget, crawlTarget)
          );
        });
      }
    }

    if (filtered.length === 0) {
      return err(
        commandError(
          ErrorCodes.FILE_NOT_FOUND,
          baseUrl
            ? `No audits found for ${baseUrl}`
            : "No audits found. Run an audit first."
        )
      );
    }

    // A retired audit is not a candidate baseline: --diff and
    // --regression-since resolve through here, and reclaimed data cannot be
    // compared against.
    const reportReady = filtered.filter((c) => isReportRenderable(c.crawl));
    if (reportReady.length === 0) {
      const pending = filtered.find(
        (c) => c.crawl.status === "running" || c.crawl.status === "paused"
      );
      if (pending) {
        return err(
          commandError(
            ErrorCodes.CRAWL_NOT_READY,
            `Latest audit is ${pending.crawl.status}: ${pending.crawl.id}`
          )
        );
      }

      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_READY,
          baseUrl
            ? `No analyzed audits found for ${baseUrl}. Run 'squirrel analyze <crawl-id>' first.`
            : "No analyzed audits found. Run 'squirrel analyze <crawl-id>' first."
        )
      );
    }

    // Sort by startedAt descending and get latest
    reportReady.sort((a, b) => b.crawl.startedAt - a.crawl.startedAt);
    const latest = reportReady[0];

    // Reconstruct from the correct database
    const storage = new SQLiteStorage(latest.dbPath, getGlobalContentStore());
    try {
      const report = await Effect.runPromise(
        Effect.gen(function* () {
          yield* storage.init();
          const reconstructed = yield* reconstructReport(
            storage,
            latest.crawl.id,
            undefined,
            reconstruct
          );
          return reconstructed;
        })
      );
      await warnEvictedPages(storage, latest.crawl.id, "report");

      const validated = validateReportData(report, latest.crawl.id);
      if (validated.ok && source) source.dbPath = latest.dbPath;
      return validated;
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.FILE_READ_ERROR,
        `Failed to load latest audit: ${(error as Error).message}`
      )
    );
  }
}

/**
 * Load an audit report from a JSON file
 */
export function loadReport(inputPath: string): Result<AuditReport> {
  if (!existsSync(inputPath)) {
    return err(
      commandError(ErrorCodes.FILE_NOT_FOUND, `File not found: ${inputPath}`)
    );
  }

  try {
    const content = readFileSync(inputPath, "utf-8");
    const parsed = JSON.parse(content) as AuditReport | SlimJsonReport;

    if (isSlimJsonReport(parsed)) {
      return ok(convertSlimReport(parsed));
    }

    return ok(parsed);
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.FILE_READ_ERROR,
        `Failed to parse report: ${(error as Error).message}`,
        { path: inputPath }
      )
    );
  }
}

/**
 * Validate output format
 */
export function validateFormat(format: string): Result<OutputFormat> {
  if (!OUTPUT_FORMATS.includes(format as OutputFormat)) {
    return err(
      commandError(
        ErrorCodes.INVALID_FORMAT,
        `Unknown format: ${format}. Supported: ${OUTPUT_FORMATS_HELP}`
      )
    );
  }

  return ok(format as OutputFormat);
}

/** `maxDuration` from untrusted slim JSON (#1271): whole non-negative counts and a flag, else dropped. */
function slimMaxDuration(
  value: unknown
): AuditReport["maxDuration"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const count = (n: unknown): number | undefined =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
  const seconds = count(v.seconds);
  const unfetchedPages = count(v.unfetchedPages);
  const pagesNotEvaluated = count(v.pagesNotEvaluated);
  if (
    seconds === undefined ||
    unfetchedPages === undefined ||
    pagesNotEvaluated === undefined ||
    typeof v.siteChecksCut !== "boolean"
  ) {
    return undefined;
  }
  return {
    seconds,
    unfetchedPages,
    pagesNotEvaluated,
    siteChecksCut: v.siteChecksCut,
    ...(v.resourceChecksCut === true ? { resourceChecksCut: true } : {}),
  };
}

/** The chain from untrusted slim JSON: at most ten {url, status} entries, anything else dropped. */
function slimRedirectChain(
  value: unknown
): Array<{ url: string; status: number }> {
  if (!Array.isArray(value)) return [];
  const chain: Array<{ url: string; status: number }> = [];
  for (const hop of value.slice(0, 10)) {
    if (
      hop &&
      typeof hop === "object" &&
      typeof (hop as { url?: unknown }).url === "string"
    ) {
      const status = (hop as { status?: unknown }).status;
      chain.push({
        url: (hop as { url: string }).url,
        status:
          typeof status === "number" && Number.isInteger(status) ? status : 0,
      });
    }
  }
  return chain;
}
