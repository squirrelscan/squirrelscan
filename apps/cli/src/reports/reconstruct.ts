// Reconstruct AuditReport from SQLite storage
// Rebuilds full report structure from crawl data

import type { PageFeatureRow } from "@squirrelscan/core-contracts";

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
import { retiredAuditReason } from "@/reports/retired";
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
  /**
   * The CARRIED half of the smart-audit union, per rule (#2343). The fresh half
   * is joined in below from this crawl's own `rule_results` rows, which this
   * function reads anyway — keeping a second copy of them alive from the rules
   * phase to here was the audit's largest retained term.
   */
  carriedRuleResults: Map<string, RuleRunResult>;
  /** Normalized URLs that returned 404/410; their fresh checks are not scored. */
  removedUrls: Set<string>;
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

/**
 * Rebuild the smart-audit UNION per rule: this crawl's own checks (read back from
 * `rule_results`, minus the ones on pages that returned 404/410) followed by the
 * carried checks the merge replayed (#2343).
 *
 * This is the join that lets the rules phase stop holding its output. It is the
 * same content, in the same order, the old in-memory union had: the fresh half
 * was `ruleResultsMap`, which is what those rows were written from, and
 * `buildScoringResultsFromMerged` appended the carried half after it. What DOES
 * change is the rule ORDER — `rule_results` comes back `ORDER BY rule_id`, where
 * the union was in first-seen-rule order — so a smart-audit report's `ruleResults`
 * keys are now in the same (alphabetical) order as a non-smart one's, which is
 * the order every other reader of this function already sees.
 *
 * Rules that only carried (nothing fresh this run) are appended after the fresh
 * ones, which is where the union put them too.
 */
