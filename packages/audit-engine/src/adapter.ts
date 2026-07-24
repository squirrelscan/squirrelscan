// Audit Adapter — package-portable version of apps/cli/src/audit/adapter.ts
// Bridges crawler storage data to the format expected by rules and reports.
// No CLI-specific imports (no logger, no link-cache, no infra/context types).

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
  EMPTY_SCHEMA_COLLECTION,
  extractAuthorFromSchema,
  extractVisibleMeta,
  type ParsedPageCache,
} from "@squirrelscan/parser";
import {
  buildCollectedPageSignal,
  createRunner,
  mergeRuleRunResult,
  type RunnerScope,
} from "@squirrelscan/rules";
import { Duration, Effect } from "effect";

import {
  type PageRuleLoopHooks,
  type PageRuleTask,
  runAndDispose,
  SerialPageRuleExecutor,
} from "./page-rule-executor";

import type { Config, ExternalLinksConfig } from "@squirrelscan/config";
import type {
  CrawlStorage,
  LlmsTxtRecord,
  MarkdownProbeRecord,
  WellKnownProbeRecord,
  AgentAccessRecord,
  RslRecord,
  PageRecord,
  LinkAppearanceRecord,
  LinkPosition,
} from "@squirrelscan/core-contracts/storage";
import type {
  CollectedPageSignal,
  CollectedSiteSignals,
  ParsedPage,
  RuleRunResult,
  SiteData,
} from "@squirrelscan/rules";
import type { SQLiteStorage } from "@squirrelscan/crawler";
import type {
  CheckResult,
  CloakingProbeData,
  LlmsTxtData,
  MarkdownProbeData,
  WellKnownProbeData,
  AgentAccessData,
  RslData,
  RedirectChain,
  ResourceSizeData,
  ScriptContentData,
  SitemapUrlStatusData,
  SiteQuery,
} from "@squirrelscan/core-contracts";
import { CLOUD_RESOURCE_CHECK, REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import { createFetchBudget, type FetchBudget, type FetchBudgetSummary } from "./fetch-budget";
import {
  calculateHealthScore,
  deriveAuditStatusFromPages,
  foldRuleResultIntoTallies,
  type RuleTally,
} from "./scoring";
import { localIntelContext } from "./intel";
import { logger } from "./adapter-logger";
// Report assembly extracted to ./report-stream (#1021, PR-F). adapter references
// these internally — runRulesOnStorage/StreamingRuleExecutionResult reference
// RuleExecutionResult, the generateReportFromStorage delegate returns
// FullAuditReport, and two site-data builders call buildRobotsData. The barrel
// re-exports (index.ts imports these names from "./adapter") sit beside the
// generateReportFromStorage delegate below.
import {
  buildV1Report,
  buildRobotsData,
  type FullAuditReport,
  type RuleExecutionResult,
} from "./report-stream";
// Streaming rule engine (#1021, PR-E). Imported for its call-time function refs
// only; `streaming.ts` imports buildSiteContext/buildHeadersMap/isRenderedFetch
// back from here — a module cycle that resolves because neither side calls the
// other at module-eval time (handoff: "runtime-resolved cycle is fine").
import {
  streamPageRules,
  STREAM_PAGE_BATCH,
  type PageSignalCollector,
  type StreamPageRulesHooks,
} from "./streaming";
import { resolveCloakingProbes } from "./cloaking-probe";
import { createSiteQuery } from "./site-query";
import { confirmSoft404Candidates } from "./soft404-confirm";
import {
  CHROME_USER_AGENT,
  RESOURCE_SIZE_LIMITS,
  SQUIRRELSCAN_USER_AGENT,
} from "@squirrelscan/utils/constants";
import { checkExternalLinks, type ExternalCheckResult, type LinkCache } from "./external-checker";
import { checkResourceSizes, type ResourceCheckResult } from "./resource-checker";
import { fetchScriptContents, type ScriptFetchResult } from "./script-fetcher";
import { getHostname, normalizeUrl } from "@squirrelscan/utils/url";
import { detectWafChallengePage } from "@squirrelscan/waf-detect";

// ============================================
// LOGGER (injectable, defaults to noop)
// ============================================
// Extracted to ./adapter-logger so ./report-stream shares the injected instance
// without importing ./adapter. Re-exported here to keep the package barrel stable.
export { setAdapterLogger, type AdapterLogger } from "./adapter-logger";

// ============================================
// CONSTANTS
// ============================================

/**
 * Empty ParsedPage for error pages (4xx/5xx) that have no HTML content.
 * Used in site context for broken link detection - only statusCode matters.
 */
const EMPTY_PARSED_PAGE: ParsedPage = {
  document: null,
  meta: { title: null, description: null, canonical: null, robots: null },
  h1: { count: 0, texts: [] },
  og: {
    title: null,
    description: null,
    url: null,
    type: null,
    image: null,
    siteName: null,
  },
  twitter: { card: null, title: null, description: null, image: null },
  links: [],
  images: [],
  headings: {
    headings: [],
    h1Count: 0,
    h1Texts: [],
    hasSkippedLevels: false,
    skippedLevels: [],
    emptyHeadings: [],
    longHeadings: [],
    duplicateHeadings: [],
    outline: "",
  },
  content: {
    wordCount: 0,
    textLength: 0,
    htmlLength: 0,
    textToHtmlRatio: 0,
    isThinContent: true,
    contentHash: "",
    textContent: "",
  },
  schemas: EMPTY_SCHEMA_COLLECTION,
  author: null,
  pageType: "unknown",
  schema: { types: [], valid: true, errors: [], raw: null },
};

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
 * True when a crawl page's HTML came from a browser render rather than plain HTTP. Rendered fetchers stamp
 * `fetcherMethod` "cloud-render" (CLI + container paid render) or "browser" (container browser-queue); a
 * render-blocked fallback stamps "fetch" (raw). Drives PageData.rendered (rule gate) + the render-prefetch
 * per-page skip (#673) — keep the two in sync by sourcing both from here.
 */
export const isRenderedFetch = (fetcherId?: string | null): boolean =>
  fetcherId === "cloud-render" || fetcherId === "browser";

/**
 * URLs the crawl already browser-rendered — the render-prefetch per-page skip set (#673/#964). Both the CLI
 * and container prefetch builders derive this identically; sharing one helper keeps them from drifting (a
 * dropped derivation silently re-renders every page — the dead-gate class #673 hit). Structural param so it
 * takes either path's SiteContextPage (both carry `page.url` + `page.fetcherId`).
 */
export function renderedPageUrlsFrom(
  siteContext: ReadonlyArray<{ page: { url: string; fetcherId?: string | null } }>,
): Set<string> {
  const out = new Set<string>();
  for (const { page } of siteContext) {
    if (isRenderedFetch(page.fetcherId)) out.add(page.url);
  }
  return out;
}

/**
 * Build site context by parsing all pages once
 * This eliminates redundant parsing across external link checking and rule execution
 */
export function buildSiteContext(
  pages: PageRecord[],
  parsedCache?: ParsedPageCache,
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
              `Cannot recreate document for ${page.url}: HTML is null but parsedData exists (corrupted state)`,
            );
            contextPages.push({ page, parsed: null });
            continue;
          }

          // Reuse the crawl-time DOM when present, else re-parse (#267)
          const doc = parsedCache?.get(page.normalizedUrl)?.document ?? parseDocument(page.html);
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
 * Null out every retained DOM in the site context so long DOM-free stretches
 * (cloud prefetch waits, report generation, publish upload) don't keep a
 * GB-scale linkedom working set resident (#858). Under host memory pressure
 * that idle working set gets paged out and the next local phase runs at
 * page-fault speed (observed: 13s of rules taking ~4 minutes).
 *
 * Safe because re-parsing the same `page.html` is deterministic:
 * `ensureSiteContextDocuments` rebuilds an identical DOM on demand
 * (~12.5ms/page, #263 measurements).
 */
export function releaseSiteContextDocuments(siteContext: SiteContextPage[]): void {
  for (const entry of siteContext) {
    if (entry.parsed) entry.parsed.document = null;
  }
}

/**
 * Re-materialize DOMs released by `releaseSiteContextDocuments`. Idempotent:
 * only entries with a null document (and html to parse) are touched, so a
 * never-released context is a no-op.
 */
export function ensureSiteContextDocuments(siteContext: SiteContextPage[]): void {
  for (const entry of siteContext) {
    if (entry.parsed && !entry.parsed.document && entry.page.html) {
      entry.parsed.document = parseDocument(entry.page.html);
    }
  }
}

// ============================================
// PARSED PAGE CONVERSION
// ============================================

/**
 * Parse raw HTML into the ParsedPage shape rules expect. The single source of
 * truth for rule-input parsing — shared by `parsePageRecord` (main-thread
 * pre-parse) and the #263 page-rule workers, which re-parse from html (the
 * linkedom Document can't cross a worker seam). Keeping ONE parse path is what
 * guarantees pooled execution stays byte-identical to serial.
 */
export function parseHtmlForRules(html: string, baseUrl: string): ParsedPage {
  const doc = parseDocument(html);

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
}

/**
 * Parse a page record to extract structured data for rules
 */
export function parsePageRecord(page: PageRecord): ParsedPage | null {
  if (!page.html) return null;

  return logger.withTrace(
    "parsePageRecord",
    () => parseHtmlForRules(page.html!, page.url),
    () => ({ url: page.url, htmlLen: page.html!.length }),
  );
}

/**
 * Get parsed pages from storage for rule execution
 */
export function getParsedPages(
  storage: CrawlStorage,
  crawlId: string,
): Effect.Effect<Array<{ url: string; parsed: ParsedPage }>, never, never> {
  return Effect.gen(function* () {
    const pages = yield* storage.getPages(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])));

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

function buildLlmsTxtData(llms: LlmsTxtRecord | null): LlmsTxtData | null {
  if (!llms) return null;
  return { llmsTxt: llms.llmsTxt, llmsFullTxt: llms.llmsFullTxt };
}

function buildMarkdownProbeData(probe: MarkdownProbeRecord | null): MarkdownProbeData | null {
  if (!probe) return null;
  return {
    negotiatedUrl: probe.negotiatedUrl,
    negotiatedContentType: probe.negotiatedContentType,
    servesMarkdown: probe.servesMarkdown,
    mdVariantUrl: probe.mdVariantUrl,
    mdVariantExists: probe.mdVariantExists,
    mdVariantContentType: probe.mdVariantContentType,
    negotiatedVary: probe.negotiatedVary ?? null,
    markdownTokensHeader: probe.markdownTokensHeader ?? null,
    originalTokensHeader: probe.originalTokensHeader ?? null,
    alternateMarkdownUrl: probe.alternateMarkdownUrl ?? null,
  };
}

function buildWellKnownData(probe: WellKnownProbeRecord | null): WellKnownProbeData | null {
  if (!probe) return null;
  return { probes: probe.probes };
}

function buildAgentAccessData(access: AgentAccessRecord | null): AgentAccessData | null {
  if (!access) return null;
  return { probes: access.probes };
}

function buildRslData(rsl: RslRecord | null): RslData | null {
  if (!rsl) return null;
  return {
    licenseUrls: rsl.licenseUrls,
    robotsHasLicense: rsl.robotsHasLicense,
    linkHeaderPresent: rsl.linkHeaderPresent,
    documents: rsl.documents,
  };
}

// ============================================
// RULE EXECUTION
// ============================================

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
  /**
   * #1252: set only when the asset-fetch step degraded (total budget spent or a
   * host tarpitting) and some fetches were skipped. Undefined on a healthy run,
   * so nothing changes downstream unless the phase actually hit a wall. Surfaced
   * as a `crawl/asset-fetch-degraded` note by {@link runRulesOnStorage}.
   */
  degradation?: FetchBudgetSummary;
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
  overrides?: ResourceCheckOverrides,
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
        })),
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
        sitemapDiscovery,
      );
      // Cap to keep resource-check URLs within reasonable bounds
      sitemapDiscovery.orphanPages = coverage.orphanPages.slice(0, REPORT_LIMITS.maxPages);
      sitemapDiscovery.missingPages = coverage.missingPages.slice(0, REPORT_LIMITS.maxPages);
    }

    // Collect resource URLs from parsed pages
    const resourceOccurrences = collectResourceOccurrences(parsedPages, baseUrl);

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

    // Prior-crawl sub-resource records, keyed by URL, enable browser-like cache
    // reuse for CSS/images (#107). Empty on a first/cold audit. Mirrors the page
    // hot-path gate: only when caching is incremental (not a --refresh full
    // re-fetch) AND use_cache_control is on. `--refresh` flips the crawler's
    // incremental flag, threaded in via overrides.
    const cacheReuseEnabled =
      (overrides?.incremental ?? false) && (config.crawler?.use_cache_control ?? true);
    const priorResources = cacheReuseEnabled
      ? yield* storage.getCachedResources(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])))
      : [];
    const priorByUrl = new Map(priorResources.map((r) => [r.url, r]));

    const maxResources = overrides?.resourceCheckMaxItems;

    // #1252: cloud passes resourceCheckBudgetMs → a shared tarpit-aware budget
    // bounds CSS + images + scripts + PDFs + sitemap fetches together. Once the
    // budget is spent or a host escalates its latency (activera.com.au), the
    // REMAINING fetches skip fast instead of re-hitting a tarpit for minutes.
    // Unset (CLI, which has its own fetchResourceAssets) → undefined → fetch as
    // today. One budget for both fetchers so a slow origin is detected across
    // resource types, not per-category.
    const budgetMs = overrides?.resourceCheckBudgetMs;
    const fetchBudget: FetchBudget | undefined =
      budgetMs && budgetMs > 0
        ? createFetchBudget({
            totalBudgetMs: budgetMs,
            tarpitLatencyMs: CLOUD_RESOURCE_CHECK.tarpitLatencyMs,
            tarpitStrikes: CLOUD_RESOURCE_CHECK.tarpitStrikes,
          })
        : undefined;

    const resourceCheckOptions = {
      concurrency: config.external_links?.concurrency ?? RESOURCE_SIZE_LIMITS.CHECK_CONCURRENCY,
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
      // Web Bot Auth / custom headers apply to asset fetches too (#494).
      ...(config.crawler?.headers && Object.keys(config.crawler.headers).length > 0
        ? { customHeaders: config.crawler.headers }
        : {}),
      ...(fetchBudget ? { budget: fetchBudget } : {}),
    };

    const scriptFetchOptions: Parameters<typeof fetchScriptContents>[1] = {
      pageCount: siteContext.length,
      ...(maxResources != null ? { maxScripts: maxResources } : {}),
      ...(overrides?.resourceCheckTimeoutMs != null
        ? { timeoutMs: overrides.resourceCheckTimeoutMs }
        : {}),
      ...(config.crawler?.headers && Object.keys(config.crawler.headers).length > 0
        ? { customHeaders: config.crawler.headers }
        : {}),
      ...(fetchBudget ? { budget: fetchBudget } : {}),
    };

    const sitemapStatusLimit = Math.min(
      sitemapDiscovery.orphanPages.length,
      maxResources ?? config.crawler?.max_pages ?? 500,
    );

    const pdfCheckLimit = Math.min(pdfUrls.size, maxResources ?? 50);

    const resourceCheckStart = Date.now();

    const allResourceChecks = Effect.all(
      {
        css: checkResourceSizes(Array.from(resourceOccurrences.css.keys()), resourceCheckOptions),
        images: checkResourceSizes(
          Array.from(resourceOccurrences.images.keys()),
          resourceCheckOptions,
        ),
        scripts: fetchScriptContents(
          Array.from(resourceOccurrences.scripts.keys()),
          scriptFetchOptions,
        ),
        pdfs: checkResourceSizes(
          Array.from(pdfUrls.keys()).slice(0, pdfCheckLimit),
          resourceCheckOptions,
        ),
        sitemap: checkResourceSizes(
          sitemapDiscovery.orphanPages.slice(0, sitemapStatusLimit),
          resourceCheckOptions,
        ),
      },
      { concurrency: 5 },
    );

    // Outer hard cliff is now a LAST resort: the shared fetchBudget skips
    // not-yet-started fetches at `budgetMs`, so `allResourceChecks` normally
    // resolves (with partial data) shortly after the deadline as in-flight
    // requests hit their own AbortController. Give this timeout that drain slack
    // over budgetMs so partial results survive; only a fetch whose per-request
    // abort is itself defeated reaches the empty fallback. (#1252)
    const outerBudgetMs = budgetMs
      ? budgetMs + resourceCheckOptions.timeoutMs + 5_000
      : undefined;
    const resourceResults = outerBudgetMs
      ? yield* Effect.catchAll(
          Effect.timeoutFail(allResourceChecks, {
            duration: Duration.millis(outerBudgetMs),
            onTimeout: () =>
              new Error(`Resource checks exceeded ${Math.round(outerBudgetMs / 1000)}s budget`),
          }),
          (err) => {
            logger.warn("resource check budget exceeded, using partial results", {
              error: String(err),
            });
            return Effect.succeed({
              css: [] as ResourceCheckResult[],
              images: [] as ResourceCheckResult[],
              scripts: [] as ScriptFetchResult[],
              pdfs: [] as ResourceCheckResult[],
              sitemap: [] as ResourceCheckResult[],
            });
          },
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
          sourcePages: Array.from(resourceOccurrences.images.get(check.url) ?? []),
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
        sourcePages: Array.from(resourceOccurrences.scripts.get(fetch.url) ?? []),
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

    // #1252: only attach the degradation summary when the phase actually hit a
    // wall (budget spent or a host tarpitting) — undefined on healthy runs, so
    // the report is byte-identical unless assets were genuinely skipped.
    const budgetSummary = fetchBudget?.summary();
    if (budgetSummary?.degraded) {
      result.degradation = budgetSummary;
      logger.warn("resource fetch degraded", {
        reason: budgetSummary.reason,
        skipped: budgetSummary.skipped,
        attempted: budgetSummary.attempted,
        tarpitHosts: budgetSummary.tarpitHosts,
      });
    }

    logger.traceEnd(assetsSpan, {
      cssCount: result.resourceSizes.css.length,
      imageCount: result.resourceSizes.images.length,
      scriptCount: result.scripts.length,
      pdfCount: result.pdfSizes.length,
      ...(budgetSummary?.degraded ? { degraded: budgetSummary.reason } : {}),
    });

    return result;
  });
}

