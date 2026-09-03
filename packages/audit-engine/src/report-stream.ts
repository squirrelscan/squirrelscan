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

import {
  capChecksForPublish,
  capMixedRuleChecksForPublish,
  clampCheckItemsOverflow,
  maxChecksTruncated,
  stampChecksTruncated,
} from "@squirrelscan/rules";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";
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
  AuditStatus,
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

/**
 * Statuses that mean no real audit happened, so the score must read N/A.
 *
 * `partial` is NOT one of them (#1829): a crawl that lost some pages to rate
 * limiting still graded everything it did fetch, and blanking that score would
 * hide a usable report behind a coverage gap.
 */
function isScorelessStatus(status: AuditStatus): boolean {
  return status === "failed" || status === "blocked";
}

/**
 * Hosts named in a rate-limit reason. Crawl-level throttling is by definition
 * the audited site's own host(s), and the stats carry a count rather than a host
 * list, so the base URL is the honest answer here. Empty when nothing was rate
 * limited, which makes the reason fall back to "the host".
 */
function rateLimitedHostsFor(baseUrl: string, rateLimitedCount: number): string[] {
  if (rateLimitedCount <= 0) return [];
  try {
    return [new URL(baseUrl).hostname];
  } catch {
    return [];
  }
}

/**
 * The seed's resolved URL, but only when it names a DIFFERENT origin than the
 * crawl's base — i.e. the crawler refused an off-site seed redirect and pinned
 * the base to the seed instead (see the crawler's `resolveSeedRedirect`).
 * Undefined otherwise, so reports for the overwhelmingly common no-redirect and
 * same-site-redirect cases are unchanged.
 */
function offSiteSeedRedirect(baseUrl: string, seedUrl: string | undefined): string | undefined {
  if (!seedUrl || !baseUrl) return undefined;
  try {
    return new URL(seedUrl).origin === new URL(baseUrl).origin ? undefined : seedUrl;
  } catch {
    return undefined;
  }
}

/**
 * Whether an image appearance carried an alt attribute at all. alt="" is the
 * correct markup for a decorative image (HTML spec, WCAG H67), so the summary
 * must not list it as missing alt text — only an absent attribute counts (#143).
 * Storage maps a SQL NULL to undefined; null is accepted defensively.
 */
function hasAltAttribute(appearance: ImageAppearanceRecord): boolean {
  return appearance.alt !== undefined && appearance.alt !== null;
}

