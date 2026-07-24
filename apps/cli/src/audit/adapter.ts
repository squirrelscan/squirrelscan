// Audit Adapter - bridges the new crawler to the audit workflow
// Converts crawler storage data to the format expected by rules and reports

import {
  generateReportFromStorage as generateReportFromStorageCore,
  runRulesOnStorage as runRulesOnStorageCore,
  setAdapterLogger,
  type AdapterLogger,
} from "@squirrelscan/audit-engine";
import {
  detectPageType,
  extractContent,
  extractHeadings,
  extractImages,
  extractLinks,
  extractMeta,
  extractOG,
  extractScripts,
  extractStylesheets,
  extractTwitter,
  isSameDomainScript,
  parseDocument,
  parseSchemas,
  schemaCollectionFromJSON,
  extractAuthorFromSchema,
  extractVisibleMeta,
  type ParsedPageCache,
} from "@squirrelscan/parser";
import { type RunnerScope } from "@squirrelscan/rules";
import { Duration, Effect, Stream } from "effect";

import type { Config } from "@/config";
import type { ExternalLinksConfig } from "@/config";
import type { Crawler, CrawlerEvent } from "@/crawler/core/types";
import type {
  CrawlStorage,
  PageRecord,
  LinkRecord,
  ImageRecord,
  LinkAppearanceRecord,
  ImageAppearanceRecord,
} from "@/crawler/storage/types";
import type {
  LinkPosition,
  Page,
  PageRaw,
  ParsedPageData,
  SiteLink,
  SiteImage,
  PageLinkRef,
  PageImageRef,
} from "@/infra/context";
import type { ParsedPage, RuleRunResult } from "@/rules/types";
import type {
  AuditReport,
  CheckResult,
  ResourceSizeData,
  ScriptContentData,
  SitemapUrlStatusData,
} from "@/types";

import { RESOURCE_SIZE_LIMITS, SQUIRRELSCAN_USER_AGENT } from "@/constants";
import {
  checkExternalLinks,
  type ExternalCheckResult,
} from "@/crawler/external-checker";
import {
  checkResourceSizes,
  type ResourceCheckResult,
} from "@/crawler/resource-checker";
import {
  fetchScriptContents,
  type ScriptFetchResult,
} from "@/crawler/script-fetcher";
import { getGlobalLinkCache } from "@/crawler/storage/link-cache";
import { logger } from "@/utils/logger";
import { getHostname, normalizeUrl } from "@/utils/url";
import { detectWafChallengePage } from "@/utils/waf";

// ============================================
// SHARED CORE WIRING (#145)
// ============================================

// runRulesOnStorage now lives once in @squirrelscan/audit-engine; route its
// trace/warn output back through the CLI logger so --trace still captures it.
const cliAdapterLogger: AdapterLogger = {
  trace: (...args) =>
    logger.trace(
      String(args[0]),
      args[1] as Record<string, unknown> | undefined
    ),
  error: logger.error,
  warn: logger.warn,
  traceStart: logger.traceStart,
  traceEnd: logger.traceEnd,
  withTrace: logger.withTrace,
};

setAdapterLogger(cliAdapterLogger);

// ============================================
// SITE CONTEXT BUILDER
// ============================================

/**
 * Site context page - pairs a PageRecord with its parsed data
 * This allows us to parse each page once and reuse across workflows
 */
export interface SiteContextPage {
  page: PageRecord;
  parsed: ParsedPage | null;
}

/**
 * Build site context by parsing all pages once
 * This eliminates redundant parsing across external link checking and rule execution
 */
