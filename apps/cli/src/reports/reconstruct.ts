// Reconstruct AuditReport from SQLite storage
// Rebuilds full report structure from crawl data

import type { ResponseHeaders as StoredResponseHeaders } from "@squirrelscan/core-contracts";

import { buildCacheStats } from "@squirrelscan/core-contracts";
import { loadAllRules, type RuleRunResult } from "@squirrelscan/rules";
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
export interface SmartMergeOverride {
  unionRuleResults: Map<string, RuleRunResult>;
  coverage: {
    auditedPages: number;
    knownPages: number;
    carriedFindings: number;
  };
  carriedLastSeen: Map<string, number>;
}

// Cookie values are crawl-session artifacts, not report content — publish
// keeps `security/cookie-flags` rule-input-only and never sends the raw
// Set-Cookie bytes onward (the publish schema doesn't accept `setCookie` and
// would silently drop it anyway, but by then the bytes have already ridden
// the wire and counted against the request body cap). `PageAudit.responseHeaders`
// is typed WITHOUT `setCookie` (see `@/types`), but `page.headers` (the
// storage-layer `ResponseHeaders` from core-contracts) carries it at
// runtime — assigning it straight through would leak the raw value despite
// the narrower static type.
function omitSetCookie(
  headers: StoredResponseHeaders
): Omit<StoredResponseHeaders, "setCookie"> {
  const { setCookie: _setCookie, ...responseHeaders } = headers;
  return responseHeaders;
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

/**
 * Reconstruct full AuditReport from stored crawl data
 */
export function reconstructReport(
  storage: SQLiteStorage,
  crawlId: string,
  smartMerge?: SmartMergeOverride
): Effect.Effect<AuditReport, Error, never> {
  return Effect.gen(function* () {
    // 1. Get crawl metadata
    const crawl = yield* storage.getCrawl(crawlId);
    if (!crawl) {
      return yield* Effect.fail(new Error(`Crawl not found: ${crawlId}`));
    }

    // 2. Get all pages for this crawl
    const pageRecords = yield* storage.getPages(crawlId);

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
          errors: [],
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
    const sitemaps: SitemapDiscovery | undefined =
      sitemapRecords.length > 0
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
          }
        : undefined;

    if (sitemaps) {
      const coverage = computeSitemapCoverage(
        pageRecords.map((p) => ({
          url: p.normalizedUrl,
          finalUrl: p.finalUrl,
          statusCode: p.status,
        })),
        sitemaps.discovered.flatMap((s: SitemapData) => s.urls)
      );
      sitemaps.orphanPages = coverage.orphanPages;
      sitemaps.missingPages = coverage.missingPages;
    }

    const resourceSizeRecords = yield* storage
      .getResourceSizes(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    const sitemapUrlStatusEntries = yield* storage
      .getSitemapUrlStatuses(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    // 5. Get all links (for broken links lookup)
    const links = yield* storage.getLinks(crawlId);

    // 6. Get rule results grouped by page and by rule_id
    const ruleResultsByPage = yield* storage.getRuleResultsByPage(crawlId);
    const ruleResultsByRuleId = yield* storage.getRuleResultsByRuleId(crawlId);

    // 7. Load rule registry to get metadata
    const ruleRegistry = loadAllRules();

    // Create lookup maps for link data
    const linkByHref = new Map(links.map((l) => [l.href, l]));

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

    for (const page of pageRecords) {
      // Parse page HTML if available
      const parsed = page.html ? parsePageRecord(page) : null;

      // Get links that appear on this page (per-page index lookup)
      const pageLinkAppearances = yield* storage.getLinkAppearancesForPage(
        crawlId,
        page.normalizedUrl
      );
      const pageLinks = pageLinkAppearances.map((a) => {
        const link = linkByHref.get(a.href);
        return {
          url: a.href,
          text: a.anchorText,
          isInternal: link?.isInternal ?? false,
          status: link?.status,
          error: link?.error,
        };
      });

      // Get images that appear on this page (per-page index lookup)
      const pageImageAppearances = yield* storage.getImageAppearancesForPage(
        crawlId,
        page.normalizedUrl
      );
      const pageImages = pageImageAppearances.map((a) => ({
        src: a.src,
        alt: a.alt ?? null,
        width: null,
        height: null,
      }));

      // Get rule results for this page
      const pageChecks = ruleResultsByPage.get(page.normalizedUrl) ?? [];

      // Build summary data
      if (parsed) {
        if (!parsed.meta.title) summary.missingTitles.push(page.normalizedUrl);
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

      // Check missing alt text
      for (const imgAppearance of pageImageAppearances) {
        if (!imgAppearance.alt || imgAppearance.alt.trim() === "") {
          summary.missingAltText.push({
            page: page.normalizedUrl,
            image: imgAppearance.src,
          });
        }
      }

      const pageAudit: PageAudit = {
        url: page.url,
        statusCode: page.status,
        loadTime: page.loadTimeMs,
        meta: parsed?.meta ?? {
          title: null,
          description: null,
          canonical: null,
          robots: null,
        },
        og: parsed?.og ?? {
          title: null,
          description: null,
          url: null,
          type: null,
          image: null,
          siteName: null,
        },
        twitter: parsed?.twitter ?? {
          card: null,
          title: null,
          description: null,
          image: null,
        },
        schema: parsed?.schema ?? {
          types: [],
          valid: true,
          errors: [],
          raw: null,
        },
        links: pageLinks,
        images: pageImages,
        h1Count: parsed?.h1.count ?? 0,
        h1Text: parsed?.h1.texts ?? [],
        checks: pageChecks,
        redirectChain: page.redirectChain,
        fetcherId: page.fetcherId,
        fallbackReason: page.fallbackReason,
        responseHeaders: omitSetCookie(page.headers),
        security: {
          isHttps: page.url.startsWith("https"),
          hasMixedContent: false,
          mixedContentUrls: [],
          insecureFormActions: [],
          headers: page.securityHeaders,
          httpToHttpsRedirect: false,
        },
      };

      pages.push(pageAudit);
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
    const runStatus = deriveAuditStatusFromPages(
      pageRecords,
      crawl.stats?.pagesBlocked ?? 0
    );

    // Smart re-audits reflect carried prior state, so keep "completed" when
    // some known pages were not re-crawled this run — knownPages > auditedPages
    // ⇒ carried pages exist (any carried findings live on them). A first run
    // with nothing carried falls back to this run's outcomes (#510).
    const auditStatus =
      smartMerge &&
      smartMerge.coverage.knownPages > smartMerge.coverage.auditedPages
        ? { status: "completed" as const, reason: undefined }
        : runStatus;

    // No real audit ⇒ null score (N/A), not 0. Parity with the cloud/live
    // builder (generateReportFromStorage) + the API's failed-report persist (#586).
    const reportHealthScore =
      auditStatus.status !== "completed"
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
        ? { status: auditStatus.status, statusReason: auditStatus.reason }
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