export function joinSmartUnion(
  fresh: Map<string, CheckResult[]>,
  smartMerge: SmartMergeOverride
): Array<[string, CheckResult[]]> {
  const { carriedRuleResults, removedUrls } = smartMerge;
  const out: Array<[string, CheckResult[]]> = [];
  for (const [ruleId, checks] of fresh) {
    // Only page-scope checks carry a pageUrl; site-scope checks pass through.
    const kept =
      removedUrls.size === 0
        ? checks
        : checks.filter((c) => !(c.pageUrl && removedUrls.has(c.pageUrl)));
    const carried = carriedRuleResults.get(ruleId)?.checks as
      | CheckResult[]
      | undefined;
    out.push([ruleId, carried?.length ? [...kept, ...carried] : kept]);
  }
  for (const [ruleId, r] of carriedRuleResults) {
    if (fresh.has(ruleId)) continue;
    // A rule with neither fresh nor carried checks still belongs in the report
    // when the union had an entry for it: its `syntheticPassCount` is what keeps
    // clean carried pages in the pass-ratio denominator.
    out.push([ruleId, r.checks as CheckResult[]]);
  }
  return out;
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

    // `self disk --prune` reclaimed this audit's rule results (#1912). The pages
    // and the crawl row survive, so without this the walk below would assemble a
    // confident report with no findings at all — a wrong answer rather than a
    // missing one. Refused here, at the bottom of every render path, so a caller
    // that forgets the gate above still cannot produce one.
    if (crawl.retiredAt !== undefined) {
      return yield* Effect.fail(
        new Error(`Audit ${retiredAuditReason(crawl.retiredAt)}: ${crawlId}`)
      );
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

    // #2343: every scalar this walk wants off a parsed page was already computed
    // while the DOM was live, and now lands in `page_features`, so the second
    // full parse per page is gone.
    //
    // `getPageFeaturesPage` is keyset-ordered by normalized_url ASC and
    // `getPages` orders the same way, so the two walks advance together and the
    // buffer never holds more than one read's worth. They are NOT the same set:
    // a page outside the rule universe (a WAF interstitial, a non-HTML body) has
    // no features row, and neither does any page stored before schema v30 — so
    // this is a lookup with a fallback, not a zip. A miss re-parses exactly as
    // before, which is also what makes an ordering disagreement between SQLite's
    // BINARY collation and JS string `<` (possible only outside the BMP) cost
    // nothing but the parse it was avoiding.
    const featureBuf = new Map<string, PageFeatureRow>();
    let featureCursor: string | undefined;
    let featuresExhausted = false;

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
        // Advance the features walk to (at least) this page. Degrades to "no
        // row" rather than failing the report: the fallback parse produces the
        // same answer, just slower.
        while (
          !featuresExhausted &&
          (featureCursor === undefined || featureCursor < page.normalizedUrl)
        ) {
          const rows = yield* storage
            .getPageFeaturesPage(crawlId, {
              after: featureCursor,
              limit: batchSize,
            })
            .pipe(
              Effect.catchAll(() => Effect.succeed([] as PageFeatureRow[]))
            );
          if (rows.length === 0) {
            featuresExhausted = true;
            break;
          }
          for (const row of rows) featureBuf.set(row.normalizedUrl, row);
          featureCursor = rows[rows.length - 1]!.normalizedUrl;
          if (rows.length < batchSize) featuresExhausted = true;
        }
        const features = featureBuf.get(page.normalizedUrl) ?? null;
        // Consume it: every features row's URL is a stored page's URL, so the
        // buffer drains in step with the page walk instead of accumulating.
        if (features) featureBuf.delete(page.normalizedUrl);

        coverageInputs.push({
          url: page.normalizedUrl,
          finalUrl: page.finalUrl,
          statusCode: page.status,
        });
        pageStatuses.push({ status: page.status });
        // The stored scalars, or — only when this page has none — the parse they
        // replaced (#2343). `reportScalars` is null on a row written before
        // schema v30, so an audit stored by an older binary still reports the
        // same way, at the same cost.
        const scalars = features?.reportScalars ?? null;
        const parsed = scalars || !page.html ? null : parsePageRecord(page);
        const summarySignal = scalars
          ? {
              title: features?.title ?? null,
              description: features?.description ?? null,
              ogTitle: scalars.ogTitle,
              ogImage: features?.ogImage ?? null,
              twitterCard: scalars.twitterCard,
              schemaTypeCount: features?.schemaTypes.length ?? 0,
              h1Count: scalars.h1Count,
              thinContent: scalars.thinContent,
            }
          : parsed
            ? {
                title: parsed.meta.title,
                description: parsed.meta.description,
                ogTitle: parsed.og.title,
                ogImage: parsed.og.image,
                twitterCard: parsed.twitter.card,
                schemaTypeCount: parsed.schema.types.length,
                h1Count: parsed.h1.count,
                thinContent: parsed.content.isThinContent,
              }
            : null;

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
        if (summarySignal) {
          if (!summarySignal.title)
            summary.missingTitles.push(page.normalizedUrl);
          if (!summarySignal.description)
            summary.missingDescriptions.push(page.normalizedUrl);
          if (!summarySignal.ogTitle && !summarySignal.ogImage)
            summary.missingOgTags.push(page.normalizedUrl);
          if (!summarySignal.twitterCard)
            summary.missingTwitterCards.push(page.normalizedUrl);
          if (!summarySignal.schemaTypeCount)
            summary.missingSchemas.push(page.normalizedUrl);
          if (summarySignal.h1Count > 1)
            summary.multipleH1s.push(page.normalizedUrl);
          if (summarySignal.thinContent)
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
        // From the stored scalars when there are any (#2343) — those came out of
        // SQLite, so they are already standalone strings and there is nothing to
        // detach from. The parse branch still detaches: each of those strings is
        // a SLICE of this page's html, and in JSC a retained slice pins the whole
        // buffer it was cut from (#240). The batch is dropped a few lines later,
        // so an attached title would hold its page's megabyte. Measured on ~1 MB
        // pages: 77.5 MB retained across 80 pages attached, 2.1 MB detached.
        const kept = scalars
          ? {
              meta: {
                title: features?.title ?? null,
                description: features?.description ?? null,
                canonical: features?.canonical ?? null,
                robots: scalars.metaRobots,
              },
              og: {
                title: scalars.ogTitle,
                description: scalars.ogDescription,
                url: scalars.ogUrl,
                type: scalars.ogType,
                image: features?.ogImage ?? null,
                siteName: scalars.ogSiteName,
              },
            }
          : parsed
            ? detachFromPage(
                { meta: parsed.meta, og: parsed.og },
                "report-page"
              )
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

    // Re-read the stamp AFTER every page and rule-result read. The check above
    // happens once, outside any read transaction, so a `self disk --prune` in
    // another process can commit between it and the reads below — and this
    // function would then combine pre-retirement metadata with data that is
    // already gone and return a confident empty report, which is the exact
    // outcome the first check exists to prevent.
    const stillThere = yield* storage.getCrawl(crawlId);
    if (stillThere?.retiredAt !== undefined) {
      return yield* Effect.fail(
        new Error(
          `Audit ${retiredAuditReason(stillThere.retiredAt)}: ${crawlId}`
        )
      );
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
    // Scoring needs `syntheticPassCount`, which `ReportRuleResult` has no room
    // for; only the smart path populates it.
    const scoringResults = new Map<string, RuleRunResult>();
    const ruleSource: Iterable<[string, CheckResult[]]> = smartMerge
      ? joinSmartUnion(ruleResultsByRuleId, smartMerge)
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
      if (smartMerge) {
        // Meta from the union (or the registry), NOT from `result.meta` — the
        // report's meta is the trimmed display copy, and scoring reads the real
        // rule meta. A rule in neither is one the old union had no entry for
        // either, so it is skipped rather than scored on a fabricated meta.
        const carried = smartMerge.carriedRuleResults.get(ruleId);
        const scoringMeta = carried?.meta ?? rule?.meta;
        if (scoringMeta) {
          scoringResults.set(ruleId, {
            meta: scoringMeta,
            checks,
            ...(carried?.syntheticPassCount !== undefined
              ? { syntheticPassCount: carried.syntheticPassCount }
              : {}),
          });
        }
      }
    }

    // 13. Calculate health score.
    // Smart audits: score over the UNION (this run's checks minus removed pages,
    // plus carried fails, plus the synthetic-pass counts for clean carried pages)
    // so a partial re-audit does not inflate. `scoringResults` is the same rule
    // set and the same checks as `ruleResultsMap`; it exists only because the
    // synthetic-pass count has nowhere to live on a `ReportRuleResult`.
    const healthScore = smartMerge
      ? calculateHealthScore({ results: scoringResults })
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