export function buildSiteContext(
  pages: PageRecord[],
  parsedCache?: ParsedPageCache
): Effect.Effect<SiteContextPage[], never, never> {
  return Effect.sync(() => {
    const contextPages: SiteContextPage[] = [];

    for (const page of pages) {
      // Skip non-HTML pages by content type
      if (!isHtmlContentType(page.contentType)) {
        contextPages.push({ page, parsed: null });
        continue;
      }

      let parsed: ParsedPage | null = null;

      // Reuse stored parsed data if available
      if (page.parsedData) {
        try {
          const stored = JSON.parse(page.parsedData);

          // Handle corrupted state: parsedData exists but html is null
          if (!page.html) {
            logger.error(
              `Cannot recreate document for ${page.url}: HTML is null but parsedData exists (corrupted state)`
            );
            contextPages.push({ page, parsed: null });
            continue;
          }

          // Reuse the crawl-time DOM when present, else re-parse (#267)
          const doc =
            parsedCache?.get(page.normalizedUrl)?.document ??
            parseDocument(page.html);
          // Rehydrate SchemaCollection (getters lost during JSON serialization)
          parsed = {
            document: doc,
            ...stored,
            schemas: schemaCollectionFromJSON(stored.schemas),
          };
        } catch (e) {
          logger.error(`Failed to deserialize parsedData for ${page.url}:`, e);
          // Fall through to re-parsing
        }
      }

      // Fallback: parse from HTML if no stored data (old crawls)
      if (!parsed) {
        // Skip pages without HTML and no stored data
        if (!page.html) {
          contextPages.push({ page, parsed: null });
          continue;
        }

        logger.trace(`Re-parsing HTML for ${page.url} (no stored data)`);
        parsed = parsePageRecord(page);
      }

      contextPages.push({ page, parsed });
    }

    return contextPages;
  });
}

/**
 * DOM working-set controls (#858) — the engine implementations are the source
 * of truth; the fork's SiteContextPage is structurally identical, so re-export
 * for the controller. Release before long DOM-free waits (cloud prefetch),
 * re-materialize lazily at the rules phase.
 */
export {
  releaseSiteContextDocuments,
  ensureSiteContextDocuments,
} from "@squirrelscan/audit-engine";

// ============================================
// PARSED PAGE CONVERSION
// ============================================

/**
 * Parse a page record to extract structured data for rules
 */
export function parsePageRecord(page: PageRecord): ParsedPage | null {
  if (!page.html) return null;

  return logger.withTrace(
    "parsePageRecord",
    () => {
      const html = page.html!;
      const doc = parseDocument(html);
      const baseUrl = page.url;

      const meta = extractMeta(doc);
      const og = extractOG(doc);
      const twitter = extractTwitter(doc);
      const headings = extractHeadings(doc);
      const content = extractContent(doc, html);
      const links = extractLinks(doc, baseUrl);
      const images = extractImages(doc, baseUrl);

      // Parse schemas (new rich collection)
      const schemas = parseSchemas(doc);
      const author = extractAuthorFromSchema(schemas);
      const visibleMeta = extractVisibleMeta(doc);
      const pageType = detectPageType(baseUrl, schemas);

      // Legacy schema format (backwards compat)
      const schema = {
        types: schemas.types,
        valid: schemas.valid,
        errors: schemas.errors,
        raw: schemas.raw,
      };

      return {
        document: doc,
        meta,
        og,
        twitter,
        headings,
        content,
        h1: { count: headings.h1Count, texts: headings.h1Texts },
        links: links.map((l) => ({
          url: l.href,
          text: l.text,
          isInternal: l.isInternal,
          rel: l.rel,
          isNofollow: l.isNofollow,
        })),
        images: images.map((i) => ({
          src: i.src,
          alt: i.alt,
          width: i.width,
          height: i.height,
        })),
        // New schema data
        schemas,
        author,
        pageType,
        // Visible (non-schema) author/date markup
        visibleAuthor: visibleMeta.visibleAuthor,
        visibleDatePublished: visibleMeta.visibleDatePublished,
        visibleDateModified: visibleMeta.visibleDateModified,
        // Legacy (deprecated)
        schema,
      };
    },
    () => ({ url: page.url, htmlLen: page.html!.length })
  );
}

/**
 * Get parsed pages from storage for rule execution
 */