/**
 * Flatten a stored page's typed `headers`/`securityHeaders` into the loose
 * `Record<string, string>` rules read via `ctx.page.headers`. Exported (not
 * just a `runRulesOnStorage` closure helper) so it's directly unit-testable —
 * this is the exact seam where a header field can be added to the storage
 * type but never surfaced to rules, as happened with Set-Cookie (#748).
 */
export function buildHeadersMap(page: PageRecord): Record<string, string> {
  const headers: Record<string, string> = {};
  if (page.headers.contentType) headers["content-type"] = page.headers.contentType;
  if (page.headers.contentEncoding) headers["content-encoding"] = page.headers.contentEncoding;
  if (page.headers.cacheControl) headers["cache-control"] = page.headers.cacheControl;
  if (page.headers.expires) headers["expires"] = page.headers.expires;
  if (page.headers.vary) headers["vary"] = page.headers.vary;
  if (page.headers.etag) headers["etag"] = page.headers.etag;
  if (page.headers.lastModified) headers["last-modified"] = page.headers.lastModified;
  if (page.headers.server) headers["server"] = page.headers.server;
  // New headers for SEO/performance rules
  if (page.headers.link) headers["link"] = page.headers.link;
  if (page.headers.serverTiming) headers["server-timing"] = page.headers.serverTiming;
  if (page.headers.age) headers["age"] = page.headers.age;
  if (page.headers.xCache) headers["x-cache"] = page.headers.xCache;
  if (page.headers.cfCacheStatus) headers["cf-cache-status"] = page.headers.cfCacheStatus;
  if (page.headers.xVercelCache) headers["x-vercel-cache"] = page.headers.xVercelCache;
  if (page.headers.altSvc) headers["alt-svc"] = page.headers.altSvc;
  if (page.headers.acceptRanges) headers["accept-ranges"] = page.headers.acceptRanges;
  // Set-Cookie — security/cookie-flags rule (#748).
  if (page.headers.setCookie) headers["set-cookie"] = page.headers.setCookie;
  // Security headers
  if (page.securityHeaders.hsts) headers["strict-transport-security"] = page.securityHeaders.hsts;
  if (page.securityHeaders.csp) headers["content-security-policy"] = page.securityHeaders.csp;
  if (page.securityHeaders.xFrameOptions)
    headers["x-frame-options"] = page.securityHeaders.xFrameOptions;
  if (page.securityHeaders.xContentTypeOptions)
    headers["x-content-type-options"] = page.securityHeaders.xContentTypeOptions;
  if (page.securityHeaders.referrerPolicy)
    headers["referrer-policy"] = page.securityHeaders.referrerPolicy;
  if (page.securityHeaders.permissionsPolicy)
    headers["permissions-policy"] = page.securityHeaders.permissionsPolicy;
  if (page.securityHeaders.xRobotsTag) headers["x-robots-tag"] = page.securityHeaders.xRobotsTag;
  return headers;
}

