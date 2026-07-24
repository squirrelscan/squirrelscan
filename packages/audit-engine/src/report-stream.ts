// Report assembly, extracted from adapter.ts (#1021, PR-F).
//
// buildV1Report is the byte-identical twin of the former
// adapter.generateReportFromStorage body — adapter now delegates to it. It lives
// in its own module so (a) a bounded streaming v2 (E-G) can sit beside v1 without
// re-touching adapter, and (b) both the engine path and the (currently dead) CLI
// fork share ONE assembly core.
//
// Imports the injected logger from ./adapter-logger (NOT ./adapter) so this module
// never imports adapter — adapter imports buildV1Report/buildRobotsData back, and a
// cycle would otherwise form.

import { Effect } from "effect";

import { capChecksForPublish, capMixedRuleChecksForPublish } from "@squirrelscan/rules";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import { logger } from "./adapter-logger";
import {
  calculateHealthScore,
  calculateHealthScoreFromTallies,
  deriveAuditStatus,
  deriveAuditStatusFromPages,
  type RuleTally,
} from "./scoring";

import type {
  CrawlStorage,
  RobotsTxtRecord,
  ImageAppearanceRecord,
} from "@squirrelscan/core-contracts/storage";
import type {
  AuditReport,
  CheckResult,
  HealthScore,
  MetaData,
  OpenGraphData,
  RedirectChain,
  ReportRuleResult,
  ResourceSizeData,
  RobotsTxtData,
  SchemaData,
  SitemapDiscovery,
  SitemapUrlStatusData,
  TwitterData,
} from "@squirrelscan/core-contracts";
import type { ParsedPage, RuleRunResult } from "@squirrelscan/rules";

// ============================================
// SITE-RECORD BUILDERS
// ============================================

export function buildRobotsData(robots: RobotsTxtRecord | null): RobotsTxtData | null {
  if (!robots) return null;

  let rules: RobotsTxtData["rules"] = [];
  let errors: string[] = [];

  if (robots.content) {
    const parsed = parseRobotsTxt(robots.content, robots.url);
    rules = parsed.rules;
    errors = parsed.errors;
  }

  return {
    exists: robots.exists,
    url: robots.url,
    content: robots.content,
    sizeBytes: robots.sizeBytes,
    sitemaps: robots.sitemaps,
    rules,
    errors,
  };
}

// ============================================
// RULE EXECUTION
// ============================================

export interface RuleExecutionResult {
  pageResults: Map<string, CheckResult[]>;
  /** Per-page rule results with proper rule IDs for storage */
  pageRuleResults: Map<string, Map<string, CheckResult[]>>;
  siteResults: CheckResult[];
  /** Site-scope rule results with proper rule IDs for storage (keyed by rule ID) */
  siteRuleResults: Map<string, CheckResult[]>;
  ruleResultsMap: Map<string, RuleRunResult>;
  /** Cached parsed page data - reuse to avoid redundant parsing */
  parsedPages: Map<string, ParsedPage>;
  resourceSizes: {
    css: ResourceSizeData[];
    images: ResourceSizeData[];
  };
  sitemapUrlStatuses: SitemapUrlStatusData[];
}

/** Empty rule results — used to build a report when no rules ran (0-page audit, #586). */
export function emptyRuleExecutionResult(): RuleExecutionResult {
  return {
    pageResults: new Map(),
    pageRuleResults: new Map(),
    siteResults: [],
    siteRuleResults: new Map(),
    ruleResultsMap: new Map(),
    parsedPages: new Map(),
    resourceSizes: { css: [], images: [] },
    sitemapUrlStatuses: [],
  };
}

