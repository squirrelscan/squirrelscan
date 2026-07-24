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
  CheckResult,
  ReportRuleResult,
} from "@/types";

// Extended crawl metadata with optional published info
export interface CrawlMetadataWithPublished extends CrawlMetadata {
  published?: PublishedReportRecord;
}

import {
  OUTPUT_FORMATS,
  OUTPUT_FORMATS_HELP,
  type OutputFormat,
} from "@/constants";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";
import { isValidCategory, normalizeCategoryCode } from "@/rules/categories";
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
    timestamp: string;
    totalPages: number;
  };
  // Audit validity (#801): absent in slim JSON written before #801 ⇒ completed.
  status?: AuditStatus;
  statusReason?: string;
  score: {
    overall: number | null; // null ⇒ N/A (failed/0-page audit, #586)
    grade: string;
    categories: Array<{ name: string; score: number }>;
  };
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
  issues: Array<{
    ruleId: string;
    name: string;
    description: string;
    solution?: string;
    domain: string;
    subcategory?: string;
    severity: "error" | "warning" | "info";
    checks: Array<{
      name: string;
      status: "fail" | "warn";
      message: string;
      affectedPages: string[];
      items?: Array<{ id: string; label?: string; sourcePages?: string[] }>;
      details?: Record<string, unknown>;
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

function convertSlimReport(report: SlimJsonReport): AuditReport {
  const ruleResults: Record<string, ReportRuleResult> = {};

  for (const issue of report.issues) {
    // Normalize legacy code prefixes (e.g. stable rule IDs keep the `adblock/`
    // prefix while the category was renamed to `blocking`).
    const categoryCandidate = normalizeCategoryCode(
      issue.ruleId.split("/")[0] ?? "other"
    );
    const category = isValidCategory(categoryCandidate)
      ? categoryCandidate
      : "other";

    const checks: CheckResult[] = [];

    for (const check of issue.checks) {
      if (check.affectedPages.length > 0) {
        for (const page of check.affectedPages) {
          checks.push({
            name: check.name,
            status: check.status,
            message: check.message,
            pageUrl: page,
            items: check.items,
            details: check.details,
            value: check.legacyValue ?? null,
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

  return {
    baseUrl: report.meta.baseUrl,
    timestamp: report.meta.timestamp,
    totalPages: report.meta.totalPages,
    passed: report.summary.passed,
    warnings: report.summary.warnings,
    failed: report.summary.failed,
    ...(report.status ? { status: report.status } : {}),
    ...(report.statusReason ? { statusReason: report.statusReason } : {}),
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
 */
function getProjectStoragePaths(): string[] {
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
 * Get audit by ID from SQLite and reconstruct report
 * Searches all project databases if no explicit path given
 */
export async function getStoredAudit(
  auditId: string,
  storagePath?: string
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

      if (!isReportReadyStatus(crawl.status)) {
        return err(
          commandError(
            ErrorCodes.CRAWL_NOT_READY,
            `Audit ${getReportNotReadyReason(crawl.status)}: ${auditId}`
          )
        );
      }

      const report = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* reconstructReport(storage, auditId);
        })
      );

      const validated = validateReportData(report, auditId);
      if (!validated.ok) {
        return validated;
      }
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
  storagePath?: string
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
  if (!isReportReadyStatus(match.crawl.status)) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_READY,
        `Audit ${getReportNotReadyReason(match.crawl.status)}: ${match.crawl.id}`
      )
    );
  }

  const storage = new SQLiteStorage(match.dbPath, getGlobalContentStore());
  try {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        return yield* reconstructReport(storage, match.crawl.id);
      })
    );
    return validateReportData(report, match.crawl.id);
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
  storagePath?: string
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

    const reportReady = filtered.filter((c) =>
      isReportReadyStatus(c.crawl.status)
    );
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
            latest.crawl.id
          );
          return reconstructed;
        })
      );

      return validateReportData(report, latest.crawl.id);
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