export function buildRobotsData(robots: RobotsTxtRecord | null): RobotsTxtData | null {
  if (!robots) return null;

  let rules: RobotsTxtData["rules"] = [];
  let errors: string[] = [];

  if (robots.content) {
    const parsed = parseRobotsTxt(robots.content, robots.url);
    rules = parsed.rules;
    errors = parsed.errors;
  } else if (robots.error) {
    // No content because the fetch never produced one. Surfacing the reason is
    // what lets crawl/robots-txt tell an unanswered probe apart from a confirmed
    // 404 instead of reporting both as "No robots.txt found" (#1733).
    errors = [robots.error];
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

/**
 * Last-resort schema backstop over the assembled `ruleResults` — ONE copy,
 * shared by buildV1Report and buildV2Report (they carried byte-identical
 * twins of this loop, and #1503 was filed against one of them).
 *
 * It is a BACKSTOP, not the cap that does the work. `toReportRuleResults` has
 * already run `capChecksForPublish`, which FOLDS an over-cap rule down to one
 * aggregate per (name, status) issue class and keeps every affected page on
 * the aggregate's `pages[]` — so by the time a checks array reaches here it is
 * bounded losslessly and these caps do not bite. Measured on a 1200-page
 * crawl: 186 rules fold, the widest emits 4 issue classes against a cap of
 * 500, and zero affected pages are lost.
 *
 * #1503 read the bare `slice(0, 500)` this replaces as the primary cap and
 * concluded page-scoped findings were being dropped. They were not — but a
 * silent unconditional slice sitting downstream of a lossless fold is a
 * landmine either way: if the fold's invariant ever weakens (a rule emitting
 * more distinct issue classes than the cap), the loss would be invisible.
 * Both caps now record what they cut — items into `details.additional`,
 * checks into `details.checksTruncated` — and warn, so the failure mode is
 * loud rather than a report that merely looks complete.
 */
function sanitizeReportRuleResults(ruleResults: Record<string, ReportRuleResult>): void {
  for (const [ruleId, ruleResult] of Object.entries(ruleResults)) {
    // Display-string clamps, unchanged: in-place, and `name` IS clamped here
    // (unlike clampCheckStrings, which leaves it alone as a fold join key) —
    // fold has already run, so nothing downstream joins on it.
    for (const check of ruleResult.checks) {
      if (check.message.length > 1000) check.message = `${check.message.slice(0, 997)}...`;
      if (check.name.length > 255) check.name = `${check.name.slice(0, 252)}...`;
    }

    // Rolls the drop into `details.additional` instead of slicing items away.
    let checks = clampCheckItemsOverflow(ruleResult.checks, REPORT_LIMITS.maxItemsPerCheck);

    if (checks.length > REPORT_LIMITS.maxChecksPerRule) {
      // Reconciled against any marker an upstream cap already left, so a
      // second cut never replaces the real total with this smaller one.
      const total = Math.max(checks.length, maxChecksTruncated(checks));
      logger.warn(
        `report: rule ${ruleId} emitted ${total} checks past the fold, capping at ` +
          `${REPORT_LIMITS.maxChecksPerRule} (details.checksTruncated records the total)`,
      );
      checks = checks.slice(0, REPORT_LIMITS.maxChecksPerRule);
      const lastIndex = checks.length - 1;
      const last = checks[lastIndex];
      if (last) checks[lastIndex] = stampChecksTruncated(last, total);
    }

    ruleResult.checks = checks;
  }
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

      // Per APPEARANCE, not per image URL: the same src can be decorative on
      // one page and bare on another, and only the bare page is a defect. The
      // rule and reconstruct.ts both judge per page, so grouping here would
      // disagree with them (#143).
      for (const appearance of appearances) {
        if (hasAltAttribute(appearance)) continue;
        summary.missingAltText.push({
          page: appearance.pageUrl,
          image: image.src,
        });
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

    const refusedSeedRedirect = offSiteSeedRedirect(crawl?.baseUrl ?? "", crawl?.seedUrl);

    const result: FullAuditReport = {
      baseUrl: crawl?.baseUrl ?? "",
      // Present only when the crawler refused an off-site seed redirect (#1418).
      ...(refusedSeedRedirect ? { finalUrl: refusedSeedRedirect } : {}),
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
        // Persisted via crawl stats, because an empty `discovered` here must not
        // be read as "no sitemap" when the walk simply stopped early (#1733).
        truncated: crawl?.stats?.sitemapDiscoveryTruncated ?? false,
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
    // #1829: rate-limited fetches store no page, so the count has to come from
    // crawl stats; a stored 429/430 page (an older crawl, a cloud render) counts
    // too. The reason names the host that throttled us.
    const rateLimitedCount =
      (crawl?.stats?.pagesRateLimited ?? 0) +
      pages.filter((page) => isRateLimitStatus(page.status)).length;
    const rateLimitedHosts = rateLimitedHostsFor(result.baseUrl, rateLimitedCount);
    if (rateLimitedCount > 0) {
      result.rateLimited = { pages: rateLimitedCount, hosts: rateLimitedHosts };
    }
    const runStatus = deriveAuditStatusFromPages(
      pages,
      crawl?.stats?.pagesBlocked ?? 0,
      {
        errors: crawl?.stats?.pagesRateLimited ?? 0,
        hosts: rateLimitedHosts,
      },
      // #1822: the crawler's record of WHY the entry URL failed, so a zero-page
      // cloud audit names DNS/TLS/connection/timeout/4xx/5xx/redirect/robots
      // instead of "No pages were crawled".
      crawl?.stats?.rootFailure,
    );
    if (runStatus.status !== "completed") {
      result.status = runStatus.status;
      result.statusReason = runStatus.reason;
      result.statusReasonCode = runStatus.reasonCode;
      // No real audit ⇒ no score (N/A), not 0/A. Renderers show the failed/
      // blocked banner and the API persists health_score = NULL (#586).
      // `partial` is deliberately excluded (#1829): a crawl that audited most
      // of a site and lost a few pages to throttling has a real score, and
      // nulling it would hide the whole report over a coverage gap.
      if (isScorelessStatus(runStatus.status) && result.healthScore) {
        result.healthScore.overall = null;
      }
    }

    // Sanitize page-level fields that can exceed API schema limits
    for (const page of result.pages) {
      if (page.schema.raw && page.schema.raw.length > 5000) {
        page.schema.raw = page.schema.raw.slice(0, 4997) + "...";
      }
    }

    sanitizeReportRuleResults(result.ruleResults);

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
    let rateLimitedPages = 0;
    for (let offset = 0; ; offset += batchSize) {
      const batch = yield* storage
        .getPages(crawlId, { limit: batchSize, offset })
        .pipe(Effect.orDie);
      if (batch.length === 0) break;

      for (const page of batch) {
        pagesCrawled++;
        if (page.status >= 200 && page.status < 300) contentPages++;
        if (page.status === 401 || page.status === 403) blockedPages++;
        // #1829: a stored 429/430 is throttling, not a bot wall — counted apart
        // so the reason text points at the right remedy.
        if (isRateLimitStatus(page.status)) rateLimitedPages++;

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

      // Per APPEARANCE, not per image URL — see the v1 pass above (#143).
      for (const appearance of appearances) {
        if (summary.missingAltText.length >= maxSummaryItems) break;
        if (hasAltAttribute(appearance)) continue;
        summary.missingAltText.push({ page: appearance.pageUrl, image: image.src });
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

    const refusedSeedRedirect = offSiteSeedRedirect(crawl?.baseUrl ?? "", crawl?.seedUrl);

    const result: FullAuditReport = {
      baseUrl: crawl?.baseUrl ?? "",
      // Present only when the crawler refused an off-site seed redirect (#1418).
      ...(refusedSeedRedirect ? { finalUrl: refusedSeedRedirect } : {}),
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
        // Persisted via crawl stats, because an empty `discovered` here must not
        // be read as "no sitemap" when the walk simply stopped early (#1733).
        truncated: crawl?.stats?.sitemapDiscoveryTruncated ?? false,
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
    const rateLimitedCount = (crawl?.stats?.pagesRateLimited ?? 0) + rateLimitedPages;
    const rateLimitedHosts = rateLimitedHostsFor(result.baseUrl, rateLimitedCount);
    if (rateLimitedCount > 0) {
      result.rateLimited = { pages: rateLimitedCount, hosts: rateLimitedHosts };
    }
    const runStatus = deriveAuditStatus({
      pagesCrawled,
      contentPages,
      blockedPages,
      blockedErrors: crawl?.stats?.pagesBlocked ?? 0,
      rateLimitedErrors: crawl?.stats?.pagesRateLimited ?? 0,
      rateLimitedPages,
      rateLimitedHosts,
      // #1822: same signal as v1 above. The streamed path has no pages[] to
      // fall back on, so the crawl stats are its only source for the class.
      rootFailure: crawl?.stats?.rootFailure,
    });
    if (runStatus.status !== "completed") {
      result.status = runStatus.status;
      result.statusReason = runStatus.reason;
      result.statusReasonCode = runStatus.reasonCode;
      if (isScorelessStatus(runStatus.status) && result.healthScore) {
        result.healthScore.overall = null;
      }
    }

    // Same backstop as v1. The page-schema.raw loop is a no-op here (pages: []).
    sanitizeReportRuleResults(result.ruleResults);

    logger.traceEnd(reportSpan, { totalPages: pagesCrawled });
    return result;
  });
}