function toReportRuleResults(
  ruleResults: Map<string, RuleRunResult>,
): Record<string, ReportRuleResult> {
  const entries: Array<[string, ReportRuleResult]> = [];

  for (const [ruleId, result] of ruleResults) {
    const { meta, checks } = result;
    entries.push([
      ruleId,
      {
        meta: {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          solution: meta.solution,
          category: meta.category,
          scope: meta.scope,
          severity: meta.severity,
          weight: meta.weight,
        },
        // Per-page rules overflow maxChecksPerRule on 500+ page crawls; fold
        // over-cap arrays into per-issue-class aggregates instead of letting
        // the publish schema slice pages off silently (#910/#817). Scoring
        // above reads the un-folded map, so scores are unaffected. Clamps
        // oversize item ids (#996) and any single check's oversize items
        // array (#1003) before folding.
        checks: capChecksForPublish(checks, REPORT_LIMITS.maxChecksPerRule),
      },
    ]);
  }

  return Object.fromEntries(entries);
}

// ============================================
// REPORT GENERATION
// ============================================

export interface PageAudit {
  url: string;
  statusCode: number;
  loadTime: number;
  meta: MetaData;
  og: OpenGraphData;
  twitter: TwitterData;
  schema: SchemaData;
  links: Array<{ url: string; text: string; isInternal: boolean }>;
  images: Array<{ src: string; alt: string | null; width: string | null; height: string | null }>;
  h1Count: number;
  h1Text: string[];
  checks: CheckResult[];
  redirectChain?: RedirectChain;
  /** Which egress/method served this page + any fallback reason (#512). */
  fetcherId?: string;
  fallbackReason?: string;
}

export interface AuditSummary {
  missingTitles: string[];
  missingDescriptions: string[];
  missingOgTags: string[];
  missingTwitterCards: string[];
  missingSchemas: string[];
  missingAltText: Array<{ page: string; image: string }>;
  multipleH1s: string[];
  thinContentPages: string[];
  urlIssues: string[];
  redirectChains: string[];
  securityIssues: string[];
}

export interface FullAuditReport extends AuditReport {
  siteChecks: CheckResult[];
  pages: PageAudit[];
  summary: AuditSummary;
  robotsTxt?: RobotsTxtData;
  sitemaps?: SitemapDiscovery;
  resourceSizes?: { css: ResourceSizeData[]; images: ResourceSizeData[] };
  sitemapUrlStatuses?: SitemapUrlStatusData[];
}

/**
 * Build a FullAuditReport from crawler storage — the v1 (non-streaming) path.
 *
 * Moved verbatim from adapter.generateReportFromStorage (#1021, PR-F); adapter's
 * exported generateReportFromStorage is now a one-line delegate to this. Keeping
 * it byte-identical is the 518-page golden-diff gate.
 */