export function getParsedPages(
  storage: CrawlStorage,
  crawlId: string
): Effect.Effect<Array<{ url: string; parsed: ParsedPage }>, never, never> {
  return Effect.gen(function* () {
    const pages = yield* storage
      .getPages(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    const result: Array<{ url: string; parsed: ParsedPage }> = [];

    for (const page of pages) {
      if (!page.html || !isHtmlContentType(page.contentType)) continue;

      const parsed = parsePageRecord(page);
      if (parsed) {
        result.push({ url: page.url, parsed });
      }
    }

    return result;
  });
}

// ============================================
// CONTEXT CONVERSION
// ============================================

/**
 * Convert a PageRecord to the legacy Page format
 */
export function pageRecordToPage(
  record: PageRecord,
  links: PageLinkRef[],
  images: PageImageRef[],
  ruleResults: CheckResult[]
): Page {
  const raw: PageRaw | null = record.html
    ? {
        html: record.html,
        headers: record.headers,
        securityHeaders: record.securityHeaders,
        status: record.status,
        loadTime: record.loadTimeMs,
        fetchedAt: record.fetchedAt,
        contentType: record.contentType,
        finalUrl: record.finalUrl,
        sizeBytes: record.sizeBytes,
      }
    : null;

  let parsed: ParsedPageData | null = null;
  if (record.html) {
    const p = parsePageRecord(record);
    if (p) {
      parsed = {
        meta: p.meta,
        og: p.og,
        twitter: p.twitter,
        schema: p.schema,
        headings: p.headings,
        content: p.content,
        h1: p.h1,
      };
    }
  }

  return {
    url: record.normalizedUrl,
    raw,
    parsed,
    links,
    images,
    ruleResults,
    depth: record.depth,
    parentUrl: record.parentUrl,
  };
}

/**
 * Convert a LinkRecord to the legacy SiteLink format
 */
export async function linkRecordToSiteLink(
  storage: CrawlStorage,
  crawlId: string,
  record: LinkRecord
): Promise<SiteLink> {
  const appearances = await Effect.runPromise(
    storage
      .getLinkAppearances(crawlId, record.href)
      .pipe(Effect.catchAll(() => Effect.succeed([])))
  );

  return {
    href: record.href,
    isInternal: record.isInternal,
    status: record.status,
    error: record.error,
    checkedAt: record.checkedAt,
    appearances: appearances.map((a) => ({
      pageUrl: a.pageUrl,
      anchorText: a.anchorText,
      position: a.position,
      rel: a.rel,
      isNofollow: a.isNofollow,
    })),
  };
}

/**
 * Convert an ImageRecord to the legacy SiteImage format
 */
export async function imageRecordToSiteImage(
  storage: CrawlStorage,
  crawlId: string,
  record: ImageRecord
): Promise<SiteImage> {
  const appearances = await Effect.runPromise(
    storage
      .getImageAppearances(crawlId, record.src)
      .pipe(Effect.catchAll(() => Effect.succeed([])))
  );

  return {
    src: record.src,
    status: record.status,
    error: record.error,
    checkedAt: record.checkedAt,
    contentType: record.contentType,
    size: record.size,
    appearances: appearances.map((a) => ({
      pageUrl: a.pageUrl,
      alt: a.alt,
      width: a.width,
      height: a.height,
      isLazyLoaded: a.isLazyLoaded,
      inFigure: a.inFigure,
    })),
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

/**
 * Run all rules using site context
 *
 * @param siteContext - Pre-parsed site context (eliminates redundant parsing)
 */
export interface ResourceCheckOverrides {
  resourceCheckMaxItems?: number;
  resourceCheckTimeoutMs?: number;
  /** Total time budget for all resource checks combined (CSS + images + scripts + sitemap). */
  resourceCheckBudgetMs?: number;
  /**
   * Whether this audit is incremental (not a --refresh full re-fetch). When
   * true, prior-crawl sub-resource records are reused under browser-like
   * freshness (#107). Defaults to false (cold audit) when unset.
   */
  incremental?: boolean;
}

/**
 * Pre-fetched resource data — collected between crawl and rules phases.
 * Eliminates all HTTP requests during rules phase.
 */
export interface PreFetchedAssets {
  resourceSizes: {
    css: ResourceSizeData[];
    images: ResourceSizeData[];
  };
  scripts: ScriptContentData[];
  pdfSizes: ResourceSizeData[];
  sitemapUrlStatuses: SitemapUrlStatusData[];
}

/**
 * Fetch all resource metadata and content needed by rules.
 * Runs between crawl and rules phases — HEAD for sizes, GET for scripts.
 *
 * This replaces inline resource fetching that previously happened inside runRulesOnStorage().
 */
export function fetchResourceAssets(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: Config,
  overrides?: ResourceCheckOverrides
): Effect.Effect<PreFetchedAssets, never, never> {
  return Effect.gen(function* () {
    const assetsSpan = logger.traceStart("fetchResourceAssets");

    // Build parsedPages from siteContext (same filtering as runRulesOnStorage)
    const parsedPages: Array<{
      url: string;
      finalUrl?: string;
      statusCode: number;
      parsed: ParsedPage;
    }> = [];

    for (const { page, parsed } of siteContext) {
      if (!parsed) continue;
      const wafChallenge = detectWafChallengePage({
        status: page.status,
        headers: {
          server: page.headers.server,
          cfCacheStatus: page.headers.cfCacheStatus,
          xCache: page.headers.xCache,
        },
        html: page.html,
      });
      if (wafChallenge.detected) continue;

      parsedPages.push({
        url: page.normalizedUrl,
        finalUrl: page.finalUrl,
        statusCode: page.status,
        parsed,
      });
    }

    const crawl = yield* storage
      .getCrawl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const baseUrl = crawl?.baseUrl ?? "";

    // Load sitemaps for orphan page status checks
    const sitemaps = yield* storage
      .getSitemaps(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    const sitemapUrlsMap = new Map<
      string,
      Array<{
        loc: string;
        lastmod?: string;
        changefreq?: string;
        priority?: number;
      }>
    >();
    for (const sitemap of sitemaps) {
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

    const sitemapDiscovery = {
      discovered: sitemaps.map((s) => ({
        url: s.url,
        type: s.type,
        urls: sitemapUrlsMap.get(s.url) ?? [],
        childSitemaps: s.childSitemaps,
        errors: s.errors,
        urlCount: s.urlCount,
      })),
      sources: { robotsTxt: [] as string[], commonLocations: [] as string[] },
      totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
      orphanPages: [] as string[],
      missingPages: [] as string[],
      failed: [],
    };

    if (sitemapDiscovery.discovered.length > 0) {
      const coverage = computeSitemapCoverageData(
        parsedPages.map((page) => ({
          url: page.url,
          finalUrl: page.finalUrl,
          statusCode: page.statusCode,
        })),
        sitemapDiscovery
      );
      sitemapDiscovery.orphanPages = coverage.orphanPages;
      sitemapDiscovery.missingPages = coverage.missingPages;
    }

    // Collect resource URLs from parsed pages
    const resourceOccurrences = collectResourceOccurrences(
      parsedPages,
      baseUrl
    );

    // Collect PDF URLs from parsed page links
    const pdfUrls = new Map<string, Set<string>>();
    let baseOrigin: string | null = null;
    try {
      baseOrigin = baseUrl ? new URL(baseUrl).origin : null;
    } catch {
      // ignore
    }
    for (const page of parsedPages) {
      for (const link of page.parsed.links) {
        if (!link.url) continue;
        if (!link.url.toLowerCase().endsWith(".pdf")) continue;
        try {
          const linkOrigin = new URL(link.url).origin;
          if (baseOrigin && linkOrigin === baseOrigin) {
            const sources = pdfUrls.get(link.url) ?? new Set<string>();
            sources.add(page.url);
            pdfUrls.set(link.url, sources);
          }
        } catch {
          // Skip malformed URLs
        }
      }
    }

    // Prior-crawl sub-resource records for browser-like cache reuse (#107).
    // Empty on a cold audit. Gate mirrors the page hot-path: incremental (not
    // --refresh) AND use_cache_control on.
    const cacheReuseEnabled =
      (overrides?.incremental ?? false) &&
      (config.crawler?.use_cache_control ?? true);
    const priorResources = cacheReuseEnabled
      ? yield* storage
          .getCachedResources(crawlId)
          .pipe(Effect.catchAll(() => Effect.succeed([])))
      : [];
    const priorByUrl = new Map(priorResources.map((r) => [r.url, r]));

    const maxResources = overrides?.resourceCheckMaxItems;
    const resourceCheckOptions = {
      concurrency:
        config.external_links?.concurrency ??
        RESOURCE_SIZE_LIMITS.CHECK_CONCURRENCY,
      timeoutMs:
        overrides?.resourceCheckTimeoutMs ??
        config.external_links?.timeout_ms ??
        RESOURCE_SIZE_LIMITS.CHECK_TIMEOUT_MS,
      userAgent: SQUIRRELSCAN_USER_AGENT,
      priorByUrl,
      ...(config.crawler?.max_staleness_seconds != null
        ? { maxStalenessSeconds: config.crawler.max_staleness_seconds }
        : {}),
      ...(maxResources != null ? { maxResources } : {}),
    };

    const scriptFetchOptions: Parameters<typeof fetchScriptContents>[1] = {
      pageCount: siteContext.length,
      ...(maxResources != null ? { maxScripts: maxResources } : {}),
      ...(overrides?.resourceCheckTimeoutMs != null
        ? { timeoutMs: overrides.resourceCheckTimeoutMs }
        : {}),
    };

    const sitemapStatusLimit = Math.min(
      sitemapDiscovery.orphanPages.length,
      maxResources ?? config.crawler?.max_pages ?? 500
    );

    const pdfCheckLimit = Math.min(pdfUrls.size, maxResources ?? 50);

    const resourceCheckStart = Date.now();

    const allResourceChecks = Effect.all(
      {
        css: checkResourceSizes(
          Array.from(resourceOccurrences.css.keys()),
          resourceCheckOptions
        ),
        images: checkResourceSizes(
          Array.from(resourceOccurrences.images.keys()),
          resourceCheckOptions
        ),
        scripts: fetchScriptContents(
          Array.from(resourceOccurrences.scripts.keys()),
          scriptFetchOptions
        ),
        pdfs: checkResourceSizes(
          Array.from(pdfUrls.keys()).slice(0, pdfCheckLimit),
          resourceCheckOptions
        ),
        sitemap: checkResourceSizes(
          sitemapDiscovery.orphanPages.slice(0, sitemapStatusLimit),
          resourceCheckOptions
        ),
      },
      { concurrency: 5 }
    );

    const budgetMs = overrides?.resourceCheckBudgetMs;
    const resourceResults = budgetMs
      ? yield* Effect.catchAll(
          Effect.timeoutFail(allResourceChecks, {
            duration: Duration.millis(budgetMs),
            onTimeout: () =>
              new Error(
                `Resource checks exceeded ${Math.round(budgetMs / 1000)}s budget`
              ),
          }),
          (err) => {
            logger.warn(
              "resource check budget exceeded, using partial results",
              { error: String(err) }
            );
            return Effect.succeed({
              css: [] as ResourceCheckResult[],
              images: [] as ResourceCheckResult[],
              scripts: [] as ScriptFetchResult[],
              pdfs: [] as ResourceCheckResult[],
              sitemap: [] as ResourceCheckResult[],
            });
          }
        )
      : yield* allResourceChecks;

    logger.trace("resource checks", {
      css: resourceResults.css.length,
      images: resourceResults.images.length,
      scripts: resourceResults.scripts.length,
      pdfs: resourceResults.pdfs.length,
      sitemap: resourceResults.sitemap.length,
      elapsed: `${Date.now() - resourceCheckStart}ms`,
    });

    const result: PreFetchedAssets = {
      resourceSizes: {
        css: resourceResults.css.map((check) => ({
          url: check.url,
          status: check.status,
          error: check.error,
          contentType: check.contentType,
          sizeBytes: check.sizeBytes,
          sourcePages: Array.from(resourceOccurrences.css.get(check.url) ?? []),
          contentEncoding: check.contentEncoding,
          transferBytes: check.transferBytes,
          cacheControl: check.cacheControl,
          etag: check.etag,
          lastModified: check.lastModified,
          vary: check.vary,
          cacheReason: check.cacheReason,
        })),
        images: resourceResults.images.map((check) => ({
          url: check.url,
          status: check.status,
          error: check.error,
          contentType: check.contentType,
          sizeBytes: check.sizeBytes,
          sourcePages: Array.from(
            resourceOccurrences.images.get(check.url) ?? []
          ),
          contentEncoding: check.contentEncoding,
          transferBytes: check.transferBytes,
          cacheControl: check.cacheControl,
          etag: check.etag,
          lastModified: check.lastModified,
          vary: check.vary,
          cacheReason: check.cacheReason,
        })),
      },
      scripts: resourceResults.scripts.map((fetch) => ({
        url: fetch.url,
        status: fetch.status,
        error: fetch.error,
        contentType: fetch.contentType,
        sizeBytes: fetch.sizeBytes,
        content: fetch.content,
        sourcePages: Array.from(
          resourceOccurrences.scripts.get(fetch.url) ?? []
        ),
        redirected: fetch.redirected,
        finalUrl: fetch.finalUrl,
        sourceMapHeader: fetch.sourceMapHeader,
      })),
      pdfSizes: resourceResults.pdfs.map((check) => ({
        url: check.url,
        status: check.status,
        error: check.error,
        contentType: check.contentType,
        sizeBytes: check.sizeBytes,
        sourcePages: Array.from(pdfUrls.get(check.url) ?? []),
      })),
      sitemapUrlStatuses: resourceResults.sitemap.map((check) => ({
        url: check.url,
        status: check.status,
        error: check.error,
      })),
    };

    logger.traceEnd(assetsSpan, {
      cssCount: result.resourceSizes.css.length,
      imageCount: result.resourceSizes.images.length,
      scriptCount: result.scripts.length,
      pdfCount: result.pdfSizes.length,
    });

    return result;
  });
}

// runRulesOnStorage lives once in @squirrelscan/audit-engine (#145); this CLI
// wrapper delegates to the shared core (CLI logger injected at module load).
export function runRulesOnStorage(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: Config,
  assets: PreFetchedAssets,
  scope?: RunnerScope
): Effect.Effect<RuleExecutionResult, never, never> {
  return runRulesOnStorageCore(
    storage,
    crawlId,
    siteContext,
    config,
    assets,
    scope
  );
}

// ============================================
// REPORT GENERATION
// ============================================

/**
 * Generate an AuditReport from crawler storage.
 *
 * Collapsed onto the shared assembly core in @squirrelscan/audit-engine
 * (#1021, PR-F). This CLI fork is currently unreferenced — the live CLI report
 * path is reports/reconstruct.ts — but kept (not deleted) as the delegating seam
 * E-G will wire onto streaming v2 for >threshold local audits. The package core
 * additionally suppresses the score on non-completed runs and bounds
 * schema.raw / ruleResults strings for publish (behavior this fork body lacked);
 * harmless while unreferenced, and the more-correct behavior on any revival.
 */
export function generateReportFromStorage(
  storage: CrawlStorage,
  crawlId: string,
  ruleResults: RuleExecutionResult
): Effect.Effect<AuditReport, never, never> {
  // Pure re-type at the fork boundary (no data transform): the package core
  // returns FullAuditReport, whose only nominal differences from the CLI's
  // AuditReport are three summary fields (urlIssues/redirectChains/
  // securityIssues) typed richer here but always emitted as [] by the builder,
  // and an optional ruleResults meta.subcategory the core omits. Runtime-
  // identical, so re-typing is sound — the shape is not rebuilt.
  return generateReportFromStorageCore(
    storage,
    crawlId,
    ruleResults
  ) as unknown as Effect.Effect<AuditReport, never, never>;
}

// ============================================
// EVENT HANDLING
// ============================================

export interface ProgressCallback {
  onPageFetched?: (url: string, status: number, loadTimeMs: number) => void;
  onPageFailed?: (url: string, error: string) => void;
  onProgress?: (fetched: number, pending: number, total: number) => void;
  onCompleted?: (durationMs: number) => void;
}

/**
 * Subscribe to crawler events and call progress callbacks
 */
export function subscribeToCrawlerEvents(
  crawler: Crawler,
  callbacks: ProgressCallback
): Effect.Effect<void, never, never> {
  return Stream.runForEach(crawler.events, (event: CrawlerEvent) => {
    switch (event.type) {
      case "page:fetched":
        callbacks.onPageFetched?.(event.url, event.status, event.loadTimeMs);
        break;
      case "page:failed":
        callbacks.onPageFailed?.(event.url, event.error);
        break;
      case "progress":
        callbacks.onProgress?.(event.fetched, event.pending, event.total);
        break;
      case "completed":
        callbacks.onCompleted?.(event.durationMs);
        break;
    }
    return Effect.void;
  });
}

// ============================================
// EXTERNAL LINK CHECKING
// ============================================

export interface ExternalLinkCheckProgress {
  checked: number;
  total: number;
  fromCache: number;
}

/**
 * Cloud bulk link checker (wired from the credit-gated /v1/services/dead-links
 * endpoint by the audit controller). The map is keyed by the exact requested
 * url; urls it omits fall back to per-link local checks.
 */
export type ExternalBulkChecker = (
  urls: string[]
) => Promise<Map<string, ExternalCheckResult>>;

// Max urls per bulk-checker call — mirrors SERVICE_LIMITS.deadLinksBatchUrls.
const BULK_CHECK_CHUNK_SIZE = 200;

/**
 * Run the bulk checker over local-cache misses in chunks. Never throws: a
 * failing chunk ends the bulk pass and the unresolved remainder takes the
 * per-link local path.
 */
async function runBulkChecker(
  bulkChecker: ExternalBulkChecker,
  urls: string[]
): Promise<Map<string, ExternalCheckResult>> {
  const resolved = new Map<string, ExternalCheckResult>();
  for (let i = 0; i < urls.length; i += BULK_CHECK_CHUNK_SIZE) {
    try {
      const chunk = await bulkChecker(urls.slice(i, i + BULK_CHECK_CHUNK_SIZE));
      for (const [url, result] of chunk) resolved.set(url, result);
    } catch {
      break; // cloud unavailable — remaining urls fall back to local checks
    }
  }
  return resolved;
}

/**
 * Check all external links from site context
 * Results are stored in the crawl storage for use by rules
 *
 * @param siteContext - Pre-parsed site context (eliminates redundant parsing)
 * @param bulkChecker - Optional cloud bulk checker, tried FIRST for every url
 *   the local cache misses. Its answers are seeded into the local cache so the
 *   per-link checker serves them without opening a socket; a bulk failure
 *   degrades silently to the existing per-link local path.
 */
export function checkExternalLinksOnStorage(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: ExternalLinksConfig,
  onProgress?: (progress: ExternalLinkCheckProgress) => void,
  bulkChecker?: ExternalBulkChecker
): Effect.Effect<ExternalCheckResult[], never, never> {
  return Effect.gen(function* () {
    if (!config.enabled) {
      return [];
    }

    // Extract all external links from site context (no DOM parsing needed)
    interface ExternalLinkOccurrence {
      pageUrl: string;
      text: string;
      position: LinkPosition;
      isNofollow: boolean;
    }
    const externalLinkOccurrences = new Map<string, ExternalLinkOccurrence[]>();

    for (const { page, parsed } of siteContext) {
      if (!parsed || !parsed.document) continue; // Skip non-HTML or failed parses

      // Extract links from pre-parsed document (no additional parsing)
      // We need position info which isn't stored in parsedData
      const links = extractLinks(parsed.document, page.finalUrl);

      for (const link of links) {
        if (!link.isInternal && link.href) {
          const occurrences = externalLinkOccurrences.get(link.href) ?? [];
          occurrences.push({
            pageUrl: page.normalizedUrl,
            text: link.text,
            position: link.position,
            isNofollow: link.isNofollow,
          });
          externalLinkOccurrences.set(link.href, occurrences);
        }
      }
    }

    if (externalLinkOccurrences.size === 0) {
      return [];
    }

    // Check external links using global cache
    const cache = getGlobalLinkCache();
    const ttlSeconds = config.cache_ttl_days * 24 * 60 * 60;
    const allUrls = Array.from(externalLinkOccurrences.keys());

    // Cloud bulk path: resolve local-cache misses via the cloud checker first,
    // seeding its answers (checkedAt = now) into the local cache so the
    // per-link checker below serves them as cache hits — only urls the cloud
    // didn't answer get per-link local fetches.
    if (bulkChecker) {
      const locallyCached = cache.getCachedBulk(allUrls, ttlSeconds);
      const misses = allUrls.filter((url) => !locallyCached.has(url));
      if (misses.length > 0) {
        const resolved = yield* Effect.promise(() =>
          runBulkChecker(bulkChecker, misses)
        );
        if (resolved.size > 0) {
          cache.setCachedBulk(
            Array.from(resolved.entries()).map(([url, result]) => ({
              href: url,
              status: result.status,
              error: result.error,
              redirectTarget: result.redirectTarget,
              checkedAt: Date.now(),
              wafBlocked: result.wafBlocked,
              wafProvider: result.wafProvider,
            }))
          );
        }
      }
    }

    const results = yield* checkExternalLinks(allUrls, cache, {
      ttlSeconds,
      concurrency: config.concurrency,
      timeoutMs: config.timeout_ms,
      userAgent: SQUIRRELSCAN_USER_AGENT,
    });

    // Store results in per-crawl storage
    // Collect all appearances for batch insert
    const allAppearances: LinkAppearanceRecord[] = [];

    for (const result of results) {
      yield* storage
        .upsertLink(crawlId, {
          href: result.href,
          isInternal: false,
          status: result.status ?? undefined,
          error: result.error ?? undefined,
          checkedAt: Date.now(),
          wafBlocked: result.wafBlocked,
          wafProvider: result.wafProvider,
        })
        .pipe(Effect.catchAll(() => Effect.void));

      // Collect link appearances for batch insert
      const occurrences = externalLinkOccurrences.get(result.href) ?? [];
      for (const occ of occurrences) {
        allAppearances.push({
          href: result.href,
          pageUrl: occ.pageUrl,
          anchorText: occ.text,
          position: occ.position,
          isNofollow: occ.isNofollow,
        });
      }
    }

    // Batch insert all appearances in one transaction
    if (allAppearances.length > 0) {
      yield* storage
        .addLinkAppearancesBatch(crawlId, allAppearances)
        .pipe(Effect.catchAll(() => Effect.void));
    }

    // Report progress
    const fromCache = results.filter((r) => r.fromCache).length;
    onProgress?.({
      checked: results.length,
      total: externalLinkOccurrences.size,
      fromCache,
    });

    return results;
  });
}

// ============================================
// HELPERS
// ============================================

interface ResourceOccurrenceMap {
  css: Map<string, Set<string>>;
  images: Map<string, Set<string>>;
  scripts: Map<string, Set<string>>;
}

function isSameDomainResource(url: string, baseHost: string): boolean {
  const host = getHostname(url).toLowerCase();
  if (!host || !baseHost) return false;
  if (host === baseHost) return true;
  return host.endsWith(`.${baseHost}`);
}

function collectResourceOccurrences(
  pages: Array<{
    url: string;
    finalUrl?: string;
    parsed: ParsedPage;
  }>,
  baseUrl: string
): ResourceOccurrenceMap {
  const baseHost = getHostname(baseUrl).toLowerCase();
  const css = new Map<string, Set<string>>();
  const images = new Map<string, Set<string>>();
  const scripts = new Map<string, Set<string>>();

  for (const page of pages) {
    const pageUrl = page.finalUrl ?? page.url;
    const doc = page.parsed.document;
    if (!doc) continue;

    const stylesheetRefs = extractStylesheets(doc, pageUrl);
    for (const sheet of stylesheetRefs) {
      if (!sheet.href || sheet.href.startsWith("data:")) continue;
      if (!isSameDomainResource(sheet.href, baseHost)) continue;
      const sources = css.get(sheet.href) ?? new Set<string>();
      sources.add(page.url);
      css.set(sheet.href, sources);
    }

    for (const image of page.parsed.images) {
      if (!image.src || image.src.startsWith("data:")) continue;
      let resolved = image.src;
      try {
        resolved = new URL(image.src, pageUrl).toString();
      } catch {
        // Ignore invalid URLs
      }
      if (!isSameDomainResource(resolved, baseHost)) continue;
      const sources = images.get(resolved) ?? new Set<string>();
      sources.add(page.url);
      images.set(resolved, sources);
    }

    // Extract external script URLs
    const scriptRefs = extractScripts(doc, pageUrl);
    for (const script of scriptRefs) {
      if (!script.src || script.src.startsWith("data:")) continue;
      if (!isSameDomainScript(script.src, baseHost)) continue;
      const sources = scripts.get(script.src) ?? new Set<string>();
      sources.add(page.url);
      scripts.set(script.src, sources);
    }
  }

  return { css, images, scripts };
}

function computeSitemapCoverageData(
  pages: Array<{
    url: string;
    finalUrl?: string;
    statusCode: number;
  }>,
  sitemaps: {
    discovered: Array<{
      urls: Array<{ loc: string }>;
    }>;
  }
): { orphanPages: string[]; missingPages: string[] } {
  const sitemapUrlMap = new Map<string, string>();

  for (const sitemap of sitemaps.discovered) {
    for (const url of sitemap.urls) {
      try {
        const normalized = normalizeUrl(url.loc);
        if (!sitemapUrlMap.has(normalized)) {
          sitemapUrlMap.set(normalized, url.loc);
        }
      } catch {
        // Ignore invalid URLs
      }
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

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}
