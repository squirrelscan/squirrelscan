// Reconstruct AuditReport from SQLite storage
// Rebuilds full report structure from crawl data

import { detachFromPage } from "@squirrelscan/audit-engine";
import { buildCacheStats } from "@squirrelscan/core-contracts";
import { loadAllRules, type RuleRunResult } from "@squirrelscan/rules";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";
import { Effect } from "effect";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";
import type {
  AuditReport,
  CheckResult,
  PageAudit,
  ReportRuleResult,
  SitemapData,
  SitemapDiscovery,
} from "@/types";

import { parsePageRecord } from "@/audit/adapter";
import {
  calculateHealthScore,
  deriveAuditStatusFromPages,
} from "@/audit/scoring";
import { tagCarriedCheck } from "@/audit/smart-audits";
import { OTHER_CATEGORY } from "@/rules/categories";
import { normalizeUrl } from "@/utils/url";

/**
 * Smart-audits (#110) merge override. When present, `reconstructReport` scores
 * + reports over the UNION of known pages instead of just this crawl's subset.
 */

/**
 * Hosts named in a rate-limit reason (#1829). Crawl-level throttling is by
 * definition the audited site's own host, and the stats carry a count rather
 * than a host list, so the base URL is the honest answer. Empty when nothing was
 * rate limited, which makes the reason fall back to "the host".
 */
function rateLimitedHosts(baseUrl: string, rateLimitedCount: number): string[] {
  if (rateLimitedCount <= 0) return [];
  try {
    return [new URL(baseUrl).hostname];
  } catch {
    return [];
  }
}

export interface SmartMergeOverride {
  unionRuleResults: Map<string, RuleRunResult>;
  coverage: {
    auditedPages: number;
    knownPages: number;
    /** Findings a PREVIOUS audit observed. 0 on a first run (#1652). */
    carriedFindings: number;
    /** Findings on pages no audit has ever rendered (#1652). Optional here (a
     *  consumer contract) so an override built from an older coverage shape
     *  still type-checks; `runSmartAudits` always supplies it. */
    unrenderedFindings?: number;
  };
  carriedLastSeen: Map<string, number>;
}