export function buildV1Report(
  storage: CrawlStorage,
  crawlId: string,
  ruleResults: RuleExecutionResult,
): Effect.Effect<FullAuditReport, never, never> {
  return Effect.gen(function* () {
    const reportSpan = logger.traceStart("generateReportFromStorage");
    const crawl = yield* storage
      .getCrawl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const pages = yield* storage.getPages(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])));

    const links = yield* storage.getLinks(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])));

    const images = yield* storage
      .getImages(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    const robots = yield* storage
      .getRobotsTxt(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const sitemaps = yield* storage
      .getSitemaps(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    // Create lookup maps for link data
    const linkByHref = new Map(links.map((l) => [l.href, l]));

    // Check if storage supports per-page index lookups
    const hasSqliteStorage = "getLinkAppearancesForPage" in storage;

    // Build summary
    const summary: AuditSummary = {
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

    // Use cached parsed pages for summary (optimization: no redundant parsing)
    const summaryParseSpan = logger.traceStart("summary:useCachedParsed");
    for (const page of pages) {
      const parsed = ruleResults.parsedPages.get(page.normalizedUrl);
      if (!parsed) continue;

      if (!parsed.meta.title) summary.missingTitles.push(page.normalizedUrl);
      if (!parsed.meta.description) summary.missingDescriptions.push(page.normalizedUrl);
      if (!parsed.og.title && !parsed.og.image) summary.missingOgTags.push(page.normalizedUrl);
      if (!parsed.twitter.card) summary.missingTwitterCards.push(page.normalizedUrl);
      if (!parsed.schema.types.length) summary.missingSchemas.push(page.normalizedUrl);
      if (parsed.h1.count > 1) summary.multipleH1s.push(page.normalizedUrl);
      if (parsed.content.isThinContent) summary.thinContentPages.push(page.normalizedUrl);
    }
    logger.traceEnd(summaryParseSpan, { pageCount: pages.length });

    // Check missing alt text (batch query when available)
    const imageAppearancesSpan = logger.traceStart("imageAppearances");

    // Batch fetch all image appearances if available
    const hasBatchImageMethod = "getAllImageAppearancesBySrc" in storage;
    const allImageAppearancesBySrc: Map<string, ImageAppearanceRecord[]> = hasBatchImageMethod
      ? yield* (storage as import("@squirrelscan/crawler").SQLiteStorage)
          .getAllImageAppearancesBySrc(crawlId)
          .pipe(Effect.catchAll(() => Effect.succeed(new Map<string, ImageAppearanceRecord[]>())))
      : new Map<string, ImageAppearanceRecord[]>();

    let imageQueryCount = 0;
    for (const image of images) {
      // Use batch map if available, else fallback to individual query
      const appearances = hasBatchImageMethod
        ? (allImageAppearancesBySrc.get(image.src) ?? [])
        : yield* storage
            .getImageAppearances(crawlId, image.src)
            .pipe(Effect.catchAll(() => Effect.succeed([])));
      if (!hasBatchImageMethod) imageQueryCount++;

      const hasAlt = appearances.some((a) => a.alt && a.alt.trim() !== "");
      if (!hasAlt) {
        for (const appearance of appearances) {
          summary.missingAltText.push({
            page: appearance.pageUrl,
            image: image.src,
          });
        }
      }
    }
    logger.traceEnd(imageAppearancesSpan, {
      queries: hasBatchImageMethod ? 1 : imageQueryCount,
    });

    // Calculate health score
    const healthScore: HealthScore = calculateHealthScore({
      results: ruleResults.ruleResultsMap,
    });

    // Build page audits (optimization: use cached parsed pages)
    const pageAuditsSpan = logger.traceStart("pageAudits:useCachedParsed");
    const pageAudits: PageAudit[] = [];
    for (const page of pages) {
      const parsed = ruleResults.parsedPages.get(page.normalizedUrl) ?? null;
      const pageChecks = ruleResults.pageResults.get(page.normalizedUrl) ?? [];

      // Get links for this page using per-page index lookup
      const pageLinkAppearances = hasSqliteStorage
        ? yield* (storage as import("@squirrelscan/crawler").SQLiteStorage)
            .getLinkAppearancesForPage(crawlId, page.normalizedUrl)
            .pipe(Effect.catchAll(() => Effect.succeed([])))
        : [];
      const pageLinks = pageLinkAppearances.map((a) => ({
        url: a.href,
        text: a.anchorText,
        isInternal: linkByHref.get(a.href)?.isInternal ?? false,
      }));

      // Get images for this page using per-page index lookup
      const pageImageAppearances = hasSqliteStorage
        ? yield* (storage as import("@squirrelscan/crawler").SQLiteStorage)
            .getImageAppearancesForPage(crawlId, page.normalizedUrl)
            .pipe(Effect.catchAll(() => Effect.succeed([])))
        : [];
      const pageImages = pageImageAppearances.map((a) => ({
        src: a.src,
        alt: a.alt ?? null,
        width: null,
        height: null,
      }));

      pageAudits.push({
        url: page.normalizedUrl,
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
        // #1003: bound oversize item ids/items-arrays and cap a page's own
        // checks count at maxChecksPerPage — the cloud path publishes pages[]
        // unstripped, so an over-cap single page hit the schema's silent
        // slice. A page's checks mix many DIFFERENT rules, so this must NOT
        // fold by (name,status) like capChecksForPublish does (see its doc).
        checks: capMixedRuleChecksForPublish(pageChecks, REPORT_LIMITS.maxChecksPerPage),
        redirectChain: page.redirectChain,
        fetcherId: page.fetcherId,
        fallbackReason: page.fallbackReason,
      });
    }
    logger.traceEnd(pageAuditsSpan, { pageCount: pages.length });

    // Calculate totals from the per-rule map so rule meta is in reach:
    // warn checks in severity-"info" rules are recommendations — surfaced in
    // the issues list but excluded from warning totals, matching how
    // calculateHealthScore tallies them (advisory scoring).
    let passed = 0;
    let warnings = 0;
    let failed = 0;
    for (const { meta, checks } of ruleResults.ruleResultsMap.values()) {
      const advisory = meta.severity === "info";
      for (const c of checks) {
        if (c.status === "pass") passed++;
        else if (c.status === "warn" && !advisory) warnings++;
        else if (c.status === "fail") failed++;
      }
    }

    const robotsData = buildRobotsData(robots);

    // #512: pages whose render was blocked (403/WAF) and recovered via a
    // non-browser fallback fetch — surfaced as an informational report note.
    const renderBlockRecovered = pageAudits.filter(
      (p) => p.fallbackReason === "render-block",
    ).length;

    const result: FullAuditReport = {
      baseUrl: crawl?.baseUrl ?? "",
      timestamp: new Date().toISOString(),
      totalPages: pages.length,
      passed,
      warnings,
      failed,
      ...(renderBlockRecovered > 0 ? { fetchFallbacks: { recovered: renderBlockRecovered } } : {}),
      // #1003: 500 matches the publish schema's siteChecks cap
      // (auditReportSchema's truncatedArray(checkResultSchema, 500)). Mixes
      // many DIFFERENT site-scoped rules' checks, so no fold (see
      // capMixedRuleChecksForPublish's doc) — same reasoning as pages[].checks.
      siteChecks: capMixedRuleChecksForPublish(ruleResults.siteResults, 500),
      pages: pageAudits,
      summary,
      robotsTxt: robotsData ?? undefined,
      sitemaps: {
        discovered: sitemaps.map((s) => ({
          url: s.url,
          type: s.type,
          urls: [],
          childSitemaps: s.childSitemaps,
          errors: s.errors,
          urlCount: s.urlCount,
        })),
        sources: { robotsTxt: robots?.sitemaps ?? [], commonLocations: [] },
        totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
        orphanPages: [],
        missingPages: [],
        failed: [], // Not persisted to storage, only available during live audit
      },
      healthScore,
      ruleResults: toReportRuleResults(ruleResults.ruleResultsMap),
      resourceSizes: {
        css: ruleResults.resourceSizes.css,
        images: ruleResults.resourceSizes.images,
      },
      sitemapUrlStatuses: ruleResults.sitemapUrlStatuses,
    };

    // Audit validity (#489): a down/403/all-error crawl must NOT publish "A/100%".
    // Cloud parity with the CLI report path (reconstruct.ts) — stamp only when the
    // run isn't a normal completed one; absent ⇒ completed. Renderers + the cloud
    // completion callback (auditStatusToLifecycle) key off this to suppress the score.
    // #792: a walled root page (403/429) fails the fetch before any page is
    // stored, so pass the crawl's blocked-fetch count so 0-page blocks classify
    // as `blocked`, not a generic empty crawl.
    const runStatus = deriveAuditStatusFromPages(pages, crawl?.stats?.pagesBlocked ?? 0);
    if (runStatus.status !== "completed") {
      result.status = runStatus.status;
      result.statusReason = runStatus.reason;
      // No real audit ⇒ no score (N/A), not 0/A. Renderers show the failed/
      // blocked banner and the API persists health_score = NULL (#586).
      if (result.healthScore) result.healthScore.overall = null;
    }

    // Sanitize page-level fields that can exceed API schema limits
    for (const page of result.pages) {
      if (page.schema.raw && page.schema.raw.length > 5000) {
        page.schema.raw = page.schema.raw.slice(0, 4997) + "...";
      }
    }

    // Sanitize: truncate strings that exceed API schema limits
    for (const ruleResult of Object.values(result.ruleResults)) {
      for (const check of ruleResult.checks) {
        if (check.message.length > 1000) check.message = `${check.message.slice(0, 997)}...`;
        if (check.name.length > 255) check.name = `${check.name.slice(0, 252)}...`;
        if (check.items) {
          check.items = check.items.slice(0, 1000);
        }
      }
      ruleResult.checks = ruleResult.checks.slice(0, 500);
    }

    logger.traceEnd(reportSpan, { totalPages: pages.length });
    return result;
  });
}

// ============================================
// STREAMING REPORT ASSEMBLY (v2 — DARK, #1021 PR-F)
// ============================================

/** Default page batch for v2's bounded status + summary pass. */
export const V2_REPORT_BATCH = 200;

/**
 * Input to {@link buildV2Report}: the bounded parts of a streaming run.
 * {@link runStreamingRules}' StreamingRuleExecutionResult is assignable (it
 * extends RuleExecutionResult and carries `tallies`).
 */
export interface StreamingReportInput extends RuleExecutionResult {
  /** Folded per-rule tallies — the bounded scoring path (§3). */
  tallies: Map<string, RuleTally>;
}

export interface BuildV2ReportOptions {
  batchSize?: number;
  /**
   * Heartbeat hook — fired after each getPages batch with the running page count.
   * Hook point only: E-G wires the container heartbeat here so a large-crawl
   * report tail keeps the run alive (aligns #1252). Dark until then.
   */
  onBatch?: (info: { pagesDone: number }) => void;
}

/**
 * DARK v2 report assembly (#1021, PR-F) — beside {@link buildV1Report}. NOTHING
 * wires it yet; E-G flips it in at pageCount > threshold. Bounds the report tail:
 *
 *  - score + totals from the folded per-rule `tallies`
 *    (calculateHealthScoreFromTallies ≡ v1's calculateHealthScore over
 *    ruleResultsMap — proven by the streaming-scoring golden), not by holding and
 *    re-walking every page's checks;
 *  - `pages: []` — the O(pages) pageAudits array is never built (the CLI's
 *    slimForPublish proves the shape); per-page data is served by the paginated
 *    findings API (#1023), not the report body;
 *  - summary.* accumulated over a BATCHED getPages pass (no resident pages[]) and
 *    capped at REPORT_LIMITS.maxSummaryItems so it can never grow unbounded.
 *
 * Byte-identical to v1 for any crawl whose summary sits under the cap and has no
 * render-block fallbacks (golden fixtures qualify): same summary, score, totals,
 * siteChecks, robots, sitemaps, resourceSizes, ruleResults — ONLY `pages` differs
 * ([] vs populated), and `fetchFallbacks` (a per-page-derived note) is omitted.
 *
 * E-G FOLLOW-UPS (deliberately NOT in this dark step): (1) source the summary's
 * per-page signal from stored parsedData inside the batch loop and stop populating
 * `parsedPages`, retiring its residency; (2) replace the `ruleResultsMap` findings
 * read with the capped per-rule issueSample, retiring ruleResultsMap residency;
 * (3) wire the `onBatch` heartbeat.
 */
export function buildV2Report(
  storage: CrawlStorage,
  crawlId: string,
  input: StreamingReportInput,
  options?: BuildV2ReportOptions,
): Effect.Effect<FullAuditReport, never, never> {
  return Effect.gen(function* () {
    const reportSpan = logger.traceStart("buildV2Report");
    const batchSize = options?.batchSize ?? V2_REPORT_BATCH;
    const maxSummaryItems = REPORT_LIMITS.maxSummaryItems;

    const crawl = yield* storage
      .getCrawl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const summary: AuditSummary = {
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

    // Bounded status + summary pass: stream pages in batches so no O(pages) array
    // is ever resident. Accumulate the status signal COUNTS (for deriveAuditStatus)
    // and the capped summary, reading each page's parsed signal from the run's
    // parsedPages — same universe + order as v1's resident `for page of pages`
    // loop. The paginated read is fail-loud (orDie): a mid-stream failure must NOT
    // masquerade as end-of-crawl and silently truncate the scored page set
    // (matches streamPageRules / site-query.ts).
    const summaryPassSpan = logger.traceStart("v2:summaryPass");
    let pagesCrawled = 0;
    let contentPages = 0;
    let blockedPages = 0;
    for (let offset = 0; ; offset += batchSize) {
      const batch = yield* storage
        .getPages(crawlId, { limit: batchSize, offset })
        .pipe(Effect.orDie);
      if (batch.length === 0) break;

      for (const page of batch) {
        pagesCrawled++;
        if (page.status >= 200 && page.status < 300) contentPages++;
        if (page.status === 401 || page.status === 403 || page.status === 429) blockedPages++;

        const parsed = input.parsedPages.get(page.normalizedUrl);
        if (!parsed) continue;

        if (!parsed.meta.title && summary.missingTitles.length < maxSummaryItems)
          summary.missingTitles.push(page.normalizedUrl);
        if (!parsed.meta.description && summary.missingDescriptions.length < maxSummaryItems)
          summary.missingDescriptions.push(page.normalizedUrl);
        if (!parsed.og.title && !parsed.og.image && summary.missingOgTags.length < maxSummaryItems)
          summary.missingOgTags.push(page.normalizedUrl);
        if (!parsed.twitter.card && summary.missingTwitterCards.length < maxSummaryItems)
          summary.missingTwitterCards.push(page.normalizedUrl);
        if (!parsed.schema.types.length && summary.missingSchemas.length < maxSummaryItems)
          summary.missingSchemas.push(page.normalizedUrl);
        if (parsed.h1.count > 1 && summary.multipleH1s.length < maxSummaryItems)
          summary.multipleH1s.push(page.normalizedUrl);
        if (parsed.content.isThinContent && summary.thinContentPages.length < maxSummaryItems)
          summary.thinContentPages.push(page.normalizedUrl);
      }
      options?.onBatch?.({ pagesDone: pagesCrawled });
    }
    logger.traceEnd(summaryPassSpan, { pageCount: pagesCrawled });

    // Missing alt text — same source + order as v1 (getImages × appearances),
    // capped at maxSummaryItems. Batch query when available, else per-image.
    const imageAppearancesSpan = logger.traceStart("v2:imageAppearances");
    const images = yield* storage.getImages(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])));
    const hasBatchImageMethod = "getAllImageAppearancesBySrc" in storage;
    const allImageAppearancesBySrc: Map<string, ImageAppearanceRecord[]> = hasBatchImageMethod
      ? yield* (storage as import("@squirrelscan/crawler").SQLiteStorage)
          .getAllImageAppearancesBySrc(crawlId)
          .pipe(Effect.catchAll(() => Effect.succeed(new Map<string, ImageAppearanceRecord[]>())))
      : new Map<string, ImageAppearanceRecord[]>();

    for (const image of images) {
      if (summary.missingAltText.length >= maxSummaryItems) break;
      const appearances = hasBatchImageMethod
        ? (allImageAppearancesBySrc.get(image.src) ?? [])
        : yield* storage
            .getImageAppearances(crawlId, image.src)
            .pipe(Effect.catchAll(() => Effect.succeed([])));

      const hasAlt = appearances.some((a) => a.alt && a.alt.trim() !== "");
      if (!hasAlt) {
        for (const appearance of appearances) {
          if (summary.missingAltText.length >= maxSummaryItems) break;
          summary.missingAltText.push({ page: appearance.pageUrl, image: image.src });
        }
      }
    }
    logger.traceEnd(imageAppearancesSpan, { images: images.length });

    // Score from the folded tallies. calculateHealthScoreFromTallies(tallies,
    // ruleResultsMap) === v1's calculateHealthScore({ results: ruleResultsMap }):
    // the ruleResultsMap arg feeds ONLY the critical-failure penalty multiplier's
    // robots/sitemap lookup, which reads the same rows either way.
    const healthScore: HealthScore = calculateHealthScoreFromTallies(
      input.tallies,
      input.ruleResultsMap,
    );

    // Totals from the folded tallies (item-aware advisory logic already applied at
    // fold time) — byte-identical to v1's per-check walk of ruleResultsMap.
    let passed = 0;
    let warnings = 0;
    let failed = 0;
    for (const { tally } of input.tallies.values()) {
      passed += tally.passed;
      warnings += tally.warnings;
      failed += tally.failed;
    }

    const robots = yield* storage
      .getRobotsTxt(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const sitemaps = yield* storage
      .getSitemaps(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    const robotsData = buildRobotsData(robots);

    const result: FullAuditReport = {
      baseUrl: crawl?.baseUrl ?? "",
      timestamp: new Date().toISOString(),
      totalPages: pagesCrawled,
      passed,
      warnings,
      failed,
      // #1003: same site-checks cap as v1 (auditReportSchema truncatedArray(500)).
      siteChecks: capMixedRuleChecksForPublish(input.siteResults, 500),
      // v2 drops the O(pages) pageAudits array — per-page data is served by the
      // paginated findings API (#1023). fetchFallbacks (a per-page-derived note)
      // is therefore omitted here; the golden asserts fixtures have none.
      pages: [],
      summary,
      robotsTxt: robotsData ?? undefined,
      sitemaps: {
        discovered: sitemaps.map((s) => ({
          url: s.url,
          type: s.type,
          urls: [],
          childSitemaps: s.childSitemaps,
          errors: s.errors,
          urlCount: s.urlCount,
        })),
        sources: { robotsTxt: robots?.sitemaps ?? [], commonLocations: [] },
        totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
        orphanPages: [],
        missingPages: [],
        failed: [], // Not persisted to storage, only available during live audit
      },
      healthScore,
      ruleResults: toReportRuleResults(input.ruleResultsMap),
      resourceSizes: {
        css: input.resourceSizes.css,
        images: input.resourceSizes.images,
      },
      sitemapUrlStatuses: input.sitemapUrlStatuses,
    };

    // Audit validity (#489) — same signals as v1's deriveAuditStatusFromPages,
    // fed from the streamed counts so no pages[] is needed.
    const runStatus = deriveAuditStatus({
      pagesCrawled,
      contentPages,
      blockedPages,
      blockedErrors: crawl?.stats?.pagesBlocked ?? 0,
    });
    if (runStatus.status !== "completed") {
      result.status = runStatus.status;
      result.statusReason = runStatus.reason;
      if (result.healthScore) result.healthScore.overall = null;
    }

    // Sanitize: truncate ruleResults strings that exceed API schema limits (same
    // as v1). The page-schema.raw loop is a no-op here (pages: []), omitted.
    for (const ruleResult of Object.values(result.ruleResults)) {
      for (const check of ruleResult.checks) {
        if (check.message.length > 1000) check.message = `${check.message.slice(0, 997)}...`;
        if (check.name.length > 255) check.name = `${check.name.slice(0, 252)}...`;
        if (check.items) {
          check.items = check.items.slice(0, 1000);
        }
      }
      ruleResult.checks = ruleResult.checks.slice(0, 500);
    }

    logger.traceEnd(reportSpan, { totalPages: pagesCrawled });
    return result;
  });
}