export function runRulesOnStorage(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: Config,
  assets: PreFetchedAssets,
  // Per-audit-run cloud results + Stage-0 site metadata. Threaded into the
  // runner so concurrent audits never share state. Omit for offline / no-cloud.
  scope?: RunnerScope,
  // #1252: cooperative-yield + heartbeat hooks for the page-rule loop. Cloud
  // passes them so the (sync CPU) loop yields to the event loop and reports
  // progress; the CLI omits them (byte-identical local behavior).
  pageLoopHooks?: PageRuleLoopHooks,
): Effect.Effect<RuleExecutionResult, never, never> {
  return Effect.gen(function* () {
    const rulesSpan = logger.traceStart("runRulesOnStorage");
    // Rules dereference `parsed.document`; the caller may have released the
    // DOMs during the cloud-prefetch waits (#858). Idempotent re-parse.
    ensureSiteContextDocuments(siteContext);
    // Opt-in threat-intel (#117): when enabled and the caller didn't already
    // resolve a full intel context (cloud prefetch does), thread a signatures-
    // only context so the kit-signature rule works on every opted-in run.
    const effectiveScope =
      config.intel?.enabled && !scope?.intel ? { ...scope, intel: localIntelContext() } : scope;
    const runner = createRunner(config, effectiveScope);

    const pageResults = new Map<string, CheckResult[]>();
    const pageRuleResults = new Map<string, Map<string, CheckResult[]>>();
    const ruleResultsMap = new Map<string, RuleRunResult>();

    // Step 1: Build parsedPages from siteContext FIRST (before page rules)
    // This allows us to collect resource occurrences and fetch site data
    const parsedPages: Array<{
      url: string;
      finalUrl?: string;
      statusCode: number;
      parsed: ParsedPage;
      headers?: Record<string, string>;
      redirectChain?: RedirectChain;
    }> = [];
    const wafBlockedPages: Array<{
      url: string;
      provider: string | null;
    }> = [];
    const wafBlockedPageSet = new Set<string>();

    // Build page data structures needed for site context
    const pageDataMap = new Map<
      string,
      {
        page: PageRecord;
        parsed: ParsedPage;
        headers: Record<string, string>;
      }
    >();

    for (const { page, parsed } of siteContext) {
      if (!parsed) continue; // Skip non-HTML or failed parses
      const wafChallenge = detectWafChallengePage({
        status: page.status,
        headers: {
          server: page.headers.server,
          cfCacheStatus: page.headers.cfCacheStatus,
          xCache: page.headers.xCache,
        },
        html: page.html,
      });
      if (wafChallenge.detected) {
        logger.trace("waf challenge page excluded from page-level scoring", {
          url: page.normalizedUrl,
          status: page.status,
          provider: wafChallenge.provider,
        });
        wafBlockedPages.push({
          url: page.normalizedUrl,
          provider: wafChallenge.provider,
        });
        wafBlockedPageSet.add(page.normalizedUrl);
        continue;
      }

      const headers = buildHeadersMap(page);
      parsedPages.push({
        url: page.normalizedUrl,
        finalUrl: page.finalUrl,
        statusCode: page.status,
        parsed,
        headers,
        redirectChain: page.redirectChain,
      });
      pageDataMap.set(page.normalizedUrl, { page, parsed, headers });
    }

    // Add error pages (4xx/5xx) to site context for broken link detection
    // These pages have no HTML but their status codes are needed by the broken-links rule
    for (const { page } of siteContext) {
      if (
        page.status >= 400 &&
        !pageDataMap.has(page.normalizedUrl) &&
        !wafBlockedPageSet.has(page.normalizedUrl)
      ) {
        parsedPages.push({
          url: page.normalizedUrl,
          finalUrl: page.finalUrl,
          statusCode: page.status,
          parsed: EMPTY_PARSED_PAGE,
          headers: {},
          redirectChain: page.redirectChain,
        });
      }
    }

    const robots = yield* storage
      .getRobotsTxt(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const llms = yield* storage
      .getLlmsTxt(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const markdownProbe = yield* storage
      .getMarkdownProbe(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const wellKnownProbe = yield* storage
      .getWellKnownProbe(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const agentAccessProbe = yield* storage
      .getAgentAccess(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const rslProbe = yield* storage
      .getRsl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    const sitemaps = yield* storage
      .getSitemaps(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    const crawl = yield* storage
      .getCrawl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    // Get external links with check results (batch query when available)
    const linkAppearancesSpan = logger.traceStart("getLinkAppearances");
    const allLinks = yield* storage
      .getLinks(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    // Batch fetch all link appearances if available, else use N+1 fallback
    const hasBatchLinkMethod = "getAllLinkAppearancesByHref" in storage;
    const linkAppearancesByHref: Map<string, LinkAppearanceRecord[]> = hasBatchLinkMethod
      ? yield* (storage as import("@squirrelscan/crawler").SQLiteStorage)
          .getAllLinkAppearancesByHref(crawlId)
          .pipe(Effect.catchAll(() => Effect.succeed(new Map<string, LinkAppearanceRecord[]>())))
      : new Map<string, LinkAppearanceRecord[]>();

    const externalLinksData: Array<{
      href: string;
      status: number | null;
      error: string | null;
      sourcePages: string[];
      wafBlocked?: boolean;
      wafProvider?: string;
    }> = [];

    let linkQueryCount = 0;
    for (const link of allLinks) {
      if (!link.isInternal) {
        // Use batch map if available, else fallback to individual query
        const appearances = hasBatchLinkMethod
          ? (linkAppearancesByHref.get(link.href) ?? [])
          : yield* storage
              .getLinkAppearances(crawlId, link.href)
              .pipe(Effect.catchAll(() => Effect.succeed([])));
        if (!hasBatchLinkMethod) linkQueryCount++;

        externalLinksData.push({
          href: link.href,
          status: link.status ?? null,
          error: link.error ?? null,
          // Dedupe: a page linking the same URL from nav + footer + body
          // records multiple appearances; the publish API caps sourcePages
          // at 100, so raw per-occurrence lists reject the whole report.
          sourcePages: [...new Set(appearances.map((a) => a.pageUrl))],
          wafBlocked: link.wafBlocked,
          wafProvider: link.wafProvider,
        });
      }
    }
    logger.traceEnd(linkAppearancesSpan, {
      queries: hasBatchLinkMethod ? 1 : linkQueryCount,
    });

    const robotsData = buildRobotsData(robots);
    const llmsData = buildLlmsTxtData(llms);
    const markdownData = buildMarkdownProbeData(markdownProbe);
    const wellKnownData = buildWellKnownData(wellKnownProbe);
    const agentAccessData = buildAgentAccessData(agentAccessProbe);
    const rslData = buildRslData(rslProbe);

    // Load sitemap URLs for each sitemap
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
        })),
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
      sources: { robotsTxt: robotsData?.sitemaps ?? [], commonLocations: [] },
      totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
      orphanPages: [] as string[],
      missingPages: [] as string[],
      failed: [], // Not persisted to storage, only available during live audit
    };

    // Sitemap array limits must match the API schema caps (REPORT_LIMITS.maxPages).
    // Rules create check items from these arrays; exceeding the cap causes a 400 on publish.
    const SITEMAP_ARRAY_CAP = REPORT_LIMITS.maxPages;

    if (sitemapDiscovery.discovered.length > 0) {
      const coverage = computeSitemapCoverageData(
        parsedPages.map((page) => ({
          url: page.url,
          finalUrl: page.finalUrl,
          statusCode: page.statusCode,
        })),
        sitemapDiscovery,
      );
      sitemapDiscovery.orphanPages = coverage.orphanPages.slice(0, SITEMAP_ARRAY_CAP);
      sitemapDiscovery.missingPages = coverage.missingPages.slice(0, SITEMAP_ARRAY_CAP);
    }

    // Use pre-fetched resource data (no HTTP calls during rules phase)
    const { resourceSizes, scripts, pdfSizes, sitemapUrlStatuses } = assets;

    // Differential cloaking probe (#118) — opt-in, bounded. Re-fetches suspicious
    // paths (orphan / recently-modified) with a googlebot UA + query variation and
    // compares; integrity/cloaking reads the result. Undefined when off, so the
    // rule no-ops instead of reporting "clean" for paths it never probed.
    const cloakingProbes = yield* Effect.promise(() =>
      resolveCloakingProbes(
        config.integrity?.cloaking_probe,
        {
          baseUrl: crawl?.baseUrl ?? "",
          pages: parsedPages.map((p) => ({
            url: p.url,
            statusCode: p.statusCode,
            parsed: { links: p.parsed.links },
          })),
          sitemapUrls: sitemapDiscovery.discovered.flatMap((s) =>
            s.urls.map((u) => ({ loc: u.loc, lastmod: u.lastmod })),
          ),
        },
        {
          defaultUserAgent: config.crawler?.user_agent || CHROME_USER_AGENT,
          customHeaders: config.crawler?.headers,
        },
      ),
    );

    // Soft-404 confirmation (#1177) — before page rules run, re-fetch each page
    // the crawl flagged as a soft-404 ONCE and re-run detection, writing the
    // verdict onto `parsed.soft404Confirmation` (read by crawl/soft-404 to pick
    // its finding variant). Bounded to flagged candidates only, so it never
    // multiplies crawl cost; a failed/absent re-fetch degrades to `unconfirmed`
    // (annotated, never dropped). Wired here once so CLI + cloud can't drift.
    const soft404ConfirmSummary = yield* Effect.promise(() =>
      confirmSoft404Candidates(
        Array.from(pageDataMap.values(), ({ page, parsed }) => ({
          url: page.normalizedUrl,
          statusCode: page.status,
          parsed,
          // Rendered-crawl content can't be verified by a plain re-fetch (#1177).
          rendered: isRenderedFetch(page.fetcherId),
        })),
        {
          // ON by default; opt out via [integrity.soft404_confirm] for
          // rate-limited/staging hosts (candidates then annotate `unconfirmed`).
          enabled: config.integrity?.soft404_confirm?.enabled ?? true,
          maxConfirmations: config.integrity?.soft404_confirm?.max_confirmations,
          wallBudgetMs: config.integrity?.soft404_confirm?.budget_ms,
          // The RESOLVED effective UA the crawl used (sticky/random UA persisted
          // in the crawl config snapshot), NOT the raw config value — so the
          // confirmation request is UA-equivalent to the crawl (#1177).
          userAgent: crawl?.config?.userAgent || config.crawler?.user_agent || CHROME_USER_AGENT,
          customHeaders: config.crawler?.headers,
          // Honor the crawl's per-host politeness delay between same-host confirms.
          perHostDelayMs: config.crawler?.per_host_delay_ms,
        },
      ).catch((): undefined => undefined),
    );
    if (soft404ConfirmSummary && soft404ConfirmSummary.candidates > 0) {
      logger.trace("soft-404 confirmation pass", soft404ConfirmSummary);
    }

    // Step 2: Build site data object for page rules to access
    // This allows page-scope rules to access scripts, resourceSizes, etc.
    const siteDataForPageRules: SiteData = {
      baseUrl: crawl?.baseUrl ?? "",
      pages: parsedPages,
      robotsTxt: robotsData,
      llmsTxt: llmsData,
      markdownResponse: markdownData,
      wellKnown: wellKnownData,
      agentAccess: agentAccessData,
      rsl: rslData,
      sitemaps: sitemapDiscovery,
      externalLinks: externalLinksData,
      resourceSizes,
      scripts,
      pdfSizes,
      sitemapUrlStatuses,
      cloakingProbes,
      // Raw committed-page count vs the run's configured cap (#697), so
      // sitemap-coverage can tell "crawl budget truncated this run" apart
      // from a genuine coverage gap.
      crawlLimits: {
        pagesCrawled: siteContext.length,
        maxPages: config.crawler?.max_pages ?? 100,
      },
    };

    // Step 3: Run page rules WITH site data. The page-rules phase is the
    // dominant single-core cost, so it runs through a PageRuleExecutor (#263):
    // the CLI/container can inject a subprocess / worker_threads pool. Default
    // is in-process serial — byte-identical to the pre-#263 loop.
    const pageRulesSpan = logger.traceStart("runPageRules:all");
    const pageTasks: PageRuleTask[] = [];
    for (const [pageUrl, { page, parsed, headers }] of pageDataMap) {
      pageTasks.push({
        key: pageUrl,
        page: {
          url: page.url,
          html: page.html!,
          statusCode: page.status,
          loadTime: page.loadTimeMs,
          ttfb: page.ttfb,
          downloadTime: page.downloadTime,
          headers,
          parsed, // pre-parsed DOM (serial path); parallel backends re-parse from html
          finalUrl: page.finalUrl,
          redirectChain: page.redirectChain,
          // This page's HTML is the post-JS DOM when a render fetcher served it (#673). Lets
          // ax/content-without-js skip its raw-vs-rendered diff when it would be self-identical.
          rendered: isRenderedFetch(page.fetcherId),
        },
      });
    }

    // Page rules run through a PageRuleExecutor so the loop stays decoupled from
    // execution strategy; the default (and only shipped) backend is in-process
    // serial.
    const pageExecutor = new SerialPageRuleExecutor(runner, pageLoopHooks);
    // Pass the fiber's AbortSignal so a `rulesPhaseTimeoutMs` interruption stops
    // the batch between pages instead of running every remaining page to
    // completion (a single native promise is otherwise non-preemptible).
    const pageRuleTaskResults = yield* Effect.promise((signal) =>
      runAndDispose(pageExecutor, pageTasks, siteDataForPageRules, signal),
    );

    for (const { key: pageUrl, checks, ruleResults } of pageRuleTaskResults) {
      pageResults.set(pageUrl, checks);

      // Store per-page rule results with proper rule IDs
      const ruleChecksForPage = new Map<string, CheckResult[]>();
      for (const [ruleId, ruleResult] of ruleResults) {
        ruleChecksForPage.set(ruleId, ruleResult.checks);
      }
      pageRuleResults.set(pageUrl, ruleChecksForPage);

      for (const [ruleId, ruleResult] of ruleResults) {
        for (const check of ruleResult.checks) {
          if (!check.pageUrl) check.pageUrl = pageUrl;
        }
        mergeRuleRunResult(ruleResultsMap, ruleId, ruleResult);
      }
    }
    logger.traceEnd(pageRulesSpan, { pageCount: pageDataMap.size });

    // Step 4: Run site rules
    const siteRulesSpan = logger.traceStart("runSiteRules");
    const siteResult = yield* Effect.promise(() => runner.runSiteRules(siteDataForPageRules));

    // Build site rule results map for storage
    const siteRuleResults = new Map<string, CheckResult[]>();
    for (const [ruleId, ruleResult] of siteResult.ruleResults) {
      siteRuleResults.set(ruleId, ruleResult.checks);
      mergeRuleRunResult(ruleResultsMap, ruleId, ruleResult);
    }

    if (wafBlockedPages.length > 0) {
      const providers = Array.from(
        new Set(
          wafBlockedPages
            .map((page) => page.provider)
            .filter((provider): provider is string => !!provider),
        ),
      );

      const sampledPages = wafBlockedPages.slice(0, 5).map((page) => page.url);
      const providerText = providers.length > 0 ? ` via ${providers.join(", ")}` : "";

      const wafCheck: CheckResult = {
        name: "WAF challenge pages detected",
        status: "warn",
        message: `Detected ${wafBlockedPages.length} challenge/interstitial page(s)${providerText}; these pages were excluded from page-level rule scoring.`,
        pages: sampledPages,
        details: {
          totalBlockedPages: wafBlockedPages.length,
          providers,
          sampledPages,
        },
      };

      const wafRuleResult: RuleRunResult = {
        meta: {
          id: "crawl/waf-challenge-pages",
          name: "WAF Challenge Pages",
          description:
            "Detect pages that return bot-protection interstitials instead of crawlable content.",
          solution:
            "Allow trusted crawler traffic, reduce bot challenges for audit IPs, or run the audit in an allowlisted environment.",
          category: "crawl",
          scope: "site",
          severity: "warning",
          weight: 6,
        },
        checks: [wafCheck],
      };

      siteResult.checks.push(wafCheck);
      siteRuleResults.set(wafRuleResult.meta.id, [wafCheck]);
      ruleResultsMap.set(wafRuleResult.meta.id, wafRuleResult);
      logger.warn(
        `Excluded ${wafBlockedPages.length} WAF challenge page(s) from page-level scoring`,
      );
    }

    // #1252: surface an asset-fetch degradation note (budget spent / tarpitting
    // host) as an ADVISORY site check, mirroring the WAF notice above. Only when
    // the fetch step actually skipped work (healthy runs carry no `degradation`,
    // so the report is unchanged). severity "info" + weight 0 + status "info" so
    // it is visible but NEVER re-scores a healthy host — it just tells the reader
    // that some size/script findings may be incomplete because the origin was slow.
    if (assets.degradation?.degraded) {
      const d = assets.degradation;
      const hostText =
        d.tarpitHosts.length > 0 ? ` (slow host(s): ${d.tarpitHosts.slice(0, 3).join(", ")})` : "";
      const reasonText =
        d.reason === "tarpit"
          ? "an escalating-latency (tarpitting) host"
          : "the resource-fetch time budget";
      const degradedCheck: CheckResult = {
        name: "asset-fetch-degraded",
        status: "info",
        message: `Resource fetching was cut short by ${reasonText}${hostText}: ${d.skipped} asset request(s) skipped. Some size/script findings may be incomplete.`,
        details: {
          reason: d.reason,
          skipped: d.skipped,
          attempted: d.attempted,
          tarpitHosts: d.tarpitHosts,
          elapsedMs: d.elapsedMs,
        },
      };
      const degradedRuleResult: RuleRunResult = {
        meta: {
          id: "crawl/asset-fetch-degraded",
          name: "Asset Fetch Degraded",
          description:
            "Resource-asset fetching was bounded (time budget or a tarpitting host) and some sub-resource requests were skipped.",
          solution:
            "Diagnostic notice, not a site defect: the audit protected itself from a slow/hostile origin. Re-run when the host is responsive for full resource coverage.",
          category: "crawl",
          scope: "site",
          severity: "info",
          weight: 0,
        },
        checks: [degradedCheck],
      };
      siteResult.checks.push(degradedCheck);
      siteRuleResults.set(degradedRuleResult.meta.id, [degradedCheck]);
      ruleResultsMap.set(degradedRuleResult.meta.id, degradedRuleResult);
    }
    logger.traceEnd(siteRulesSpan);

    logger.traceEnd(rulesSpan, { totalPages: siteContext.length });

    // Rules were the last DOM consumer — report generation and the returned
    // `parsedPages` map read only extracted data fields (meta/og/twitter/…),
    // never `.document`, so drop the DOMs before the report/publish tail (#858).
    releaseSiteContextDocuments(siteContext);

    // Build parsedPages cache
    const parsedPagesCache = new Map<string, ParsedPage>();
    for (const [url, { parsed }] of pageDataMap) {
      parsedPagesCache.set(url, parsed);
    }

    return {
      pageResults,
      pageRuleResults,
      siteResults: siteResult.checks,
      siteRuleResults,
      ruleResultsMap,
      parsedPages: parsedPagesCache,
      resourceSizes,
      sitemapUrlStatuses,
    };
  });
}

// ============================================
// STREAMING RULE EXECUTION (#1021, PR-E)
// ============================================
//
// `runStreamingRules` is the streaming twin of `runRulesOnStorage`: it bounds
// parsed-DOM residency to one page batch instead of holding every parsed page
// resident, by (1) streaming the DOM-free scalar universe, (2) streaming the
// page-rule pass with a per-page DOM-drop (streamPageRules), and (3) folding
// results into per-rule tallies alongside the full ruleResultsMap. It is DARK:
// no production path calls it; v1 is left byte-for-byte untouched and the
// 500-page golden-diff gates the two.
//
// The site-fetch phase and the site.pages universe assembly below are
// DUPLICATED from runRulesOnStorage (not shared) precisely to keep v1 untouched
// under the dark-launch constraint; drift between the two copies is caught by
// the golden-diff. The site pass now runs over the DOM-FREE scalar universe: the
// six all-pages DOM scanners read `ctx.collectedSignals` captured page-time
// (buildCollectedPageSignal) and every other site rule reads scalars, so no page
// DOM is ever resident — the peak-RSS win (E-E2 (a) removed E-E's
// materializeDomSitePages re-parse seam). The site pass runs WITHOUT a siteQuery
// for now; wiring createSiteQuery (with the raw-getPages→v1 universe
// reconciliation) is E-E2 (b) work.

/** One parsed page in the streamed universe — same shape as runRulesOnStorage's `parsedPages` entries. */
type StreamParsedPage = {
  url: string;
  finalUrl?: string;
  statusCode: number;
  parsed: ParsedPage;
  headers?: Record<string, string>;
  redirectChain?: RedirectChain;
};

interface ParsedUniverse {
  parsedPages: StreamParsedPage[];
  wafBlockedPages: Array<{ url: string; provider: string | null }>;
  wafBlockedPageSet: Set<string>;
  pageDataMap: Map<
    string,
    { page: PageRecord; parsed: ParsedPage; headers: Record<string, string> }
  >;
}

/**
 * Assemble the `site.pages` universe from a parsed site context, EXACTLY as
 * `runRulesOnStorage` does: HTML pages first (WAF-challenge pages excluded and
 * collected for the advisory site check), then 4xx/5xx error pages appended with
 * `EMPTY_PARSED_PAGE`. Reads only `page.html` + parsed scalars (never
 * `parsed.document`), so a DOM-dropped context yields the same universe — which
 * is what lets Pass 1 null each batch's DOMs before calling this. Duplicated from
 * v1's inline block to keep v1 untouched; the golden-diff gates against drift.
 */
function assembleParsedUniverse(siteContext: SiteContextPage[]): ParsedUniverse {
  const parsedPages: StreamParsedPage[] = [];
  const wafBlockedPages: Array<{ url: string; provider: string | null }> = [];
  const wafBlockedPageSet = new Set<string>();
  const pageDataMap: ParsedUniverse["pageDataMap"] = new Map();

  for (const { page, parsed } of siteContext) {
    if (!parsed) continue; // non-HTML / failed parse — v1 skips these too
    const wafChallenge = detectWafChallengePage({
      status: page.status,
      headers: {
        server: page.headers.server,
        cfCacheStatus: page.headers.cfCacheStatus,
        xCache: page.headers.xCache,
      },
      html: page.html,
    });
    if (wafChallenge.detected) {
      wafBlockedPages.push({ url: page.normalizedUrl, provider: wafChallenge.provider });
      wafBlockedPageSet.add(page.normalizedUrl);
      continue;
    }

    const headers = buildHeadersMap(page);
    parsedPages.push({
      url: page.normalizedUrl,
      finalUrl: page.finalUrl,
      statusCode: page.status,
      parsed,
      headers,
      redirectChain: page.redirectChain,
    });
    pageDataMap.set(page.normalizedUrl, { page, parsed, headers });
  }

  // Error pages (4xx/5xx) carry no HTML but their status codes feed broken-link
  // detection — appended after the HTML pages exactly as v1 does.
  for (const { page } of siteContext) {
    if (
      page.status >= 400 &&
      !pageDataMap.has(page.normalizedUrl) &&
      !wafBlockedPageSet.has(page.normalizedUrl)
    ) {
      parsedPages.push({
        url: page.normalizedUrl,
        finalUrl: page.finalUrl,
        statusCode: page.status,
        parsed: EMPTY_PARSED_PAGE,
        headers: {},
        redirectChain: page.redirectChain,
      });
    }
  }

  return { parsedPages, wafBlockedPages, wafBlockedPageSet, pageDataMap };
}

/**
 * Pass 1 — stream the DOM-free scalar universe. Reads pages in batches, parses
 * each batch, drops that batch's DOMs before the next (so peak DOM residency
 * stays ≤ one batch), then assembles the same `parsedPages`/`pageDataMap` v1
 * builds up front. The retained parsed pages keep their extracted scalars
 * (links/meta/…) — all the site-fetch phase and report need — but no live DOM.
 */
function streamParsedUniverse(
  storage: SQLiteStorage,
  crawlId: string,
  batchSize: number,
): Effect.Effect<ParsedUniverse & { totalPageCount: number }, never, never> {
  return Effect.gen(function* () {
    const siteContext: SiteContextPage[] = [];
    let totalPageCount = 0;

    for (let offset = 0; ; offset += batchSize) {
      // A read failure mid-stream is a HARD error, not end-of-crawl — orDie so a
      // transient batch failure crashes the audit loud rather than truncating the
      // page set silently (see streamPageRules; keeps the error channel `never`).
      const batch = yield* storage.getPages(crawlId, { limit: batchSize, offset }).pipe(Effect.orDie);
      if (batch.length === 0) break;
      totalPageCount += batch.length;

      const ctx = yield* buildSiteContext(batch);
      // Drop this batch's DOMs before the next — `assembleParsedUniverse` and the
      // site-fetch phase read only page.html + parsed scalars, never `.document`.
      releaseSiteContextDocuments(ctx);
      for (const entry of ctx) siteContext.push(entry);

      if (batch.length < batchSize) break;
    }

    return { ...assembleParsedUniverse(siteContext), totalPageCount };
  });
}

/**
 * Steps 2+3 — the site-fetch phase (robots/llms/well-known/rsl/sitemaps/crawl/
 * external-links/sitemap-coverage/cloaking/soft-404). VERBATIM from
 * `runRulesOnStorage` (duplicated to keep v1 untouched), reading the DOM-free
 * `parsedPages` (cloaking reads `.links`; coverage reads url/status) and mutating
 * `pageDataMap`'s parsed via the soft-404 confirm pass. Returns the assembled
 * `siteDataForPageRules` plus the soft-404 verdict map to thread into the
 * re-parsing page stream (Pass 2 re-parses, so the confirm-pass mutation must be
 * carried by value, not object identity).
 */
function buildStreamingSiteData(
  storage: SQLiteStorage,
  crawlId: string,
  config: Config,
  assets: PreFetchedAssets,
  parsedPages: StreamParsedPage[],
  pageDataMap: ParsedUniverse["pageDataMap"],
  totalPageCount: number,
): Effect.Effect<
  {
    siteDataForPageRules: SiteData;
    soft404Map: Map<string, ParsedPage["soft404Confirmation"]>;
  },
  never,
  never
> {
  return Effect.gen(function* () {
    const robots = yield* storage
      .getRobotsTxt(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const llms = yield* storage.getLlmsTxt(crawlId).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const markdownProbe = yield* storage
      .getMarkdownProbe(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const wellKnownProbe = yield* storage
      .getWellKnownProbe(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const agentAccessProbe = yield* storage
      .getAgentAccess(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const rslProbe = yield* storage.getRsl(crawlId).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const sitemaps = yield* storage
      .getSitemaps(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    const crawl = yield* storage.getCrawl(crawlId).pipe(Effect.catchAll(() => Effect.succeed(null)));

    const allLinks = yield* storage
      .getLinks(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed([])));

    // `storage` is always SQLiteStorage here, which always exposes the batch
    // link-appearance query — so unlike runRulesOnStorage (generic CrawlStorage)
    // there is no N+1 fallback path; this is the batch branch v1 takes for SQLite.
    const linkAppearancesByHref: Map<string, LinkAppearanceRecord[]> = yield* storage
      .getAllLinkAppearancesByHref(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(new Map<string, LinkAppearanceRecord[]>())));

    const externalLinksData: Array<{
      href: string;
      status: number | null;
      error: string | null;
      sourcePages: string[];
      wafBlocked?: boolean;
      wafProvider?: string;
    }> = [];

    for (const link of allLinks) {
      if (!link.isInternal) {
        const appearances = linkAppearancesByHref.get(link.href) ?? [];

        externalLinksData.push({
          href: link.href,
          status: link.status ?? null,
          error: link.error ?? null,
          // Dedupe: the publish API caps sourcePages at 100, so raw per-occurrence
          // lists (nav + footer + body) would reject the whole report.
          sourcePages: [...new Set(appearances.map((a) => a.pageUrl))],
          wafBlocked: link.wafBlocked,
          wafProvider: link.wafProvider,
        });
      }
    }

    const robotsData = buildRobotsData(robots);
    const llmsData = buildLlmsTxtData(llms);
    const markdownData = buildMarkdownProbeData(markdownProbe);
    const wellKnownData = buildWellKnownData(wellKnownProbe);
    const agentAccessData = buildAgentAccessData(agentAccessProbe);
    const rslData = buildRslData(rslProbe);

    const sitemapUrlsMap = new Map<
      string,
      Array<{ loc: string; lastmod?: string; changefreq?: string; priority?: number }>
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
        })),
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
      sources: { robotsTxt: robotsData?.sitemaps ?? [], commonLocations: [] },
      totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
      orphanPages: [] as string[],
      missingPages: [] as string[],
      failed: [],
    };

    const SITEMAP_ARRAY_CAP = REPORT_LIMITS.maxPages;
    if (sitemapDiscovery.discovered.length > 0) {
      const coverage = computeSitemapCoverageData(
        parsedPages.map((page) => ({
          url: page.url,
          finalUrl: page.finalUrl,
          statusCode: page.statusCode,
        })),
        sitemapDiscovery,
      );
      sitemapDiscovery.orphanPages = coverage.orphanPages.slice(0, SITEMAP_ARRAY_CAP);
      sitemapDiscovery.missingPages = coverage.missingPages.slice(0, SITEMAP_ARRAY_CAP);
    }

    const { resourceSizes, scripts, pdfSizes, sitemapUrlStatuses } = assets;

    const cloakingProbes = yield* Effect.promise(() =>
      resolveCloakingProbes(
        config.integrity?.cloaking_probe,
        {
          baseUrl: crawl?.baseUrl ?? "",
          pages: parsedPages.map((p) => ({
            url: p.url,
            statusCode: p.statusCode,
            parsed: { links: p.parsed.links },
          })),
          sitemapUrls: sitemapDiscovery.discovered.flatMap((s) =>
            s.urls.map((u) => ({ loc: u.loc, lastmod: u.lastmod })),
          ),
        },
        {
          defaultUserAgent: config.crawler?.user_agent || CHROME_USER_AGENT,
          customHeaders: config.crawler?.headers,
        },
      ),
    );

    // Soft-404 confirmation (#1177) — mutates each candidate's
    // `parsed.soft404Confirmation` in place (soft404-confirm.ts). Bounded to
    // flagged candidates; a failed/absent re-fetch degrades to `unconfirmed`.
    yield* Effect.promise(() =>
      confirmSoft404Candidates(
        Array.from(pageDataMap.values(), ({ page, parsed }) => ({
          url: page.normalizedUrl,
          statusCode: page.status,
          parsed,
          rendered: isRenderedFetch(page.fetcherId),
        })),
        {
          enabled: config.integrity?.soft404_confirm?.enabled ?? true,
          maxConfirmations: config.integrity?.soft404_confirm?.max_confirmations,
          wallBudgetMs: config.integrity?.soft404_confirm?.budget_ms,
          userAgent: crawl?.config?.userAgent || config.crawler?.user_agent || CHROME_USER_AGENT,
          customHeaders: config.crawler?.headers,
          perHostDelayMs: config.crawler?.per_host_delay_ms,
        },
      ).catch((): undefined => undefined),
    );

    const siteDataForPageRules: SiteData = {
      baseUrl: crawl?.baseUrl ?? "",
      pages: parsedPages,
      robotsTxt: robotsData,
      llmsTxt: llmsData,
      markdownResponse: markdownData,
      wellKnown: wellKnownData,
      agentAccess: agentAccessData,
      rsl: rslData,
      sitemaps: sitemapDiscovery,
      externalLinks: externalLinksData,
      resourceSizes,
      scripts,
      pdfSizes,
      sitemapUrlStatuses,
      cloakingProbes,
      crawlLimits: {
        pagesCrawled: totalPageCount,
        maxPages: config.crawler?.max_pages ?? 100,
      },
    };

    // Carry the confirm-pass verdicts by value: Pass 2 re-parses each page, so the
    // in-place mutation above (on Pass-1 parsed objects) must be re-applied to the
    // fresh parse via streamPageRules' `soft404Confirmations`.
    const soft404Map = new Map<string, ParsedPage["soft404Confirmation"]>();
    for (const [url, { parsed }] of pageDataMap) {
      if (parsed.soft404Confirmation !== undefined) {
        soft404Map.set(url, parsed.soft404Confirmation);
      }
    }

    return { siteDataForPageRules, soft404Map };
  });
}

/**
 * Step 5 — the site-rule pass. Runs over the DOM-FREE scalar universe assembled in
 * Pass 1: the six all-pages DOM scanners (leaked-secrets, total-byte-weight,
 * template-discontinuity, integrity/orphan-page, adblock, subprocessor-disclosure)
 * now read `ctx.collectedSignals` — the per-page signal captured while each DOM was
 * live — and every other site rule reads only page scalars, so NO page DOM is ever
 * resident here. This is the full peak-RSS win: it replaces E-E's
 * materializeDomSitePages re-parse seam (#1021 E-E2 (a)). `wafBlockedPages` is
 * threaded from Pass 1 (no re-fetch/re-parse); soft-404 verdicts were applied in
 * place on the Pass-1 parsed objects (same objects v1 mutates). Runs WITHOUT a
 * siteQuery for now — createSiteQuery wiring + the universe reconciliation land in
 * E-E2 (b). Appends the WAF + asset-fetch-degraded advisory checks verbatim from
 * runRulesOnStorage.
 */
function runSitePass(
  runner: ReturnType<typeof createRunner>,
  siteData: SiteData,
  assets: PreFetchedAssets,
  wafBlockedPages: ReadonlyArray<{ url: string; provider: string | null }>,
  collectedSignals: CollectedSiteSignals,
  siteQuery: SiteQuery,
): Effect.Effect<
  {
    siteResults: CheckResult[];
    siteRuleResults: Map<string, CheckResult[]>;
    siteRuleRunResults: Map<string, RuleRunResult>;
  },
  never,
  never
> {
  return Effect.gen(function* () {
    // siteData.pages is the DOM-free scalar universe from Pass 1. The six DOM
    // scanners read collectedSignals; the Bucket-C/D dual-path rules read siteQuery;
    // all other site rules read page scalars — so no DOM is materialized. Byte-
    // identical to v1: identical scalar universe, collectors reproduce the per-page
    // DOM signal, and siteQuery's universe is reconciled to v1's site.pages.
    const siteResult = yield* Effect.promise(() =>
      runner.runSiteRules(siteData, siteQuery, collectedSignals),
    );

    const siteRuleResults = new Map<string, CheckResult[]>();
    const siteRuleRunResults = new Map<string, RuleRunResult>();
    for (const [ruleId, ruleResult] of siteResult.ruleResults) {
      siteRuleResults.set(ruleId, ruleResult.checks);
      siteRuleRunResults.set(ruleId, ruleResult);
    }

    if (wafBlockedPages.length > 0) {
      const providers = Array.from(
        new Set(
          wafBlockedPages
            .map((page) => page.provider)
            .filter((provider): provider is string => !!provider),
        ),
      );
      const sampledPages = wafBlockedPages.slice(0, 5).map((page) => page.url);
      const providerText = providers.length > 0 ? ` via ${providers.join(", ")}` : "";

      const wafCheck: CheckResult = {
        name: "WAF challenge pages detected",
        status: "warn",
        message: `Detected ${wafBlockedPages.length} challenge/interstitial page(s)${providerText}; these pages were excluded from page-level rule scoring.`,
        pages: sampledPages,
        details: {
          totalBlockedPages: wafBlockedPages.length,
          providers,
          sampledPages,
        },
      };
      const wafRuleResult: RuleRunResult = {
        meta: {
          id: "crawl/waf-challenge-pages",
          name: "WAF Challenge Pages",
          description:
            "Detect pages that return bot-protection interstitials instead of crawlable content.",
          solution:
            "Allow trusted crawler traffic, reduce bot challenges for audit IPs, or run the audit in an allowlisted environment.",
          category: "crawl",
          scope: "site",
          severity: "warning",
          weight: 6,
        },
        checks: [wafCheck],
      };

      siteResult.checks.push(wafCheck);
      siteRuleResults.set(wafRuleResult.meta.id, [wafCheck]);
      siteRuleRunResults.set(wafRuleResult.meta.id, wafRuleResult);
    }

    if (assets.degradation?.degraded) {
      const d = assets.degradation;
      const hostText =
        d.tarpitHosts.length > 0 ? ` (slow host(s): ${d.tarpitHosts.slice(0, 3).join(", ")})` : "";
      const reasonText =
        d.reason === "tarpit"
          ? "an escalating-latency (tarpitting) host"
          : "the resource-fetch time budget";
      const degradedCheck: CheckResult = {
        name: "asset-fetch-degraded",
        status: "info",
        message: `Resource fetching was cut short by ${reasonText}${hostText}: ${d.skipped} asset request(s) skipped. Some size/script findings may be incomplete.`,
        details: {
          reason: d.reason,
          skipped: d.skipped,
          attempted: d.attempted,
          tarpitHosts: d.tarpitHosts,
          elapsedMs: d.elapsedMs,
        },
      };
      const degradedRuleResult: RuleRunResult = {
        meta: {
          id: "crawl/asset-fetch-degraded",
          name: "Asset Fetch Degraded",
          description:
            "Resource-asset fetching was bounded (time budget or a tarpitting host) and some sub-resource requests were skipped.",
          solution:
            "Diagnostic notice, not a site defect: the audit protected itself from a slow/hostile origin. Re-run when the host is responsive for full resource coverage.",
          category: "crawl",
          scope: "site",
          severity: "info",
          weight: 0,
        },
        checks: [degradedCheck],
      };
      siteResult.checks.push(degradedCheck);
      siteRuleResults.set(degradedRuleResult.meta.id, [degradedCheck]);
      siteRuleRunResults.set(degradedRuleResult.meta.id, degradedRuleResult);
    }

    return { siteResults: siteResult.checks, siteRuleResults, siteRuleRunResults };
  });
}

/** {@link runStreamingRules} result: the v1 {@link RuleExecutionResult} plus the folded per-rule tallies and the page-stream DOM-residency high-water mark. */
export interface StreamingRuleExecutionResult extends RuleExecutionResult {
  /**
   * Folded per-rule tallies (page + site + synthetic advisory rules). Scoring
   * these via `calculateHealthScoreFromTallies` is byte-identical to
   * `calculateHealthScore` over `ruleResultsMap` (§3 golden invariant) — the
   * bounded scoring path PR-F swaps in for the O(pages) ruleResultsMap.
   */
  tallies: Map<string, RuleTally>;
  /**
   * Max parsed DOMs simultaneously live during the PAGE-RULE stream only
   * (batch-bounded — the streaming win). With E-E2 (a) the site pass no longer
   * re-materializes DOMs (it reads page-time collectors), so DOM residency is now
   * batch-bounded end-to-end; this remains the page-stream high-water mark, named
   * explicitly so a caller sizing a large crawl reads the right number.
   */
  peakLiveDocsPageStream: number;
}

/**
 * Streaming twin of {@link runRulesOnStorage} (#1021, PR-E). Produces a
 * byte-identical {@link RuleExecutionResult} while bounding parsed-DOM residency
 * to one page batch, and additionally returns folded per-rule tallies (the PR-F
 * scoring path). DARK: no production path calls it; select on it behind a flag
 * only after the golden-diff proves parity (blueprint §5).
 *
 * `storage` is the concrete {@link SQLiteStorage} (streaming needs LIMIT/OFFSET
 * paging + page_features). Interruption between batches is handled by Effect (the
 * per-batch `getPages` is a yield point); `opts.signal` is an extra escape hatch
 * for a caller that already holds one.
 */
export function runStreamingRules(
  storage: SQLiteStorage,
  crawlId: string,
  config: Config,
  assets: PreFetchedAssets,
  scope?: RunnerScope,
  opts?: {
    batchSize?: number;
    hooks?: StreamPageRulesHooks;
    signal?: AbortSignal;
  },
): Effect.Effect<StreamingRuleExecutionResult, never, never> {
  return Effect.gen(function* () {
    const batchSize = opts?.batchSize ?? STREAM_PAGE_BATCH;

    // Threat-intel scope + runner (mirror of runRulesOnStorage).
    const effectiveScope =
      config.intel?.enabled && !scope?.intel ? { ...scope, intel: localIntelContext() } : scope;
    const runner = createRunner(config, effectiveScope);

    // Pass 1: DOM-free scalar universe (one batch of DOMs live at a time).
    const { parsedPages, pageDataMap, totalPageCount, wafBlockedPages } =
      yield* streamParsedUniverse(storage, crawlId, batchSize);

    // Steps 2+3: site-fetch phase + soft-404 verdict map.
    const { siteDataForPageRules, soft404Map } = yield* buildStreamingSiteData(
      storage,
      crawlId,
      config,
      assets,
      parsedPages,
      pageDataMap,
      totalPageCount,
    );

    // Pass 2: streamed page-rule pass — per-page DOM-drop, merge + fold. The
    // page-signal collector captures the six all-pages DOM-scanner rules' per-page
    // signal (leaked-secrets, byte weight, template fingerprint + integrity signals,
    // script srcs, sub-processor links) while each DOM is live (#1021 E-E2), so the
    // site pass reads `ctx.collectedSignals` instead of re-materializing every DOM.
    const collectedPages: CollectedPageSignal[] = [];
    const signalCollector: PageSignalCollector = {
      id: "site-dom-signals",
      collect(page, parsed) {
        collectedPages.push(
          buildCollectedPageSignal({ url: page.normalizedUrl, finalUrl: page.finalUrl, parsed }),
        );
      },
    };
    const streamed = yield* streamPageRules(storage, crawlId, runner, siteDataForPageRules, {
      batchSize,
      soft404Confirmations: soft404Map,
      collectors: [signalCollector],
      hooks: opts?.hooks,
      signal: opts?.signal,
    });
    const collectedSignals: CollectedSiteSignals = { pages: collectedPages };

    // Bounded, read-only aggregate view over the crawl (#1022): the site pass's
    // Bucket-C/D dual-path rules read its rollups (incoming-link counts, duplicate
    // groups, page_features) instead of scanning `site.pages`, so scoring a large
    // site never holds every page's scalars resident. page_features were populated
    // fresh during the stream (streamPageRules → upsertPageFeatures). orDie: a read
    // failure is a hard error, not a silent empty view (matches the streaming reads).
    // `universe` = v1's assembled site.pages order (parsedPages) so the incoming-link
    // graph's membership/order/sources match v1 exactly (E-E2 (b) reconciliation).
    const siteQuery = yield* createSiteQuery(storage, crawlId, {
      universe: parsedPages.map((p) => p.url),
    }).pipe(Effect.orDie);

    // Step 5: site pass over the DOM-free scalar universe (no re-materialization).
    const sitePass = yield* runSitePass(
      runner,
      siteDataForPageRules,
      assets,
      wafBlockedPages,
      collectedSignals,
      siteQuery,
    );

    // Step 6: assemble. Page rules were already merged + folded by streamPageRules;
    // merge + fold the site rules on top so ruleResultsMap and tallies stay in
    // lockstep — calculateHealthScoreFromTallies(tallies) === calculateHealthScore(ruleResultsMap).
    const ruleResultsMap = streamed.ruleResultsMap;
    const tallies = streamed.tallies;
    for (const [ruleId, rr] of sitePass.siteRuleRunResults) {
      mergeRuleRunResult(ruleResultsMap, ruleId, rr);
      foldRuleResultIntoTallies(tallies, ruleId, rr);
    }

    // Parsed-page cache for the report tail — same universe (auditable pages) v1
    // returns, with DOMs already dropped (report reads only extracted fields).
    const parsedPagesCache = new Map<string, ParsedPage>();
    for (const [url, { parsed }] of pageDataMap) parsedPagesCache.set(url, parsed);

    return {
      pageResults: streamed.pageResults,
      pageRuleResults: streamed.pageRuleResults,
      siteResults: sitePass.siteResults,
      siteRuleResults: sitePass.siteRuleResults,
      ruleResultsMap,
      parsedPages: parsedPagesCache,
      resourceSizes: assets.resourceSizes,
      sitemapUrlStatuses: assets.sitemapUrlStatuses,
      tallies,
      peakLiveDocsPageStream: streamed.peakLiveDocs,
    };
  });
}

// ============================================
// REPORT GENERATION
// ============================================

// Report types + the v1 assembly body live in ./report-stream (#1021, PR-F).
// Re-exported so the package barrel (index.ts imports these names from
// "./adapter") and every existing "./adapter" importer stay byte-identical.
export {
  emptyRuleExecutionResult,
  type AuditSummary,
  type FullAuditReport,
  type PageAudit,
  type RuleExecutionResult,
} from "./report-stream";

/**
 * Generate a FullAuditReport from crawler storage.
 *
 * Thin delegate to the shared v1 assembly core {@link buildV1Report}
 * (./report-stream, #1021 PR-F). Kept as a named export so the barrel + the
 * cloud/CLI call sites are unchanged; the 518-page golden-diff gates parity.
 */
export function generateReportFromStorage(
  storage: CrawlStorage,
  crawlId: string,
  ruleResults: RuleExecutionResult,
): Effect.Effect<FullAuditReport, never, never> {
  return buildV1Report(storage, crawlId, ruleResults);
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
 * Check all external links from site context
 * Results are stored in the crawl storage for use by rules
 *
 * @param siteContext - Pre-parsed site context (eliminates redundant parsing)
 * @param linkCache - Optional injectable link cache (CLI provides SQLite-backed; cloud passes null)
 * @param bulkChecker - Optional cloud bulk checker (paid dead_links service), tried first per url
 */
export function checkExternalLinksOnStorage(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: ExternalLinksConfig,
  onProgress?: (progress: ExternalLinkCheckProgress) => void,
  linkCache?: LinkCache | null,
  bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>,
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

    // Check external links using injected cache (or null for no caching)
    const cache = linkCache ?? null;
    const ttlSeconds = config.cache_ttl_days * 24 * 60 * 60;

    const results = yield* checkExternalLinks(Array.from(externalLinkOccurrences.keys()), cache, {
      ttlSeconds,
      concurrency: config.concurrency,
      timeoutMs: config.timeout_ms,
      userAgent: SQUIRRELSCAN_USER_AGENT,
      bulkChecker,
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
  baseUrl: string,
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
  },
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
      (candidate): candidate is string => !!candidate,
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

// The page-universe content-type gate — shared with page-features.ts's
// `isAuditablePage` so the extraction universe can't drift from `site.pages`.
export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}