function computeSitemapCoverage(
  pages: Array<{ url: string; finalUrl?: string; statusCode: number }>,
  sitemapUrls: Array<{ loc: string }>
): { orphanPages: string[]; missingPages: string[] } {
  const sitemapUrlMap = new Map<string, string>();

  for (const url of sitemapUrls) {
    try {
      const normalized = normalizeUrl(url.loc);
      if (!sitemapUrlMap.has(normalized)) {
        sitemapUrlMap.set(normalized, url.loc);
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  const crawledUrls = new Set<string>();
  for (const page of pages) {
    try {
      crawledUrls.add(normalizeUrl(page.url));
    } catch {
      // Ignore invalid URLs
    }
    if (page.finalUrl && page.finalUrl !== page.url) {
      try {
        crawledUrls.add(normalizeUrl(page.finalUrl));
      } catch {
        // Ignore invalid URLs
      }
    }
  }

  const orphanPages: string[] = [];
  for (const [normalized, original] of sitemapUrlMap.entries()) {
    if (!crawledUrls.has(normalized)) {
      orphanPages.push(original);
    }
  }

  const missingPages: string[] = [];
  for (const page of pages) {
    if (page.statusCode !== 200) continue;
    const candidates = [page.url, page.finalUrl].filter(
      (candidate): candidate is string => !!candidate
    );
    let inSitemap = false;
    for (const candidate of candidates) {
      try {
        if (sitemapUrlMap.has(normalizeUrl(candidate))) {
          inSitemap = true;
          break;
        }
      } catch {
        // Ignore invalid URLs
      }
    }
    if (!inSitemap) {
      missingPages.push(page.url);
    }
  }

  return { orphanPages, missingPages };
}

/** Default page batch for the report's summary + pageAudits walk (#1913). */
export const RECONSTRUCT_PAGE_BATCH = 100;

export interface ReconstructOptions {
  /**
   * Pages read per `getPages` batch. The audit controller passes the same batch
   * the streamed rules phases used, so one setting describes the whole
   * post-crawl pipeline's residency.
   */
  batchSize?: number;
}

/**
 * Reconstruct full AuditReport from stored crawl data
 */
export function reconstructReport(
  storage: SQLiteStorage,
  crawlId: string,
  smartMerge?: SmartMergeOverride,
  options?: ReconstructOptions
): Effect.Effect<AuditReport, Error, never> {
  return Effect.gen(function* () {
    // Clamped: SQLite reads `LIMIT 0` as no limit, so a zero batch would return
    // the whole table every iteration while `offset += 0` never advanced.
    const batchSize = Math.max(1, options?.batchSize ?? RECONSTRUCT_PAGE_BATCH);
    // 1. Get crawl metadata
    const crawl = yield* storage.getCrawl(crawlId);
    if (!crawl) {
      return yield* Effect.fail(new Error(`Crawl not found: ${crawlId}`));
    }

    // 2. The crawl's pages are read in batches further down, not here (#1913).
    // A PageRecord carries the page's full html, so one `getPages(crawlId)`
    // held the whole crawl resident for the length of the report assembly —
    // a second page-count-scaled term landing on top of the rules phase's
    // peak. `getPages` orders by normalized_url ASC with or without
    // LIMIT/OFFSET, so the batched walk visits exactly the sequence the
    // resident array did: same summary entries, same page order, same report.

    // 3. Get robots.txt data
    const robotsRecord = yield* storage.getRobotsTxt(crawlId);
    const robotsTxt = robotsRecord
      ? {
          exists: robotsRecord.exists,
          url: robotsRecord.url,
          content: robotsRecord.content,
          sizeBytes: robotsRecord.sizeBytes,
          sitemaps: robotsRecord.sitemaps,
          rules: [],
          // Why the fetch produced nothing, when it did. Without this the CLI
          // report cannot tell a confirmed 404 from a probe that never got an
          // answer, and reports the second as a missing file (#1733).
          errors: robotsRecord.error ? [robotsRecord.error] : [],
        }
      : undefined;

    // 4. Get sitemap data
    const sitemapRecords = yield* storage.getSitemaps(crawlId);
    const sitemapUrlsMap = new Map<
      string,
      Array<{
        loc: string;
        lastmod?: string;
        changefreq?: string;
        priority?: number;
      }>
    >();
    for (const sitemap of sitemapRecords) {
      const urls = yield* storage
        .getSitemapUrls(crawlId, sitemap.url)
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      sitemapUrlsMap.set(
        sitemap.url,
        urls.map((u) => ({
          loc: u.loc,
          lastmod: u.lastmod,
          changefreq: u.changefreq,
          priority: u.priority,
        }))
      );
    }
    // A truncated walk with zero results still needs a sitemap section: it is
    // the only place the report can say the check did not complete, and
    // `undefined` reads downstream as "no data" rather than "not finished".
    const sitemapWalkTruncated =
      crawl.stats?.sitemapDiscoveryTruncated ?? false;
    const sitemaps: SitemapDiscovery | undefined =
      sitemapRecords.length > 0 || sitemapWalkTruncated
        ? {
            discovered: sitemapRecords.map((s) => ({
              url: s.url,
              type: s.type,
              urls: sitemapUrlsMap.get(s.url) ?? [],
              childSitemaps: s.childSitemaps,
              errors: s.errors,
              urlCount: s.urlCount,
            })),
            sources: {
              robotsTxt: robotsRecord?.sitemaps ?? [],
              commonLocations: [],
            },
            totalUrls: sitemapRecords.reduce((sum, s) => sum + s.urlCount, 0),
            orphanPages: [],
            missingPages: [],
            failed: [], // Not persisted to storage
            truncated: sitemapWalkTruncated,
          }
        : undefined;

    // Sitemap coverage needs one scalar triple per page, which the batched page
    // walk below collects; computed once it has them (pure, so moving it past
    // the walk changes nothing but when it runs).

    const resourceSizeRecords = yield* storage
      .getResourceSizes(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    const sitemapUrlStatusEntries = yield* storage
      .getSitemapUrlStatuses(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    // 6. Rule results, both groupings, from ONE read (#1920). The two readers
    // this replaces differed only in their ORDER BY and each built its own
    // CheckResult per row, so a crawl's checks were materialized twice: 203,687
    // rows at 1,000 pages, 204 per page. `getRuleResultsGrouped` shares one
    // object between the two maps and preserves both orders exactly.
    const { byPage: ruleResultsByPage, byRuleId: ruleResultsByRuleId } =
      yield* storage.getRuleResultsGrouped(crawlId);

    // 7. Load rule registry to get metadata
    const ruleRegistry = loadAllRules();

    // 8. Build PageAudit[] from page records with parsed data and rule results
    const pages: PageAudit[] = [];
    const summary: AuditReport["summary"] = {
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
    };

    // Scalars the sections after this walk need, so nothing has to keep a
    // PageRecord alive past the batch it arrived in: three fields for sitemap
    // coverage, the status for the audit-validity verdict + rate-limit count.
    const coverageInputs: Array<{
      url: string;
      finalUrl?: string;
      statusCode: number;
    }> = [];
    const pageStatuses: Array<{ status: number }> = [];

    for (let offset = 0; ; offset += batchSize) {
      // Fails rather than degrading: the whole-crawl read this replaced
      // propagated its StorageError too, and ending a BATCHED walk early would
      // publish a confident report over a truncated page set instead.
      const batch = yield* storage.getPages(crawlId, {
        limit: batchSize,
        offset,
      });
      if (batch.length === 0) break;

      for (const page of batch) {
        coverageInputs.push({
          url: page.normalizedUrl,
          finalUrl: page.finalUrl,
          statusCode: page.status,
        });
        pageStatuses.push({ status: page.status });
        // Parse page HTML if available
        const parsed = page.html ? parsePageRecord(page) : null;

        // Image appearances still drive `summary.missingAltText`, which IS
        // emitted. The per-page LINK query that used to sit here, and the
        // whole-crawl `getLinks` that fed it, are gone with `PageAudit.links`
        // (#1938): two queries per page and their arrays, for a field no
        // consumer read.
        const pageImageAppearances = yield* storage.getImageAppearancesForPage(
          crawlId,
          page.normalizedUrl
        );

        // Get rule results for this page
        const pageChecks = ruleResultsByPage.get(page.normalizedUrl) ?? [];

        // Build summary data
        if (parsed) {
          if (!parsed.meta.title)
            summary.missingTitles.push(page.normalizedUrl);
          if (!parsed.meta.description)
            summary.missingDescriptions.push(page.normalizedUrl);
          if (!parsed.og.title && !parsed.og.image)
            summary.missingOgTags.push(page.normalizedUrl);
          if (!parsed.twitter.card)
            summary.missingTwitterCards.push(page.normalizedUrl);
          if (!parsed.schema.types.length)
            summary.missingSchemas.push(page.normalizedUrl);
          if (parsed.h1.count > 1) summary.multipleH1s.push(page.normalizedUrl);
          if (parsed.content.isThinContent)
            summary.thinContentPages.push(page.normalizedUrl);
        }

        // Check missing alt text. alt="" is the correct markup for a decorative
        // image (HTML spec, WCAG H67), so only an absent attribute counts (#143).
        for (const imgAppearance of pageImageAppearances) {
          if (imgAppearance.alt === undefined || imgAppearance.alt === null) {
            summary.missingAltText.push({
              page: page.normalizedUrl,
              image: imgAppearance.src,
            });
          }
        }

        // `meta` and `og` are the only DOM-derived fields still kept: publish
        // reads them off the home page to seed the website record's title and
        // description (`pickHomepageSummary`). Everything else the parse
        // produced had no reader and is no longer carried (#1938).
        //
        // Detached because each of those strings is a SLICE of this page's html,
        // and in JSC a retained slice pins the whole buffer it was cut from
        // (#240). The batch is dropped a few lines later, so an attached title
        // would hold its page's megabyte. Measured on ~1 MB pages: 77.5 MB
        // retained across 80 pages attached, 2.1 MB detached.
        const kept = parsed
          ? detachFromPage({ meta: parsed.meta, og: parsed.og }, "report-page")
          : null;

        const pageAudit: PageAudit = {
          url: page.url,
          statusCode: page.status,
          meta: kept?.meta ?? {
            title: null,
            description: null,
            canonical: null,
            robots: null,
          },
          og: kept?.og ?? {
            title: null,
            description: null,
            url: null,
            type: null,
            image: null,
            siteName: null,
          },
          checks: pageChecks,
          redirectChain: page.redirectChain,
          fetcherId: page.fetcherId,
          fallbackReason: page.fallbackReason,
        };

        pages.push(pageAudit);
      }

      if (batch.length < batchSize) break;
    }

    if (sitemaps) {
      const coverage = computeSitemapCoverage(
        coverageInputs,
        sitemaps.discovered.flatMap((s: SitemapData) => s.urls)
      );
      sitemaps.orphanPages = coverage.orphanPages;
      sitemaps.missingPages = coverage.missingPages;
    }

    // 9. Calculate totals from rule results
    const allChecks: CheckResult[] = Array.from(
      ruleResultsByPage.values()
    ).flat();
    const scorableChecks = allChecks.filter(
      (c) => c.status !== "skipped" && c.status !== "info"
    );
    const passed = scorableChecks.filter((c) => c.status === "pass").length;
    const warnings = scorableChecks.filter((c) => c.status === "warn").length;
    const failed = scorableChecks.filter((c) => c.status === "fail").length;

    // 11. Get site-level checks (page_url = '' convention)
    const siteChecks = ruleResultsByPage.get("") ?? [];

    // 12. Build ruleResults with metadata from registry.
    //
    // Smart audits (#110): when a merge override is supplied, source the rule
    // results from the UNION map (fresh + carried) instead of this crawl's
    // subset. Carried-clean passes keep the score honest but are a scoring-only
    // count now (syntheticPassCount, #918) — never in `checks` — so there are no
    // synthetic "pass" rows to drop here.
    const ruleResults: Record<string, ReportRuleResult> = {};
    const ruleResultsMap = new Map<string, ReportRuleResult>();
    const ruleSource: Iterable<[string, CheckResult[]]> = smartMerge
      ? Array.from(smartMerge.unionRuleResults).map(
          ([ruleId, r]): [string, CheckResult[]] => [
            ruleId,
            r.checks as CheckResult[],
          ]
        )
      : ruleResultsByRuleId;

    for (const [ruleId, checks] of ruleSource) {
      // Tag carried findings for provenance surfacing.
      if (smartMerge) {
        for (const check of checks) {
          tagCarriedCheck(
            check.pageUrl ?? "",
            ruleId,
            check,
            smartMerge.carriedLastSeen
          );
        }
      }
      const rule = ruleRegistry.get(ruleId);
      const result: ReportRuleResult = rule
        ? {
            meta: {
              id: rule.meta.id,
              name: rule.meta.name,
              description: rule.meta.description,
              solution: rule.meta.solution,
              category: rule.meta.category,
              subcategory: rule.meta.subcategory,
              scope: rule.meta.scope,
              severity: rule.meta.severity,
              weight: rule.meta.weight,
            },
            checks,
          }
        : {
            // Rule not in registry (possibly deleted) - use fallback metadata
            meta: {
              id: ruleId,
              name: ruleId,
              description: "",
              category: OTHER_CATEGORY,
              scope: "page",
              severity: "warning",
              weight: 1,
            },
            checks,
          };

      if (!rule) {
        console.warn(`Rule not found in registry: ${ruleId}`);
      }

      ruleResults[ruleId] = result;
      ruleResultsMap.set(ruleId, result);
    }

    // 13. Calculate health score.
    // Smart audits: score over the UNION map (includes carried fails + synthetic
    // passes for clean carried pages) so a partial re-audit does not inflate.
    const healthScore = smartMerge
      ? calculateHealthScore({ results: smartMerge.unionRuleResults })
      : calculateHealthScore({ results: ruleResultsMap });

    const resourceSizes = {
      css: resourceSizeRecords
        .filter((record) => record.type === "css")
        .map((record) => ({
          url: record.url,
          status: record.status,
          error: record.error,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          sourcePages: record.sourcePages,
        })),
      images: resourceSizeRecords
        .filter((record) => record.type === "image")
        .map((record) => ({
          url: record.url,
          status: record.status,
          error: record.error,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          sourcePages: record.sourcePages,
        })),
    };

    // Smart audits: recompute passed/warnings/failed over the UNION rule checks
    // (carried fails included; synthetic clean-carried passes excluded above),
    // and surface totalPages = all known non-removed pages + coverage.
    let unionPassed = passed;
    let unionWarnings = warnings;
    let unionFailed = failed;
    if (smartMerge) {
      unionPassed = 0;
      unionWarnings = 0;
      unionFailed = 0;
      for (const result of Object.values(ruleResults)) {
        for (const c of result.checks) {
          if (c.status === "pass") unionPassed++;
          else if (c.status === "warn") unionWarnings++;
          else if (c.status === "fail") unionFailed++;
        }
      }
    }

    // Aggregate cache stats (#108) — pages (crawl.stats) + sub-resources.
    // Absent on a cold run (no reuse), so the panel/line only shows when there
    // is something to report.
    const cacheStats =
      buildCacheStats(crawl.stats, resourceSizeRecords) ?? undefined;

    // Audit validity (#489): a down/403/0-page crawl must not publish "A/100%".
    // Shared with the cloud/live report builder (generateReportFromStorage) so
    // both paths detect a failed/blocked audit identically. #792: the crawl's
    // blocked-fetch count classifies a walled root page (0 stored pages) as
    // `blocked` rather than a generic empty crawl.
    // #1829: a rate-limited fetch stores no page, so crawl stats carry the
    // count; a stored 429/430 page adds to it.
    const rateLimitedCount =
      (crawl.stats?.pagesRateLimited ?? 0) +
      pageStatuses.filter((p) => isRateLimitStatus(p.status)).length;
    const runStatus = deriveAuditStatusFromPages(
      pageStatuses,
      crawl.stats?.pagesBlocked ?? 0,
      {
        // #1829: a rate-limited fetch stores no page, so the count comes from
        // crawl stats. A crawl that gathered content but lost pages to
        // throttling reports `partial`, not `completed`.
        errors: crawl.stats?.pagesRateLimited ?? 0,
        hosts: rateLimitedHosts(
          crawl.baseUrl,
          crawl.stats?.pagesRateLimited ?? 0
        ),
      },
      // #1822: the CLI forks the engine's report path, so the crawler's root
      // failure has to be threaded here too or `squirrel audit` keeps printing
      // the generic reason the cloud no longer prints.
      crawl.stats?.rootFailure
    );

    // Smart re-audits reflect carried prior state, so keep "completed" when
    // some known pages were not re-crawled this run — knownPages > auditedPages
    // ⇒ carried pages exist (any carried findings live on them). A first run
    // with nothing carried falls back to this run's outcomes (#510).
    // #1829: a rate-limit partial is NOT the carried-page case this override
    // exists for. Carried pages mean "we already know about these"; rate-limited
    // pages mean "we could not check these THIS run", which is exactly what the
    // reader needs to see. Letting the smart-audit override swallow it would
    // hide the coverage loss on every re-audit.
    const auditStatus =
      smartMerge &&
      smartMerge.coverage.knownPages > smartMerge.coverage.auditedPages &&
      rateLimitedCount === 0
        ? {
            status: "completed" as const,
            reason: undefined,
            reasonCode: undefined,
          }
        : runStatus;

    // No real audit ⇒ null score (N/A), not 0. Parity with the cloud/live
    // builder (generateReportFromStorage) + the API's failed-report persist (#586).
    // `partial` keeps its score (#1829): the pages that WERE audited were graded
    // normally, and only the coverage is incomplete.
    const reportHealthScore =
      auditStatus.status === "failed" || auditStatus.status === "blocked"
        ? { ...healthScore, overall: null }
        : healthScore;

    // 14. Build final report
    // #512: pages recovered via a non-browser fallback after a render block.
    const renderBlockRecovered = pages.filter(
      (p) => p.fallbackReason === "render-block"
    ).length;

    const report: AuditReport = {
      crawlId,
      baseUrl: crawl.baseUrl,
      timestamp: new Date(crawl.startedAt).toISOString(),
      totalPages: smartMerge ? smartMerge.coverage.knownPages : pages.length,
      passed: unionPassed,
      warnings: unionWarnings,
      failed: unionFailed,
      siteChecks,
      pages,
      summary,
      robotsTxt,
      sitemaps,
      healthScore: reportHealthScore,
      ruleResults,
      resourceSizes,
      sitemapUrlStatuses: sitemapUrlStatusEntries,
      // Only stamp when not a normal completed run; absent ⇒ completed (#489).
      ...(auditStatus.status !== "completed"
        ? {
            status: auditStatus.status,
            statusReason: auditStatus.reason,
            statusReasonCode: auditStatus.reasonCode,
          }
        : {}),
      // #1829: coverage lost to throttling, in a form renderers can count
      // rather than parse out of the reason prose.
      ...(rateLimitedCount > 0
        ? {
            rateLimited: {
              pages: rateLimitedCount,
              hosts: rateLimitedHosts(crawl.baseUrl, rateLimitedCount),
            },
          }
        : {}),
      ...(smartMerge ? { coverage: smartMerge.coverage } : {}),
      ...(cacheStats ? { cacheStats } : {}),
      ...(renderBlockRecovered > 0
        ? { fetchFallbacks: { recovered: renderBlockRecovered } }
        : {}),
    };

    return report;
  });
}
