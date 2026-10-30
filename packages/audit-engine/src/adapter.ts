// Audit Adapter — package-portable version of apps/cli/src/audit/adapter.ts
// Bridges crawler storage data to the format expected by rules and reports.
// No CLI-specific imports (no logger, no link-cache, no infra/context types).

import {
  detectPageType,
  extractContactLinks,
  extractContent,
  extractFontUrls,
  hasErrorShellMarker,
  extractHeadings,
  extractImages,
  extractLinks,
  extractMeta,
  extractOG,
  extractPreloadedScriptUrls,
  extractScripts,
  extractStylesheets,
  extractTwitter,
  isSameDomainScript,
  parseDocument,
  parseSchemas,
  runClassifier,
  schemaCollectionFromJSON,
  EMPTY_SCHEMA_COLLECTION,
  extractAuthorFromSchema,
  extractVisibleMeta,
  toLinkData,
  type ParsedPageCache,
  type ParsePageOptions,
} from "@squirrelscan/parser";
import {
  buildCollectedPageSignal,
  createRunner,
  isRuleEnabled,
  isSiteIndexable,
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
  EndpointSurface,
  ParsedPage,
  RuleRunResult,
  SiteData,
  WebAppManifestData,
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
  UnverifiedReason,
} from "@squirrelscan/core-contracts";
import {
  CLOUD_RESOURCE_CHECK,
  LINK_CHECK_LIMITS,
  REPORT_LIMITS,
} from "@squirrelscan/core-contracts/limits";

import { createFetchBudget, type FetchBudget, type FetchBudgetSummary } from "./fetch-budget";
import {
  calculateHealthScore,
  deriveAuditStatusFromPages,
  foldRuleResultIntoTallies,
  type RuleTally,
} from "./scoring";
import { createEndpointCollector, entryFirst } from "./endpoint-discovery";
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
  unfetchedFrontierCount as countUnfetchedFrontier,
  type BuildV1ReportOptions,
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
  type PageResultSink,
  type PageSignalCollector,
  type StreamPageRulesHooks,
} from "./streaming";
import {
  bindRuleCache,
  computeRunContextHash,
  type RuleCacheDisabledReason,
  type RuleCacheStats,
  type RuleCacheStore,
  type StreamRuleCache,
} from "./rule-cache";
import { collectDroppedBatch } from "./batch-gc";
import { detachFromPage, detachParsedPage } from "./detach";
import { resolveCloakingProbes } from "./cloaking-probe";
import { createSiteQuery } from "./site-query";
import { confirmSoft404Candidates } from "./soft404-confirm";
import { headerScopeBase } from "@squirrelscan/utils/headers";

import { createHeaderScope, headersWithheldFrom } from "./lib/header-scope";
import {
  CHROME_USER_AGENT,
  RESOURCE_SIZE_LIMITS,
  SQUIRRELSCAN_USER_AGENT,
  STORED_SCRIPT_LIMITS,
} from "@squirrelscan/utils/constants";
import { maskLinkTokens } from "@squirrelscan/utils/link-actions";
import { isCloudflareEmailProtectionUrl } from "@squirrelscan/utils/cloudflare-email";

import { checkExternalLinks, type ExternalCheckResult, type LinkCache } from "./external-checker";
import { checkResourceSizes, type ResourceCheckResult } from "./resource-checker";
import {
  linkTextLooksLikeAnAction,
  type LinkTargetProbe,
  looksLikeAnAction,
  probeLinkTargets,
} from "./link-target-probe";
import {
  absorbWebAppManifestLinks,
  emptyWebAppManifestOccurrences,
  fetchWebAppManifests,
  type FetchedWebAppManifests,
  type WebAppManifestOccurrences,
} from "./web-app-manifest";
import { fetchScriptContents, type ScriptFetchResult } from "./script-fetcher";
import { overlayTechHeaders } from "@squirrelscan/utils/headers";
import { initialViewportFlags, selectImageCandidate } from "@squirrelscan/utils/image-loading";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";
import { isNonPublicHostname } from "@squirrelscan/utils/non-public-host";
import {
  type EgressPolicy,
  memoizeResolveHost,
  ownHostsPinned,
  refusedWithoutLookup,
  resolveHostAddresses,
} from "@squirrelscan/utils/public-egress";
import { ownSiteHostMatcher } from "@squirrelscan/utils/own-site";
import { getHostname, normalizeUrl } from "@squirrelscan/utils/url";
import { isInScope } from "@squirrelscan/crawler/frontier";
import { createRobotsEvaluator } from "@squirrelscan/crawler/robots";
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
          if (page.html == null) {
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
            // A parse stored before the marker was captured has no value, but
            // the DOM is live right here, so read it now rather than losing it.
            errorShell:
              typeof stored.errorShell === "boolean" ? stored.errorShell : hasErrorShellMarker(doc),
          };
        } catch (e) {
          logger.error(`Failed to deserialize parsedData for ${page.url}:`, e);
          // Fall through to re-parsing
        }
      }

      // Fallback: parse from HTML if no stored data (old crawls)
      if (!parsed) {
        // Skip pages without HTML and no stored data
        if (page.html == null) {
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
export function parseHtmlForRules(
  html: string,
  baseUrl: string,
  options?: ParsePageOptions,
): ParsedPage {
  const doc = parseDocument(html);
  // The page classifier, when the caller supplied one (#2307): same hook `parsePage` takes.
  const classified = runClassifier(options?.classify, doc, baseUrl, html);

  const meta = extractMeta(doc);
  const og = extractOG(doc);
  const twitter = extractTwitter(doc);
  const headings = extractHeadings(doc);
  const content = extractContent(doc, html);
  const links = extractLinks(doc, baseUrl, classified?.placeLink);
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
    links: links.map(toLinkData),
    // tel:/mailto: anchors, which `extractLinks` drops as non-crawlable. This is
    // the parse path production actually runs (parsePageRecord + the #263 page-rule
    // workers), so a field populated only by `parsePage` would be invisible live.
    contactLinks: extractContactLinks(doc, classified?.placeLink),
    images: images.map((i) => ({
      src: i.src,
      alt: i.alt,
      width: i.width,
      height: i.height,
    })),
    // Captured now, while the DOM is live: the streamed audit releases it before
    // soft-404 candidates are picked (#235).
    errorShell: hasErrorShellMarker(doc),
    // New schema data
    schemas,
    author,
    pageType,
    // Visible (non-schema) author/date markup
    visibleAuthor: visibleMeta.visibleAuthor,
    visibleDatePublished: visibleMeta.visibleDatePublished,
    visibleDateModified: visibleMeta.visibleDateModified,
    // Present only when the classifier ran (#2307).
    ...(classified ? { classification: classified.classification } : {}),
    // Legacy (deprecated)
    schema,
  };
}

/**
 * Parse a page record to extract structured data for rules
 */
export function parsePageRecord(page: PageRecord, options?: ParsePageOptions): ParsedPage | null {
  if (!page.html) return null;

  return logger.withTrace(
    "parsePageRecord",
    () => parseHtmlForRules(page.html!, page.url, options),
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
  /**
   * The runtime's fetch already resolves each host once and connects to the
   * address it validated (the hosted container's egress proxy). Third-party
   * probes are then vetted but not pinned again (#703): the proxy rewrites a
   * plain-http request's Host from its target, so a pinned one would lose its
   * name. Defaults to false, the CLI, where the engine pins them itself.
   */
  egressPinnedByTransport?: boolean;
  /**
   * Vet and pin the site's own hosts too (repo#3430): the assets and probes
   * on the audited host, its www twin and `project.domains` are checked and
   * connected to by address like every other host, so a site that points one
   * of them at a metadata address in DNS is never requested there. The CLI
   * sets it; it does nothing where the transport pins or an environment proxy
   * resolves the names (`ownHostsPinned`).
   */
  pinOwnHosts?: boolean;
  /** The resolver behind the asset phase's egress checks; the system's when unset (a test seam). */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * No request to any host outside the audited site and its subdomains
   * (`squirrel audit --offline`, pub#807): the third-party asset status checks
   * are skipped, so reliability/broken-resources reads them as not measured,
   * and a sitemap URL on another host gets no status check.
   */
  ownSiteOnly?: boolean;
}

/** Most preloaded chunks fetched per audit, on top of the regular script fetch. */
const PRELOAD_CHUNK_FETCH_LIMIT = 20;

/** The one rule that reads the third-party asset pools (#703). */
const BROKEN_RESOURCES_RULE_ID = "reliability/broken-resources";

/** The one rule that reads the web app manifest fetch (#710). */
const WEB_APP_MANIFEST_RULE_ID = "mobile/web-app-manifest";

/**
 * Referenced URLs each fetch cap left unfetched, per kind (#703): the count of
 * URLs the pages reference minus the rows the fetch returned.
 */
export interface AssetCapDropped {
  scripts: number;
  css: number;
  fonts: number;
  externalScripts: number;
  externalCss: number;
  externalFonts: number;
}

/**
 * Pre-fetched resource data — collected between crawl and rules phases.
 * Eliminates all HTTP requests during rules phase.
 */
export interface PreFetchedAssets {
  resourceSizes: {
    css: ResourceSizeData[];
    images: ResourceSizeData[];
    /** Font files the pages reference directly (preload, inline `@font-face`).
     * Optional: sizes are HEAD-checked at audit time and never persisted, so
     * anything that builds this by hand simply has no fonts. */
    fonts?: ResourceSizeData[];
  };
  scripts: ScriptContentData[];
  /**
   * Same-site chunks a page preloads (`modulepreload`, `preload as=script`) that
   * no `<script src>` names. Held apart from `scripts` so the file-size,
   * compression and minification rules see exactly what they saw before; only
   * security/csp-blocks-own-resources reads them. Optional: callers that build
   * assets by hand have none.
   */
  preloadedScripts?: ScriptContentData[];
  /**
   * Third-party scripts, stylesheets and fonts the pages reference (#703),
   * status-checked. Kept apart from `resourceSizes` and `scripts` so no size,
   * compression or script rule sees them; only reliability/broken-resources reads
   * them. Absent on hand-built assets.
   */
  externalAssets?: {
    scripts: ResourceSizeData[];
    css: ResourceSizeData[];
    fonts: ResourceSizeData[];
  };
  /**
   * Referenced URLs each fetch cap left unfetched (`maxScripts` / `maxResources`
   * slicing), per kind (#703). Zero or absent means nothing was dropped.
   */
  assetCapDropped?: AssetCapDropped;
  pdfSizes: ResourceSizeData[];
  sitemapUrlStatuses: SitemapUrlStatusData[];
  /**
   * Sitemap URLs on another site an own-site-only audit left unchecked
   * (pub#807), so crawl/sitemap-4xx can say so instead of passing. Absent or
   * zero means none were dropped.
   */
  sitemapOffSiteSkipped?: number;
  /**
   * Status of internal link targets the crawl did not fetch (repo#2729): one
   * HEAD (then GET) per target, most-linked first, read by links/broken-links as
   * known statuses. Optional: absent when internal link checks were off, and on
   * assets a caller builds by hand.
   */
  linkTargetStatuses?: SitemapUrlStatusData[];
  /** What the internal link probe covered: targets it could not reach, and how many it checked. */
  internalLinkProbe?: {
    unfetched: number;
    probed: number;
    cap: number;
    outOfScope?: number;
    headUnreliable?: boolean;
  };
  /**
   * #710: web app manifests the pages link, each with its icons checked. Optional:
   * callers that build assets by hand have none, so the rule reports not checked.
   */
  webAppManifests?: WebAppManifestData[];
  /** #710: linked same-site manifest URLs past the per-site fetch cap, not fetched. */
  webAppManifestsDropped?: number;
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
/**
 * The DOM-derived and scalar page signal {@link fetchAssetsFromOccurrences}
 * needs, accumulated across page batches by {@link createSiteAssetCollector}.
 * Everything here is bounded by the site's distinct sub-resource URLs, not by
 * page count × page size, which is what lets the cloud collect it with only one
 * batch of DOMs live at a time (#1860).
 */
export interface SiteAssetOccurrences {
  css: Map<string, Set<string>>;
  images: Map<string, Set<string>>;
  /**
   * Of `images`, the pages on which a URL is the file a browser would download
   * (the `src` of an image without `srcset`, or the `srcset` candidate selected at
   * the reference viewport and density, #1251). A URL absent here is only ever an
   * `<img src>` fallback behind a `srcset`.
   */
  imagesSelected?: Map<string, Set<string>>;
  /**
   * Of `imagesSelected`, the pages with at least one load that happens at page load:
   * anything but a `loading="lazy"` image below the initial viewport (#1252).
   */
  imagesEager?: Map<string, Set<string>>;
  scripts: Map<string, Set<string>>;
  /** Preloaded script chunks, kept out of `scripts` (see {@link PreFetchedAssets.preloadedScripts}). */
  preloads: Map<string, Set<string>>;
  pdfs: Map<string, Set<string>>;
  fonts: Map<string, Set<string>>;
  /** Third-party copies of the above (#703): kept out of the same-site maps. */
  externalCss: Map<string, Set<string>>;
  externalScripts: Map<string, Set<string>>;
  externalFonts: Map<string, Set<string>>;
  /** Web app manifest links and the theme-colors of the pages that link them (#710). */
  webAppManifests: WebAppManifestOccurrences;
  /** Scalars for the sitemap-coverage pass — v1's non-WAF parsed-page list. */
  coveragePages: Array<{ url: string; finalUrl?: string; statusCode: number }>;
  /** Every page absorbed, WAF and non-HTML included — v1's `siteContext.length`,
   * which sizes the script fetcher's per-page budget. */
  pageCount: number;
  /**
   * Internal link targets (repo#2729), keyed by normalized URL: the URL as
   * linked and how many pages link to it. Bounded at
   * MAX_TRACKED_INTERNAL_LINK_TARGETS distinct targets.
   */
  internalLinkTargets: Map<string, { url: string; pages: number; action?: boolean }>;
  /** Normalized URL of every page the crawl stored, non-HTML and 4xx included. */
  crawledUrls: Set<string>;
}

/**
 * Distinct internal link targets the asset collector remembers (repo#2729).
 * Far above what one audit probes (LINK_CHECK_LIMITS.internalTargetProbes), so
 * the most-linked ones are always among them, and bounded so a site with a
 * million links costs a bounded map.
 */
const MAX_TRACKED_INTERNAL_LINK_TARGETS = 50_000;

export function emptySiteAssetOccurrences(): SiteAssetOccurrences {
  return {
    css: new Map(),
    images: new Map(),
    imagesSelected: new Map(),
    imagesEager: new Map(),
    scripts: new Map(),
    preloads: new Map(),
    pdfs: new Map(),
    fonts: new Map(),
    externalCss: new Map(),
    externalScripts: new Map(),
    externalFonts: new Map(),
    webAppManifests: emptyWebAppManifestOccurrences(),
    coveragePages: [],
    pageCount: 0,
    internalLinkTargets: new Map(),
    crawledUrls: new Set(),
  };
}

/**
 * Batch-absorbing collector for the asset phase's page signal. `absorb` MUST be
 * called while the batch's DOMs are live (stylesheet + script srcs are read off
 * `parsed.document`); everything it retains is DOM-free, so the caller can drop
 * the batch immediately after. Feeding it the whole site context in one call is
 * exactly what {@link fetchResourceAssets} does, so the streamed and resident
 * paths run the same accumulation code.
 */
export function createSiteAssetCollector(
  baseUrl: string,
  /** See {@link absorbResourceOccurrences}. */
  isOwnHost?: (hostname: string) => boolean,
): {
  absorb: (siteContext: SiteContextPage[]) => void;
  occurrences: SiteAssetOccurrences;
} {
  const occurrences = emptySiteAssetOccurrences();
  let baseOrigin: string | null = null;
  try {
    baseOrigin = baseUrl ? new URL(baseUrl).origin : null;
  } catch {
    // ignore — no base origin means no same-origin PDF links are collected
  }

  return {
    occurrences,
    absorb(siteContext: SiteContextPage[]): void {
      // Same filtering as runRulesOnStorage: parsed, non-WAF. Note the page
      // COUNT below still counts every page, matching v1's siteContext.length.
      occurrences.pageCount += siteContext.length;
      // repo#2729: every stored page, so the link probe skips what the crawl
      // already fetched (a 404 the crawler stored is a known status, not a gap).
      for (const { page } of siteContext) {
        occurrences.crawledUrls.add(normalizeUrl(page.normalizedUrl));
      }
      const parsedPages: Array<{
        url: string;
        finalUrl?: string;
        statusCode: number;
        parsed: ParsedPage;
        hasCsp: boolean;
      }> = [];

      for (const { page, parsed } of siteContext) {
        if (!parsed) continue;
        const wafChallenge = detectWafChallengePage({
          status: page.status,
          headers: {
            server: page.headers.server,
            cfCacheStatus: page.headers.cfCacheStatus,
            xCache: page.headers.xCache,
            raw: page.headers.techHeaders,
          },
          html: page.html,
        });
        if (wafChallenge.detected) continue;

        parsedPages.push({
          url: page.normalizedUrl,
          finalUrl: page.finalUrl,
          statusCode: page.status,
          parsed,
          hasCsp: !!page.securityHeaders.csp || hasMetaCsp(parsed.document),
        });
      }

      for (const page of parsedPages) {
        occurrences.coveragePages.push({
          url: page.url,
          finalUrl: page.finalUrl,
          statusCode: page.statusCode,
        });
      }

      // Needs the DOM (stylesheet + script srcs aren't in stored parsedData).
      absorbResourceOccurrences(occurrences, parsedPages, baseUrl, isOwnHost);

      // Internal link targets for the link probe (repo#2729), from the same
      // parsed scalars links/broken-links reads, normalized the way it does.
      // Not a rate-limited page's (#1829): the rule never sees its links, and
      // the rule splits its unfetched targets by this probe's counts, so a
      // target only a 429 body links would be called skipped in place of one
      // the rule could not check (pub#794).
      for (const page of parsedPages) {
        if (isRateLimitStatus(page.statusCode)) continue;
        const seen = new Set<string>();
        const nofollowActions = nofollowActionTargets(page);
        for (const link of page.parsed.links) {
          if (!link.isInternal || !link.url || link.error) continue;
          // pub#811: an obfuscated email address, never requested. The parser
          // leaves these out of `links`; a parse stored before it did not.
          // links/broken-links skips them the same way.
          if (isCloudflareEmailProtectionUrl(link.url)) continue;
          const key = normalizeUrl(link.url);
          // A link any page words as an action ("Log out", or rel=nofollow on
          // action text) is never probed, wherever else it appears.
          const action =
            nofollowActions.has(key) ||
            linkTextLooksLikeAnAction(
              link.text ?? "",
              link.isNofollow === true || (link.rel?.includes("nofollow") ?? false),
            );
          const entry = occurrences.internalLinkTargets.get(key);
          if (entry && action) entry.action = true;
          if (seen.has(key)) continue;
          seen.add(key);
          if (entry) entry.pages++;
          else if (occurrences.internalLinkTargets.size < MAX_TRACKED_INTERNAL_LINK_TARGETS) {
            occurrences.internalLinkTargets.set(key, {
              url: link.url,
              pages: 1,
              ...(action ? { action } : {}),
            });
          }
        }
      }

      // Web app manifest links, same-site only (#710).
      for (const page of parsedPages) {
        absorbWebAppManifestLinks(occurrences.webAppManifests, page, (url) =>
          isSameDomainResource(url, getHostname(baseUrl).toLowerCase()),
        );
      }

      // PDF links come from parsed scalars.
      for (const page of parsedPages) {
        for (const link of page.parsed.links) {
          if (!link.url) continue;
          if (!link.url.toLowerCase().endsWith(".pdf")) continue;
          try {
            const linkOrigin = new URL(link.url).origin;
            if (baseOrigin && linkOrigin === baseOrigin) {
              const sources = occurrences.pdfs.get(link.url) ?? new Set<string>();
              sources.add(page.url);
              occurrences.pdfs.set(link.url, sources);
            }
          } catch {
            // Skip malformed URLs
          }
        }
      }
    },
  };
}

/**
 * What the occurrence maps say about how visitors load an image file (#1251,
 * #1252): `fallbackOnly` when it is only an `<img src>` behind a `srcset` whose
 * selected candidate is another file, `deferredPages` for the pages on which
 * every load of it is a lazy image below the initial viewport. Empty for a file
 * with neither, so the record is unchanged for the common case.
 */
export function imageLoadFlags(
  occurrences: Pick<SiteAssetOccurrences, "imagesSelected" | "imagesEager">,
  url: string,
): { fallbackOnly?: true; deferredPages?: string[] } {
  const selected = occurrences.imagesSelected?.get(url);
  if (!occurrences.imagesSelected) return {};
  if (!selected || selected.size === 0) return { fallbackOnly: true };
  const eager = occurrences.imagesEager?.get(url);
  const deferred = [...selected].filter((page) => !eager?.has(page));
  return deferred.length > 0 ? { deferredPages: deferred } : {};
}

/** A status-only third-party record (#703): no body, cache or compression fields. */
function externalAssetRecord(
  check: ResourceCheckResult,
  sources: Map<string, Set<string>>,
): ResourceSizeData {
  return {
    url: check.url,
    status: check.status,
    error: check.error,
    contentType: check.contentType,
    sizeBytes: check.sizeBytes,
    sourcePages: Array.from(sources.get(check.url) ?? []),
    rateLimited: check.rateLimited,
    wafBlocked: check.wafBlocked,
  };
}

/**
 * Referenced URLs the fetch caps left unfetched, per kind (#703): referenced
 * minus returned, floored at zero. Rows a budget skip returned still count as
 * fetched here; the rule reads those from their `skipped` error instead.
 */
export function assetCapDroppedOf(
  referenced: Pick<SiteAssetOccurrences, keyof AssetCapDropped>,
  fetched: Record<keyof AssetCapDropped, readonly unknown[]>,
): AssetCapDropped {
  const dropped = (kind: keyof AssetCapDropped): number =>
    Math.max(0, referenced[kind].size - fetched[kind].length);
  return {
    scripts: dropped("scripts"),
    css: dropped("css"),
    fonts: dropped("fonts"),
    externalScripts: dropped("externalScripts"),
    externalCss: dropped("externalCss"),
    externalFonts: dropped("externalFonts"),
  };
}

export function fetchResourceAssets(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: Config,
  overrides?: ResourceCheckOverrides,
): Effect.Effect<PreFetchedAssets, never, never> {
  return Effect.gen(function* () {
    const crawl = yield* storage
      .getCrawl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const collector = createSiteAssetCollector(
      crawl?.baseUrl ?? "",
      overrides?.ownSiteOnly === true
        ? ownSiteHostMatcher({ baseUrl: crawl?.baseUrl ?? "", domains: config.project?.domains })
        : undefined,
    );
    collector.absorb(siteContext);
    return yield* fetchAssetsFromOccurrences(
      storage,
      crawlId,
      collector.occurrences,
      config,
      overrides,
    );
  });
}

/**
 * The asset phase's network tail: sitemap coverage, then the bounded CSS /
 * image / script / PDF / sitemap-status fetches. Split out of
 * {@link fetchResourceAssets} (#1860) so the cloud can drive the collection half
 * one page batch at a time and still land in exactly this code.
 */
export function fetchAssetsFromOccurrences(
  storage: CrawlStorage,
  crawlId: string,
  occurrences: SiteAssetOccurrences,
  config: Config,
  overrides?: ResourceCheckOverrides,
): Effect.Effect<PreFetchedAssets, never, never> {
  return Effect.gen(function* () {
    const assetsSpan = logger.traceStart("fetchResourceAssets");

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
        isNewsSitemap: s.isNewsSitemap,
      })),
      sources: { robotsTxt: [] as string[], commonLocations: [] as string[] },
      totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
      orphanPages: [] as string[],
      missingPages: [] as string[],
      orphanPagesTotal: 0,
      failed: [],
      // Rules run against THIS object, not the report built later, so the
      // truncation flag has to be here or crawl/sitemap-exists still reports
      // "No XML sitemap found" for a walk that never looked (#1733).
      truncated: crawl?.stats?.sitemapDiscoveryTruncated ?? false,
    };

    // Every orphan the coverage pass found, in its order. These are the
    // sitemap-status check's CANDIDATES; what bounds them is `sitemapStatusLimit`
    // below (the configured resource limit), not the report's array cap.
    // Capping here instead silently stopped checking past REPORT_LIMITS.maxPages,
    // so a 404 at orphan 2,001 of a 3,000-page crawl was never looked at and
    // `crawl/sitemap-4xx` reported a pass (#1913). The cloud is unaffected: it
    // passes resourceCheckMaxItems = 100.
    let orphanCandidates: string[] = [];
    if (sitemapDiscovery.discovered.length > 0) {
      const coverage = computeSitemapCoverageData(occurrences.coveragePages, sitemapDiscovery);
      orphanCandidates = coverage.orphanPages;
      // The arrays that TRAVEL stay capped at the schema's array limit.
      sitemapDiscovery.orphanPages = coverage.orphanPages.slice(0, REPORT_LIMITS.maxPages);
      sitemapDiscovery.missingPages = coverage.missingPages.slice(0, REPORT_LIMITS.maxPages);
      sitemapDiscovery.orphanPagesTotal = coverage.orphanPages.length;
    }

    const resourceOccurrences = occurrences;
    const pdfUrls = occurrences.pdfs;

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
    // Unset (the CLI) → undefined → fetch as today. One budget for both
    // fetchers so a slow origin is detected across resource types, not
    // per-category.
    const budgetMs = overrides?.resourceCheckBudgetMs;
    const fetchBudget: FetchBudget | undefined =
      budgetMs && budgetMs > 0
        ? createFetchBudget({
            totalBudgetMs: budgetMs,
            tarpitLatencyMs: CLOUD_RESOURCE_CHECK.tarpitLatencyMs,
            tarpitStrikes: CLOUD_RESOURCE_CHECK.tarpitStrikes,
          })
        : undefined;

    // repo#2764: the site's own assets may not reach a link-local or cloud
    // metadata address. An open redirect on the site
    // (`/go?u=http://169.254.169.254/`), or a subdomain pointed at one, used
    // as a stylesheet, script, image or sitemap URL would otherwise send the
    // auditor's machine there. The hosts the crawl itself requests are sent
    // as it sends them; every other hop, subdomains included, is vetted
    // (private networks allowed: a LAN or dev-server audit) and connects to
    // the address it was vetted on.
    const resolveOnce = memoizeResolveHost(overrides?.resolveHost ?? resolveHostAddresses);
    const ownSiteHost = getHostname(baseUrl).toLowerCase();
    // The crawl's own host scope: the base host, its www/apex pair and
    // `project.domains`. These are requested as the crawl requests them.
    const inCrawlHostScope = (url: string): boolean => {
      if (!baseUrl) return false;
      try {
        return isInScope(url, {
          baseUrl,
          include: [],
          exclude: [],
          allowedDomains: config.project?.domains ?? [],
        }).allowed;
      } catch {
        return false;
      }
    };
    // The site's own for headers and pools: that scope plus subdomains. A
    // subdomain is still vetted: the crawl never requests it, and its name can
    // point anywhere (`imds.example.com A 169.254.169.254`).
    // #819: an offline audit holds the site's own assets to the site too: a
    // first-party URL that redirects to another host is not followed there, and
    // reads as not requested (broken-resources: "not measured").
    const offlineOwnHost =
      overrides?.ownSiteOnly === true
        ? ownSiteHostMatcher({ baseUrl, domains: config.project?.domains })
        : undefined;
    const isOwnSiteUrl = (url: string): boolean =>
      isSameDomainResource(url, ownSiteHost) ||
      inCrawlHostScope(url) ||
      (offlineOwnHost?.(getHostname(url)) ?? false);
    const ownSiteEgress: EgressPolicy = {
      allowPrivateNetwork: true,
      resolve: resolveOnce,
      pin: overrides?.egressPinnedByTransport !== true,
      ...(offlineOwnHost ? { allowHost: offlineOwnHost } : {}),
      // repo#3430: with the own hosts pinned, they are vetted like the rest.
      ...(ownHostsPinned(overrides ?? {})
        ? {}
        : { trustTarget: (url: URL) => inCrawlHostScope(url.href) }),
    };

    // The custom headers go to the audited origin and the hosts the user named,
    // not to every subdomain (#732).
    const headerScope = headerScopeOf(crawl, config);
    // Either the request or the redirect it ended on was sent without them.
    const withheld = (url: string, status: number | null, finalUrl?: string | null): boolean =>
      (status === 401 || status === 403) &&
      (headersWithheldFrom(url, config.crawler?.headers, headerScope) ||
        (finalUrl != null && headersWithheldFrom(finalUrl, config.crawler?.headers, headerScope)));

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
      // Web Bot Auth / custom headers apply to asset fetches too (#494). Only
      // the site's own: every pool on these options is same-site, and the
      // sitemap pool sends a URL on another host without them (below).
      ...(config.crawler?.headers && Object.keys(config.crawler.headers).length > 0
        ? { customHeaders: config.crawler.headers, headerScope }
        : {}),
      ...(fetchBudget ? { budget: fetchBudget } : {}),
      egress: ownSiteEgress,
    };

    // #1255: a run that stores scripts asks for every bundle, not the share of
    // the page count the audit fetches for its own checks.
    const storeScripts = config.storage?.store_scripts === true;
    const scriptFetchOptions: Parameters<typeof fetchScriptContents>[1] = {
      pageCount: occurrences.pageCount,
      ...(storeScripts
        ? {
            fetchAll: true,
            maxScripts: Math.min(
              STORED_SCRIPT_LIMITS.maxScriptsCeiling,
              Math.max(1, config.storage?.store_scripts_max_scripts ?? STORED_SCRIPT_LIMITS.maxScripts),
            ),
            maxTotalBytes: STORED_SCRIPT_LIMITS.heldBytes,
            totalTimeoutMs: STORED_SCRIPT_LIMITS.fetchTimeBudgetMs,
          }
        : maxResources != null
          ? { maxScripts: maxResources }
          : {}),
      ...(overrides?.resourceCheckTimeoutMs != null
        ? { timeoutMs: overrides.resourceCheckTimeoutMs }
        : {}),
      ...(config.crawler?.headers && Object.keys(config.crawler.headers).length > 0
        ? { customHeaders: config.crawler.headers, headerScope }
        : {}),
      ...(fetchBudget ? { budget: fetchBudget } : {}),
      egress: ownSiteEgress,
    };

    const sitemapStatusLimit = Math.min(
      orphanCandidates.length,
      maxResources ?? config.crawler?.max_pages ?? 500,
    );

    const pdfCheckLimit = Math.min(pdfUrls.size, maxResources ?? 50);

    // repo#2729: internal link targets the crawl never fetched, most-linked
    // first, so a linked 404 is found even when the crawl did not follow links.
    // Held to what the crawl itself may request: inside the crawl scope
    // (include/exclude, allowed domains) and, when robots.txt is respected,
    // allowed by it, and never a link that looks like an action or carries a
    // token (link-target-probe.ts). Excluded paths like /logout are often on
    // every page, so without this they would be the first requested.
    const internalLinksEnabled = config.internal_links?.enabled !== false;
    const probeCap = config.internal_links?.max_targets ?? LINK_CHECK_LIMITS.internalTargetProbes;
    // The crawl's own user agent, so the request is UA-equivalent to the crawl
    // (a bot wall that let the crawl through lets this through too).
    const probeUserAgent = crawl?.config?.userAgent || config.crawler?.user_agent || CHROME_USER_AGENT;
    const respectRobots = config.crawler?.respect_robots ?? true;
    const robotsRecord =
      internalLinksEnabled && respectRobots
        ? yield* storage.getRobotsTxt(crawlId).pipe(Effect.catchAll(() => Effect.succeed(null)))
        : null;
    const robots =
      robotsRecord?.exists && robotsRecord.content
        ? createRobotsEvaluator(
            robotsRecord.url,
            robotsRecord.content,
            // squirrelscan/repo#3271: the group the crawl was matched as. A crawl
            // row records it ("" or absent: matched on its user agent); only
            // without a row does this run's config say.
            (crawl?.config
              ? crawl.config.robotsUserAgent
              : config.crawler?.robots_user_agent) || probeUserAgent,
          )
        : null;
    const mayProbe = (url: string): boolean => {
      if (looksLikeAnAction(url)) return false;
      try {
        const scoped = isInScope(url, {
          baseUrl,
          include: config.crawler?.include ?? [],
          exclude: config.crawler?.exclude ?? [],
          allowedDomains: config.project?.domains ?? [],
        });
        return scoped.allowed && (robots === null || robots.isAllowed(url));
      } catch {
        return false;
      }
    };
    let outOfScope = 0;
    const unfetchedTargets =
      internalLinksEnabled && baseUrl
        ? Array.from(occurrences.internalLinkTargets.entries())
            .filter(([key, target]) => {
              if (occurrences.crawledUrls.has(key)) return false;
              if (!target.action && mayProbe(target.url)) return true;
              outOfScope++;
              return false;
            })
            .sort(([ak, a], [bk, b]) => b.pages - a.pages || (ak < bk ? -1 : ak > bk ? 1 : 0))
        : [];
    const probeTargets = unfetchedTargets.slice(0, probeCap).map(([, target]) => target.url);

    // Third-party copies feed reliability/broken-resources alone (#703), so
    // they are requested only when that rule runs, and get a per-kind cap of
    // their own, never above the caller's item cap.
    // pub#807: an own-site-only (offline) audit sends nothing to a third party.
    const probeExternalAssets =
      overrides?.ownSiteOnly !== true &&
      isRuleEnabled(
        BROKEN_RESOURCES_RULE_ID,
        // The runner's own defaults (runner.ts), so the two never disagree.
        config.rules?.enable ?? [],
        config.rules?.disable ?? [],
        (config.rule_options as Record<string, { enabled?: boolean }> | undefined)?.[
          BROKEN_RESOURCES_RULE_ID
        ],
      );
    const probeWebAppManifests = isRuleEnabled(
      WEB_APP_MANIFEST_RULE_ID,
      config.rules?.enable ?? [],
      config.rules?.disable ?? [],
      (config.rule_options as Record<string, { enabled?: boolean }> | undefined)?.[
        WEB_APP_MANIFEST_RULE_ID
      ],
    );
    const externalAssetLimit = probeExternalAssets
      ? Math.min(
          maxResources ?? RESOURCE_SIZE_LIMITS.MAX_EXTERNAL_ASSETS_TO_CHECK,
          RESOURCE_SIZE_LIMITS.MAX_EXTERNAL_ASSETS_TO_CHECK,
        )
      : 0;
    // Third-party status probes (#703) are not the site's own requests:
    //  - They carry none of the audit's credentials. The custom and Web Bot
    //    Auth headers (#494) go to the site's own host only; a probe sends
    //    User-Agent and Accept, nothing else.
    //  - They reach public addresses only, checked on every redirect hop, so a
    //    page cannot point squirrel at the auditor's own network or a metadata
    //    service. A site that is itself on a private network (`localhost:3000`)
    //    may probe private hosts, never link-local or metadata ones. An unknown
    //    base URL counts as public, the strict side. Each request connects to
    //    the address that was vetted, so DNS rebinding cannot swap it.
    //  - Status only: no body is read, and no prior-crawl cache is consulted.
    const { customHeaders: _ownHostOnly, priorByUrl: _ownHostCache, ...probeShared } =
      resourceCheckOptions;
    const baseHost = getHostname(baseUrl).replace(/^\[|\]$/g, "");
    let siteOrigin = "";
    try {
      siteOrigin = baseUrl ? new URL(baseUrl).origin : "";
    } catch {
      // An unparseable base URL grants no private exception.
    }
    const thirdPartyEgress: EgressPolicy = {
      allowPrivateNetwork: baseHost !== "" && isNonPublicHostname(baseHost),
      resolve: resolveOnce,
      pin: overrides?.egressPinnedByTransport !== true,
    };
    const externalCheckOptions = {
      ...probeShared,
      statusOnly: true,
      egress: thirdPartyEgress,
    };

    // repo#2764: a sitemap may list URLs on any host. The ones outside the
    // audited host and its subdomains are checked as the third-party probes
    // are: none of the audit's custom headers (Web Bot Auth signatures,
    // Authorization, cookies), no prior-crawl cache, public addresses only.
    // One cap for the pool as a whole: each half would otherwise get the
    // checker's own default cap.
    // pub#807: an own-site-only audit checks no sitemap URL on another site. They
    // are left out before the cap, so they take none of its slots.
    const sitemapCandidates =
      overrides?.ownSiteOnly === true
        ? orphanCandidates.filter((url) => isOwnSiteUrl(url))
        : orphanCandidates;
    const sitemapOffSiteSkipped = orphanCandidates.length - sitemapCandidates.length;
    const sitemapTargets = sitemapCandidates.slice(
      0,
      Math.min(sitemapStatusLimit, maxResources ?? RESOURCE_SIZE_LIMITS.MAX_RESOURCES_TO_CHECK),
    );
    const ownSitemapTargets = sitemapTargets.filter((url) => isOwnSiteUrl(url));
    const foreignSitemapTargets = sitemapTargets.filter((url) => !isOwnSiteUrl(url));

    const resourceCheckStart = Date.now();

    const allResourceChecks = Effect.all(
      {
        // verifyCompression only on the two pools perf/asset-compression reads
        // (#9) — the pdf and sitemap checks below never report on compression,
        // so they keep the cheap HEAD path and pay nothing for it. Only the
        // image pool reads headers, for images/responsive-size (#470).
        css: checkResourceSizes(Array.from(resourceOccurrences.css.keys()), {
          ...resourceCheckOptions,
          verifyCompression: true,
        }),
        images: checkResourceSizes(Array.from(resourceOccurrences.images.keys()), {
          ...resourceCheckOptions,
          verifyCompression: true,
          readImageHeader: true,
        }),
        // Same cheap HEAD path as the sitemap and pdf pools: a font's size is
        // all total-byte-weight reads.
        fonts: checkResourceSizes(
          Array.from(resourceOccurrences.fonts.keys()),
          resourceCheckOptions,
        ),
        scripts: fetchScriptContents(
          Array.from(resourceOccurrences.scripts.keys()),
          scriptFetchOptions,
        ),
        // Chunks no <script src> already covers, on a cap of their own so a
        // modulepreload-heavy site cannot grow the main script fetch.
        preloads: fetchScriptContents(
          Array.from(resourceOccurrences.preloads.keys()).filter(
            (url) => !resourceOccurrences.scripts.has(url),
          ),
          {
            ...scriptFetchOptions,
            maxScripts: Math.min(scriptFetchOptions.maxScripts ?? PRELOAD_CHUNK_FETCH_LIMIT, PRELOAD_CHUNK_FETCH_LIMIT),
          },
        ),
        pdfs: checkResourceSizes(
          Array.from(pdfUrls.keys()).slice(0, pdfCheckLimit),
          resourceCheckOptions,
        ),
        // Manifest body first, then its icons (the icon list comes from the body).
        // Every hop held to the site's own host and subdomains (#710): a manifest
        // or icon that redirects elsewhere is not followed there. Only when the
        // rule runs: disabled, it sends nothing and reads as not checked.
        webAppManifests: probeWebAppManifests
          ? fetchWebAppManifests(resourceOccurrences.webAppManifests, resourceCheckOptions, {
              // Private addresses only for a site that is itself private, or for the
              // site's own origin, which the crawl already requested: a public site's
              // subdomain (or another port) that resolves privately is refused.
              allowPrivateNetwork: baseHost !== "" && isNonPublicHostname(baseHost),
              allowPrivateTarget: (url) => siteOrigin !== "" && url.origin === siteOrigin,
              allowHost: (host) =>
                baseHost !== "" &&
                (host === baseHost ||
                  host.endsWith(`.${baseHost}`) ||
                  // An offline audit reads the www or apex twin and the project
                  // domains as the site's own everywhere else (#819).
                  (offlineOwnHost?.(host) ?? false)),
              resolve: resolveOnce,
              pin: overrides?.egressPinnedByTransport !== true,
            })
          : Effect.succeed(null as FetchedWebAppManifests | null),
        sitemap: Effect.all([
          checkResourceSizes(ownSitemapTargets, resourceCheckOptions),
          checkResourceSizes(foreignSitemapTargets, { ...probeShared, egress: thirdPartyEgress }),
        ]).pipe(
          // Back in the sitemap's order, as one pool.
          Effect.map(([own, foreign]) => {
            const byUrl = new Map([...own, ...foreign].map((r) => [r.url, r]));
            return sitemapTargets.flatMap((url) => {
              const result = byUrl.get(url);
              return result ? [result] : [];
            });
          }),
        ),
        // Status only, and safe by construction (link-target-probe.ts): HEAD,
        // GET only on 405/501, no credentials or custom headers, every
        // redirect hop held to the same checks. The crawl's UA, its own limit
        // (the cloud's per-pool item cap would otherwise cut it below
        // max_targets), and no more requests of its own in flight than the
        // crawl's per-host concurrency: every target is on the audited host.
        // The asset pools beside it keep their own limits, as before.
        linkTargets: probeLinkTargets(probeTargets, {
          userAgent: probeUserAgent,
          timeoutMs: resourceCheckOptions.timeoutMs,
          concurrency: Math.max(
            1,
            Math.min(resourceCheckOptions.concurrency, config.crawler?.per_host_concurrency ?? 2),
          ),
          mayRequest: mayProbe,
          // repo#2830: the asset pools' own-site policy, every hop, unless the
          // audited URL is itself an address it refuses (the user's choice).
          ...(baseUrl && !refusedWithoutLookup(baseUrl, ownSiteEgress)
            ? { egress: ownSiteEgress }
            : {}),
          ...(fetchBudget ? { budget: fetchBudget } : {}),
          // The audited URL, which the crawl fetched: the HEAD control.
          ...(baseUrl ? { controlUrl: baseUrl } : {}),
        }),
        // Third-party copies (#703): status only, through the HEAD-first checker, so
        // no body is stored. Read by reliability/broken-resources alone.
        externalCss: checkResourceSizes(
          Array.from(resourceOccurrences.externalCss.keys()).slice(0, externalAssetLimit),
          externalCheckOptions,
        ),
        externalScripts: checkResourceSizes(
          Array.from(resourceOccurrences.externalScripts.keys()).slice(0, externalAssetLimit),
          externalCheckOptions,
        ),
        externalFonts: checkResourceSizes(
          Array.from(resourceOccurrences.externalFonts.keys()).slice(0, externalAssetLimit),
          externalCheckOptions,
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
              fonts: [] as ResourceCheckResult[],
              scripts: [] as ScriptFetchResult[],
              preloads: [] as ScriptFetchResult[],
              pdfs: [] as ResourceCheckResult[],
              sitemap: [] as ResourceCheckResult[],
              linkTargets: { results: [], headUnreliable: false } as LinkTargetProbe,
              externalCss: [] as ResourceCheckResult[],
              externalScripts: [] as ResourceCheckResult[],
              externalFonts: [] as ResourceCheckResult[],
              webAppManifests: null as FetchedWebAppManifests | null,
            });
          },
        )
      : yield* allResourceChecks;

    logger.trace("resource checks", {
      css: resourceResults.css.length,
      images: resourceResults.images.length,
      fonts: resourceResults.fonts.length,
      scripts: resourceResults.scripts.length,
      preloads: resourceResults.preloads.length,
      pdfs: resourceResults.pdfs.length,
      sitemap: resourceResults.sitemap.length,
      elapsed: `${Date.now() - resourceCheckStart}ms`,
    });

    const result: PreFetchedAssets = {
      // Absent on the timeout fallback: not checked, rather than "no manifest linked".
      ...(resourceResults.webAppManifests
        ? {
            webAppManifests: resourceResults.webAppManifests.manifests,
            webAppManifestsDropped: resourceResults.webAppManifests.dropped,
          }
        : {}),
      resourceSizes: {
        css: resourceResults.css.map((check) => ({
          url: check.url,
          status: check.status,
          error: check.error,
          contentType: check.contentType,
          sizeBytes: check.sizeBytes,
          sourcePages: Array.from(resourceOccurrences.css.get(check.url) ?? []),
          rateLimited: check.rateLimited,
          wafBlocked: check.wafBlocked,
          ...(withheld(check.url, check.status, check.redirectTarget) ? { headersWithheld: true } : {}),
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
          ...imageLoadFlags(resourceOccurrences, check.url),
          rateLimited: check.rateLimited,
          wafBlocked: check.wafBlocked,
          contentEncoding: check.contentEncoding,
          transferBytes: check.transferBytes,
          cacheControl: check.cacheControl,
          etag: check.etag,
          lastModified: check.lastModified,
          vary: check.vary,
          cacheReason: check.cacheReason,
          naturalWidth: check.naturalWidth,
          naturalHeight: check.naturalHeight,
          animated: check.animated,
        })),
        fonts: resourceResults.fonts.map((check) => ({
          url: check.url,
          status: check.status,
          error: check.error,
          contentType: check.contentType,
          sizeBytes: check.sizeBytes,
          sourcePages: Array.from(resourceOccurrences.fonts.get(check.url) ?? []),
          rateLimited: check.rateLimited,
          wafBlocked: check.wafBlocked,
          ...(withheld(check.url, check.status, check.redirectTarget) ? { headersWithheld: true } : {}),
        })),
      },
      // Absent, not empty, when the rule is off: nothing was measured.
      ...(probeExternalAssets
        ? {
            externalAssets: {
              scripts: resourceResults.externalScripts.map((check) =>
                externalAssetRecord(check, resourceOccurrences.externalScripts),
              ),
              css: resourceResults.externalCss.map((check) =>
                externalAssetRecord(check, resourceOccurrences.externalCss),
              ),
              fonts: resourceResults.externalFonts.map((check) =>
                externalAssetRecord(check, resourceOccurrences.externalFonts),
              ),
            },
          }
        : overrides?.ownSiteOnly === true &&
            resourceOccurrences.externalScripts.size +
              resourceOccurrences.externalCss.size +
              resourceOccurrences.externalFonts.size ===
              0
          ? // pub#807: pages that reference no third-party resource leave
            // nothing unmeasured, so the rule need not say there was.
            { externalAssets: { scripts: [], css: [], fonts: [] } }
          : {}),
      assetCapDropped: assetCapDroppedOf(
        probeExternalAssets
          ? resourceOccurrences
          : {
              ...resourceOccurrences,
              externalScripts: new Map(),
              externalCss: new Map(),
              externalFonts: new Map(),
            },
        resourceResults,
      ),
      scripts: resourceResults.scripts.map((fetch) => ({
        url: fetch.url,
        status: fetch.status,
        error: fetch.error,
        contentType: fetch.contentType,
        sizeBytes: fetch.sizeBytes,
        content: fetch.content,
        sourcePages: Array.from(resourceOccurrences.scripts.get(fetch.url) ?? []),
        ...(fetch.fetchSkipReason ? { fetchSkipReason: fetch.fetchSkipReason } : {}),
        rateLimited: fetch.rateLimited,
        wafBlocked: fetch.wafBlocked,
        ...(withheld(fetch.url, fetch.status, fetch.finalUrl) ? { headersWithheld: true } : {}),
        redirected: fetch.redirected,
        finalUrl: fetch.finalUrl,
        sourceMapHeader: fetch.sourceMapHeader,
        contentEncoding: fetch.contentEncoding,
      })),
      preloadedScripts: resourceResults.preloads.map((fetch) => ({
        url: fetch.url,
        status: fetch.status,
        error: fetch.error,
        contentType: fetch.contentType,
        sizeBytes: fetch.sizeBytes,
        content: fetch.content,
        sourcePages: Array.from(resourceOccurrences.preloads.get(fetch.url) ?? []),
        redirected: fetch.redirected,
        finalUrl: fetch.finalUrl,
        sourceMapHeader: fetch.sourceMapHeader,
        contentEncoding: fetch.contentEncoding,
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
        // #1829: a throttled sitemap URL is unverified, not 4xx. Carried through
        // to crawl/sitemap-4xx, which would otherwise report it as dead.
        rateLimited: check.rateLimited,
      })),
      ...(sitemapOffSiteSkipped > 0 ? { sitemapOffSiteSkipped } : {}),
      ...(internalLinksEnabled
        ? {
            linkTargetStatuses: resourceResults.linkTargets.results.map((check) => ({
              url: check.url,
              status: check.status,
              error: check.error,
              rateLimited: check.rateLimited,
            })),
            internalLinkProbe: {
              unfetched: unfetchedTargets.length,
              // Answered, not merely attempted: a fetch the budget skipped or
              // that failed outright says nothing about the target.
              probed: resourceResults.linkTargets.results.filter(
                (r) => typeof r.status === "number" && r.status > 0,
              ).length,
              cap: probeCap,
              outOfScope,
              ...(resourceResults.linkTargets.headUnreliable ? { headUnreliable: true } : {}),
            },
          }
        : {}),
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
/**
 * Whether a stored page record carries the version headers (#713). The crawler
 * writes them as `null` when not sent; a record stored before they existed has
 * no key at all, and security/version-disclosure must not read that as "not sent".
 */
export function recordsVersionHeaders(page: PageRecord): boolean {
  return page.headers?.xPoweredBy !== undefined;
}

/**
 * The header map technology detection reads: the rule-facing map plus the
 * headers the crawler keeps for detection (pub#871), which a crawl reusing an
 * unchanged page refreshes.
 */
export function buildTechHeadersMap(page: PageRecord): Record<string, string> {
  return overlayTechHeaders(buildHeadersMap(page), page.headers.techHeaders);
}

export function buildHeadersMap(page: PageRecord): Record<string, string> {
  const headers: Record<string, string> = {};
  if (page.headers.contentType) {
    // The stored media type plus the charset parameter it was sent with
    // (pub#674); a record without one reads as before.
    const charset = page.headers.contentTypeCharset;
    headers["content-type"] = charset
      ? `${page.headers.contentType}; charset=${charset}`
      : page.headers.contentType;
  }
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
  // Version-revealing headers (security/version-disclosure, #713).
  if (page.headers.xPoweredBy) headers["x-powered-by"] = page.headers.xPoweredBy;
  if (page.headers.xAspNetVersion) headers["x-aspnet-version"] = page.headers.xAspNetVersion;
  if (page.headers.xAspNetMvcVersion)
    headers["x-aspnetmvc-version"] = page.headers.xAspNetMvcVersion;
  if (page.headers.xGenerator) headers["x-generator"] = page.headers.xGenerator;
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

/**
 * Where the crawl started: where its seed's redirects resolved and the URL it
 * was given (#788). Both engine paths hand this to the hidden-page checks.
 */
/**
 * Who gets the audit's custom headers: the audited origin (the start URL's, when
 * its redirect only moved it from https to http) and the hosts the user named.
 */
function headerScopeOf(
  crawl: { baseUrl?: string; originalUrl?: string } | null | undefined,
  config: Config,
) {
  return createHeaderScope(
    headerScopeBase(crawl?.originalUrl, crawl?.baseUrl ?? ""),
    config.crawler?.header_hosts ?? [],
  );
}

function crawlEntryUrls(
  crawl: { seedUrl?: string; originalUrl?: string } | null | undefined,
): string[] {
  return [crawl?.seedUrl, crawl?.originalUrl].filter((url): url is string => !!url);
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
  // repo#3430: the end-of-crawl probes vet and pin the site's own hosts (the CLI).
  pinOwnHosts?: boolean,
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
      sizeBytes?: number | null;
      rendered?: boolean;
      versionHeadersRecorded?: boolean;
    }> = [];
    const wafBlockedPages: Array<{
      url: string;
      provider: string | null;
    }> = [];
    const wafBlockedPageSet = new Set<string>();
    const rateLimitedPages: Array<{ url: string; status: number }> = [];
    const rateLimitedPageSet = new Set<string>();
    // Pages the crawl fetched that site.pages leaves out (pub#798).
    const fetchedTargets: NonNullable<SiteData["fetchedTargets"]> = [];

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
      if (!parsed) {
        // Skip non-HTML or failed parses. One that answered is still a known
        // status for a link to it (pub#798); 4xx/5xx join site.pages below. A
        // 3xx is stored only when its redirect never resolved: no answer.
        if (answeredOutsidePages(page)) {
          fetchedTargets.push({ url: page.normalizedUrl, status: page.status });
        }
        continue;
      }
      // Throttled pages describe our request rate, not the page (#1829).
      // Excluded from page-level scoring exactly as a WAF challenge page is:
      // grading a 429 body would file a soft-404 / noindex / slow-page finding
      // against a page nobody has actually seen.
      if (isRateLimitStatus(page.status)) {
        rateLimitedPages.push({ url: page.normalizedUrl, status: page.status });
        rateLimitedPageSet.add(page.normalizedUrl);
        fetchedTargets.push({ url: page.normalizedUrl, status: page.status, rateLimited: true });
        continue;
      }
      const wafChallenge = detectWafChallengePage({
        status: page.status,
        headers: {
          server: page.headers.server,
          cfCacheStatus: page.headers.cfCacheStatus,
          xCache: page.headers.xCache,
          raw: page.headers.techHeaders,
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
        fetchedTargets.push({ url: page.normalizedUrl, status: page.status, wafChallenge: true });
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
        sizeBytes: page.sizeBytes,
        rendered: isRenderedFetch(page.fetcherId),
        versionHeadersRecorded: recordsVersionHeaders(page),
      });
      pageDataMap.set(page.normalizedUrl, { page, parsed, headers });
    }

    // Add error pages (4xx/5xx) to site context for broken link detection
    // These pages have no HTML but their status codes are needed by the broken-links rule
    for (const { page } of siteContext) {
      if (
        page.status >= 400 &&
        !pageDataMap.has(page.normalizedUrl) &&
        !wafBlockedPageSet.has(page.normalizedUrl) &&
        // #1829: keep throttled pages out of the broken-link corpus too — this
        // loop is precisely what fed links/broken-links its false 4xx.
        !rateLimitedPageSet.has(page.normalizedUrl)
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
      /** pub#821: why a `wafBlocked` link is unverifiable. */
      unverifiedReason?: UnverifiedReason;
      /** Throttled: status unverified rather than broken (#1829). */
      rateLimited?: boolean;
    }> = [];

    // Rows the external check would refuse on their address are left out.
    const staleRowEgress = externalLinkEgress(crawl?.baseUrl ?? "");
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
        // repo#2759: never requested this audit. A row for one can still be
        // here, a verdict an earlier engine wrote and an incremental crawl
        // copied over with the page; it is not this audit's answer.
        if (isNotRequestedExternalLink(link.href, appearances.map((a) => a.anchorText ?? ""))) continue;
        // pub#770: nor one the external check refuses on its address.
        if (refusedWithoutLookup(link.href, staleRowEgress)) continue;
        // Nor any row this run did not write: an incremental crawl copies a
        // reused page's link rows from earlier crawls, verdicts and their
        // checkedAt included. This run's external phase stamps every row it
        // writes with the time it wrote it, so an older row is a verdict this
        // audit never made (a link it refused after lookup, left out, or did
        // not reach under the limit).
        if ((link.checkedAt ?? 0) < (crawl?.startedAt ?? 0)) continue;

        externalLinksData.push({
          href: link.href,
          status: link.status ?? null,
          error: link.error ?? null,
          // Dedupe: a page linking the same URL from nav + footer + body
          // records multiple appearances; the publish API caps sourcePages
          // at 100, so raw per-occurrence lists reject the whole report.
          sourcePages: [...new Set(appearances.map((a) => a.pageUrl))],
          wafBlocked: link.wafBlocked,
          rateLimited: link.rateLimited,
          wafProvider: link.wafProvider,
          ...(link.unverifiedReason ? { unverifiedReason: link.unverifiedReason } : {}),
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
        isNewsSitemap: s.isNewsSitemap,
      })),
      sources: { robotsTxt: robotsData?.sitemaps ?? [], commonLocations: [] },
      totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
      orphanPages: [] as string[],
      missingPages: [] as string[],
      orphanPagesTotal: 0,
      failed: [], // Not persisted to storage, only available during live audit
      // Rules run against THIS object, not the report built later, so the
      // truncation flag has to be here or crawl/sitemap-exists still reports
      // "No XML sitemap found" for a walk that never looked (#1733).
      truncated: crawl?.stats?.sitemapDiscoveryTruncated ?? false,
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
      sitemapDiscovery.orphanPagesTotal = coverage.orphanPages.length;
    }

    // Use pre-fetched resource data (no HTTP calls during rules phase)
    const {
      resourceSizes,
      scripts,
      preloadedScripts,
      externalAssets,
      assetCapDropped,
      pdfSizes,
      sitemapUrlStatuses,
      webAppManifests,
      webAppManifestsDropped,
    } = assets;

    // Differential cloaking probe (#118) — opt-in, bounded. Re-fetches suspicious
    // paths (orphan / recently-modified) with a googlebot UA + query variation and
    // compares; integrity/cloaking reads the result. Undefined when off, so the
    // rule no-ops instead of reporting "clean" for paths it never probed.
    const cloakingProbes = yield* Effect.promise(() =>
      resolveCloakingProbes(
        config.integrity?.cloaking_probe,
        {
          baseUrl: crawl?.baseUrl ?? "",
          entryUrls: crawlEntryUrls(crawl),
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
          headerScope: headerScopeOf(crawl, config),
          egress: probeEgress(crawl?.baseUrl ?? "", config, undefined, pinOwnHosts),
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
          headerScope: headerScopeOf(crawl, config),
          egress: probeEgress(crawl?.baseUrl ?? "", config, undefined, pinOwnHosts),
          // Honor the crawl's per-host politeness delay between same-host confirms.
          perHostDelayMs: config.crawler?.per_host_delay_ms,
        },
      ).catch((): undefined => undefined),
    );
    if (soft404ConfirmSummary && soft404ConfirmSummary.candidates > 0) {
      logger.trace("soft-404 confirmation pass", soft404ConfirmSummary);
    }

    // crawl/single-page-site: a crawl that stopped with URLs queued is not whole.
    const unfetchedPages = yield* countUnfetchedFrontier(storage, crawlId);

    // Step 2: Build site data object for page rules to access
    // This allows page-scope rules to access scripts, resourceSizes, etc.
    const siteDataForPageRules: SiteData = {
      baseUrl: crawl?.baseUrl ?? "",
      pages: parsedPages,
      // pub#457: noindex pages are skipped only on a site known to be indexed
      // (homepage, else the entry page). Decided once for both passes.
      siteIndexable: isSiteIndexable(parsedPages, crawl?.baseUrl ?? "", [
        crawl?.seedUrl,
        crawl?.originalUrl,
      ]),
      entryUrls: crawlEntryUrls(crawl),
      robotsTxt: robotsData,
      // What the site refused, so a rule says "refused" not "absent".
      refusedFetches: crawl?.stats?.refusedFetches,
      llmsTxt: llmsData,
      markdownResponse: markdownData,
      wellKnown: wellKnownData,
      agentAccess: agentAccessData,
      rsl: rslData,
      sitemaps: sitemapDiscovery,
      // repo#2729: undefined, not [], when external link checking was off, so
      // links/broken-external-links reports "not checked" instead of passing.
      externalLinks: config.external_links?.enabled === false ? undefined : externalLinksData,
      linkDiscoveryOff: crawl?.stats?.linkDiscoveryOff === true,
      externalLinkCheck: crawl?.stats?.externalLinkCheck,
      linkTargetStatuses: assets.linkTargetStatuses,
      internalLinkProbe: assets.internalLinkProbe,
      sitemapOffSiteSkipped: assets.sitemapOffSiteSkipped,
      fetchedTargets,
      resourceSizes,
      scripts,
      preloadedScripts,
      externalAssets,
      assetCapDropped,
      pdfSizes,
      sitemapUrlStatuses,
      webAppManifests,
      webAppManifestsDropped,
      cloakingProbes,
      // Raw committed-page count vs the run's configured cap (#697), so
      // sitemap-coverage can tell "crawl budget truncated this run" apart
      // from a genuine coverage gap.
      crawlLimits: {
        pagesCrawled: siteContext.length,
        maxPages: config.crawler?.max_pages ?? 100,
      },
      unfetchedPages,
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
    // Endpoint discovery: same collector the streaming path registers, fed from the
    // parsed pages v1 already holds. Passive; no request is made. The entry page
    // is chosen by URL and collected first, not by map insertion order.
    const endpointCollector = createEndpointCollector({
      headersOf: buildTechHeadersMap,
      entryUrl: siteDataForPageRules.baseUrl,
    });
    for (const { page, parsed } of entryFirst(pageDataMap.values(), siteDataForPageRules.baseUrl)) {
      endpointCollector.collect(page, parsed);
    }
    const siteResult = yield* Effect.promise(() =>
      runner.runSiteRules(
        siteDataForPageRules,
        undefined,
        undefined,
        endpointCollector.finish(siteDataForPageRules),
      ),
    );

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

    // #1829: same treatment for pages the host throttled. Deliberately status
    // "info", severity "info", weight 0 — unlike the WAF notice this must NOT
    // move the score. Being rate limited says nothing about the site's quality;
    // it says our crawl was too eager, and the operator's action is to slow the
    // crawl down, not to change the site.
    if (rateLimitedPages.length > 0) {
      const sampledPages = rateLimitedPages.slice(0, 5).map((page) => page.url);
      const statuses = Array.from(new Set(rateLimitedPages.map((page) => page.status))).sort(
        (a, b) => a - b,
      );

      const rateLimitCheck: CheckResult = {
        name: "Rate-limited pages",
        status: "info",
        message: `${rateLimitedPages.length} page(s) were rate limited (${statuses.join(", ")}); their status is unverified and they were excluded from page-level rule scoring.`,
        pages: sampledPages,
        details: {
          totalRateLimitedPages: rateLimitedPages.length,
          statuses,
          sampledPages,
        },
      };

      const rateLimitRuleResult: RuleRunResult = {
        meta: {
          id: "crawl/rate-limited-pages",
          name: "Rate-Limited Pages",
          description:
            "Pages the origin answered with rate limiting (429/430), so their real status could not be verified.",
          solution:
            "Slow the crawl down for this host: set `[crawler] per_host_concurrency = 1` and `per_host_delay_ms = 500` in squirrel.toml, and raise `max_backoff_ms` if the host needs longer recovery windows.",
          category: "crawl",
          scope: "site",
          severity: "info",
          weight: 0,
        },
        checks: [rateLimitCheck],
      };

      siteResult.checks.push(rateLimitCheck);
      siteRuleResults.set(rateLimitRuleResult.meta.id, [rateLimitCheck]);
      ruleResultsMap.set(rateLimitRuleResult.meta.id, rateLimitRuleResult);
      logger.warn(
        `Excluded ${rateLimitedPages.length} rate-limited page(s) from page-level scoring`,
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
  sizeBytes?: number | null;
  rendered?: boolean;
  versionHeadersRecorded?: boolean;
};

/**
 * The per-page identity the streamed universe retains, in place of the whole
 * {@link PageRecord}. Deliberately just the three scalars the post-Pass-1 steps
 * read (`buildStreamingSiteData`'s soft-404 confirm pass), because a PageRecord
 * carries `html` (≈1 MB on a script-heavy page) and `parsedData` — keeping one
 * per page put the O(pages × html) term straight back into a pipeline whose
 * whole point is bounding residency (#1860). `parsed` is the SAME object the
 * matching `parsedPages` entry holds, so it costs nothing extra.
 */
/**
 * A stored page left out of `site.pages` (it did not parse as HTML) that still
 * answered a link to it (pub#798): a 2xx, or a 3xx whose redirect chain did not
 * end in an error. The crawler stores a 3xx only when following it failed (a
 * loop, a missing Location, the hop cap), and that is no answer.
 */
function answeredOutsidePages(page: Pick<PageRecord, "status" | "redirectChain">): boolean {
  if (page.status < 200 || page.status >= 400) return false;
  return page.status < 300 || page.redirectChain?.endsInError !== true;
}

interface StreamPageIdentity {
  normalizedUrl: string;
  status: number;
  fetcherId?: string | null;
  parsed: ParsedPage;
}

interface ParsedUniverse {
  parsedPages: StreamParsedPage[];
  wafBlockedPages: Array<{ url: string; provider: string | null }>;
  wafBlockedPageSet: Set<string>;
  /** Pages excluded from scoring because the host was throttling (#1829). */
  rateLimitedPages: Array<{ url: string; status: number }>;
  rateLimitedPageSet: Set<string>;
  pageDataMap: Map<string, StreamPageIdentity>;
  /** Pages the crawl fetched that site.pages leaves out (pub#798). */
  fetchedTargets: NonNullable<SiteData["fetchedTargets"]>;
}

/**
 * Assemble the `site.pages` universe, EXACTLY as `runRulesOnStorage` does: HTML
 * pages first (WAF-challenge and rate-limited pages excluded and collected for
 * their advisory site checks), then 4xx/5xx error pages appended with
 * `EMPTY_PARSED_PAGE`. Reads only `page.html` + parsed scalars (never
 * `parsed.document`), so a DOM-dropped context yields the same universe — which
 * is what lets Pass 1 null each batch's DOMs before feeding it here.
 *
 * Batch-absorbing (`absorb` per batch, then one `build`) rather than taking the
 * whole site context, so Pass 1 never has to hold every `PageRecord` resident
 * just to assemble the universe. Order is preserved because HTML and error
 * entries are buffered separately and concatenated once, and the error-page
 * `!pageDataMap.has` test is deferred to `build`, where the map is complete —
 * the two places batching could otherwise diverge from v1's two-loop original.
 * Duplicated from v1's inline block to keep v1 untouched; the golden-diff gates
 * against drift.
 */
function createParsedUniverseAccumulator(): {
  absorb: (siteContext: SiteContextPage[]) => void;
  build: () => ParsedUniverse;
} {
  const htmlPages: StreamParsedPage[] = [];
  // v1 appends its 4xx/5xx entries AFTER every HTML page, so they are buffered
  // separately and concatenated in `build` — which is what makes absorbing the
  // crawl one batch at a time produce v1's exact `site.pages` order.
  const errorPages: StreamParsedPage[] = [];
  const wafBlockedPages: Array<{ url: string; provider: string | null }> = [];
  const wafBlockedPageSet = new Set<string>();
  const rateLimitedPages: Array<{ url: string; status: number }> = [];
  const rateLimitedPageSet = new Set<string>();
  const pageDataMap: ParsedUniverse["pageDataMap"] = new Map();
  const fetchedTargets: ParsedUniverse["fetchedTargets"] = [];
  // v1's second loop tests `!pageDataMap.has(url)` against the map as it stands
  // AFTER the whole first loop. Batching means a later batch can still add to
  // that map, so the error-page decision is deferred to `build`.
  const errorCandidates: StreamParsedPage[] = [];

  return {
    absorb(siteContext: SiteContextPage[]): void {
      for (const { page, parsed } of siteContext) {
        // Error-page candidates are collected for EVERY page (parsed or not),
        // mirroring v1's second loop, which iterates the whole site context.
        if (page.status >= 400) {
          errorCandidates.push({
            url: page.normalizedUrl,
            finalUrl: page.finalUrl,
            statusCode: page.status,
            parsed: EMPTY_PARSED_PAGE,
            headers: {},
            redirectChain: page.redirectChain,
          });
        }

        if (!parsed) {
          // non-HTML / failed parse — v1 skips these too, keeping the status
          // of one that answered for links to it (pub#798).
          if (answeredOutsidePages(page)) {
            fetchedTargets.push({ url: page.normalizedUrl, status: page.status });
          }
          continue;
        }
        // Mirrors v1's rate-limit exclusion (#1829); the golden diff gates drift.
        if (isRateLimitStatus(page.status)) {
          rateLimitedPages.push({ url: page.normalizedUrl, status: page.status });
          rateLimitedPageSet.add(page.normalizedUrl);
          fetchedTargets.push({ url: page.normalizedUrl, status: page.status, rateLimited: true });
          continue;
        }
        const wafChallenge = detectWafChallengePage({
          status: page.status,
          headers: {
            server: page.headers.server,
            cfCacheStatus: page.headers.cfCacheStatus,
            xCache: page.headers.xCache,
            raw: page.headers.techHeaders,
          },
          html: page.html,
        });
        if (wafChallenge.detected) {
          wafBlockedPages.push({ url: page.normalizedUrl, provider: wafChallenge.provider });
          wafBlockedPageSet.add(page.normalizedUrl);
          fetchedTargets.push({ url: page.normalizedUrl, status: page.status, wafChallenge: true });
          continue;
        }

        // Drop the page's extracted TEXT before retaining the parse (#1860).
        //
        // This is the single largest thing the streamed universe holds: measured
        // over a 509-page crawl of ~1 MB pages, the retained ParsedPage set is
        // 40.5 KB per page and `content.textContent` is 39.1 KB of it — 97%.
        // Nothing that reads this universe wants it. Site rules take their text
        // from `ctx.collectedSignals` or from their own DOM walk; the four rules
        // that do read `content.textContent` read it off `ctx.parsed`, the PAGE
        // context, which Pass 2 re-parses fresh; and the report's summary and
        // page audits read only meta/og/twitter/schema/h1 and the `isThinContent`
        // flag, all of which survive. Every other `content` field is kept.
        //
        // The golden diff is the check on that reasoning: a site rule that did
        // read this text would produce different findings than v1 and fail.
        if (parsed.content?.textContent) parsed.content.textContent = "";

        // Detach BEFORE retaining (#1860). A parse that ran against a live DOM
        // hands back scalars that are slices of the page's HTML, and the
        // universe outlives every batch, so one retained href holds a whole
        // 959 KB page for the rest of the run. Cloned once and shared by both
        // consumers below — `runSitePass`'s soft-404 confirm mutates the parse
        // through `pageDataMap` and `parsedPages` has to see that mutation.
        const kept = detachParsedPage(parsed);

        const headers = buildHeadersMap(page);
        htmlPages.push({
          url: page.normalizedUrl,
          finalUrl: page.finalUrl,
          statusCode: page.status,
          parsed: kept,
          headers,
          redirectChain: page.redirectChain,
          rendered: isRenderedFetch(page.fetcherId),
          versionHeadersRecorded: recordsVersionHeaders(page),
        });
        // Scalars only — NOT the PageRecord (see StreamPageIdentity).
        pageDataMap.set(page.normalizedUrl, {
          normalizedUrl: page.normalizedUrl,
          status: page.status,
          fetcherId: page.fetcherId,
          parsed: kept,
        });
      }
    },

    build(): ParsedUniverse {
      // Error pages (4xx/5xx) carry no HTML but their status codes feed
      // broken-link detection — appended after the HTML pages exactly as v1 does.
      for (const candidate of errorCandidates) {
        if (
          !pageDataMap.has(candidate.url) &&
          !wafBlockedPageSet.has(candidate.url) &&
          !rateLimitedPageSet.has(candidate.url)
        ) {
          errorPages.push(candidate);
        }
      }
      return {
        parsedPages: [...htmlPages, ...errorPages],
        wafBlockedPages,
        wafBlockedPageSet,
        rateLimitedPages,
        rateLimitedPageSet,
        pageDataMap,
        fetchedTargets,
      };
    },
  };
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
    const universe = createParsedUniverseAccumulator();
    let totalPageCount = 0;

    for (let offset = 0; ; offset += batchSize) {
      // A read failure mid-stream is a HARD error, not end-of-crawl — orDie so a
      // transient batch failure crashes the audit loud rather than truncating the
      // page set silently (see streamPageRules; keeps the error channel `never`).
      const batch = yield* storage.getPages(crawlId, { limit: batchSize, offset }).pipe(Effect.orDie);
      if (batch.length === 0) break;
      totalPageCount += batch.length;

      const ctx = yield* buildSiteContext(batch);
      // Absorb THEN drop, and never retain `ctx` past the iteration: the
      // accumulator keeps only parsed scalars, so this batch's PageRecords (each
      // holding the page's full html) become garbage at the end of the loop body.
      // Absorbing before the release is safe — the universe reads page.html for
      // WAF detection but never `parsed.document`.
      universe.absorb(ctx);
      releaseSiteContextDocuments(ctx);
      collectDroppedBatch();

      if (batch.length < batchSize) break;
    }

    return { ...universe.build(), totalPageCount };
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
  fetchedTargets: ParsedUniverse["fetchedTargets"],
  egressPinnedByTransport?: boolean,
  pinOwnHosts?: boolean,
  ownSiteOnly?: boolean,
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
      /** pub#821: why a `wafBlocked` link is unverifiable. */
      unverifiedReason?: UnverifiedReason;
      /** Throttled: status unverified rather than broken (#1829). */
      rateLimited?: boolean;
    }> = [];

    // Rows the external check would refuse on their address are left out.
    const staleRowEgress = externalLinkEgress(crawl?.baseUrl ?? "");
    for (const link of allLinks) {
      if (!link.isInternal) {
        const appearances = linkAppearancesByHref.get(link.href) ?? [];
        // repo#2759: never requested this audit; see the v1 builder.
        if (isNotRequestedExternalLink(link.href, appearances.map((a) => a.anchorText ?? ""))) continue;
        // pub#770: nor one the external check refuses on its address.
        if (refusedWithoutLookup(link.href, staleRowEgress)) continue;
        // Nor any row this run did not write: an incremental crawl copies a
        // reused page's link rows from earlier crawls, verdicts and their
        // checkedAt included. This run's external phase stamps every row it
        // writes with the time it wrote it, so an older row is a verdict this
        // audit never made (a link it refused after lookup, left out, or did
        // not reach under the limit).
        if ((link.checkedAt ?? 0) < (crawl?.startedAt ?? 0)) continue;

        externalLinksData.push({
          href: link.href,
          status: link.status ?? null,
          error: link.error ?? null,
          // Dedupe: the publish API caps sourcePages at 100, so raw per-occurrence
          // lists (nav + footer + body) would reject the whole report.
          sourcePages: [...new Set(appearances.map((a) => a.pageUrl))],
          wafBlocked: link.wafBlocked,
          rateLimited: link.rateLimited,
          wafProvider: link.wafProvider,
          ...(link.unverifiedReason ? { unverifiedReason: link.unverifiedReason } : {}),
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
        isNewsSitemap: s.isNewsSitemap,
      })),
      sources: { robotsTxt: robotsData?.sitemaps ?? [], commonLocations: [] },
      totalUrls: sitemaps.reduce((sum, s) => sum + s.urlCount, 0),
      orphanPages: [] as string[],
      missingPages: [] as string[],
      orphanPagesTotal: 0,
      failed: [],
      // Rules run against THIS object, not the report built later, so the
      // truncation flag has to be here or crawl/sitemap-exists still reports
      // "No XML sitemap found" for a walk that never looked (#1733).
      truncated: crawl?.stats?.sitemapDiscoveryTruncated ?? false,
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
      sitemapDiscovery.orphanPagesTotal = coverage.orphanPages.length;
    }

    const {
      resourceSizes,
      scripts,
      preloadedScripts,
      externalAssets,
      assetCapDropped,
      pdfSizes,
      sitemapUrlStatuses,
      webAppManifests,
      webAppManifestsDropped,
    } = assets;

    const cloakingProbes = yield* Effect.promise(() =>
      resolveCloakingProbes(
        config.integrity?.cloaking_probe,
        {
          baseUrl: crawl?.baseUrl ?? "",
          entryUrls: crawlEntryUrls(crawl),
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
          headerScope: headerScopeOf(crawl, config),
          egress: probeEgress(
            crawl?.baseUrl ?? "",
            config,
            egressPinnedByTransport,
            pinOwnHosts,
            ownSiteOnly,
          ),
        },
      ),
    );

    // Soft-404 confirmation (#1177) — mutates each candidate's
    // `parsed.soft404Confirmation` in place (soft404-confirm.ts). Bounded to
    // flagged candidates; a failed/absent re-fetch degrades to `unconfirmed`.
    yield* Effect.promise(() =>
      confirmSoft404Candidates(
        Array.from(pageDataMap.values(), (page) => ({
          url: page.normalizedUrl,
          statusCode: page.status,
          parsed: page.parsed,
          rendered: isRenderedFetch(page.fetcherId),
        })),
        {
          enabled: config.integrity?.soft404_confirm?.enabled ?? true,
          maxConfirmations: config.integrity?.soft404_confirm?.max_confirmations,
          wallBudgetMs: config.integrity?.soft404_confirm?.budget_ms,
          userAgent: crawl?.config?.userAgent || config.crawler?.user_agent || CHROME_USER_AGENT,
          customHeaders: config.crawler?.headers,
          headerScope: headerScopeOf(crawl, config),
          egress: probeEgress(
            crawl?.baseUrl ?? "",
            config,
            egressPinnedByTransport,
            pinOwnHosts,
            ownSiteOnly,
          ),
          perHostDelayMs: config.crawler?.per_host_delay_ms,
        },
      ).catch((): undefined => undefined),
    );

    const unfetchedPages = yield* countUnfetchedFrontier(storage, crawlId);

    const siteDataForPageRules: SiteData = {
      baseUrl: crawl?.baseUrl ?? "",
      pages: parsedPages,
      // pub#457: see runRulesOnStorage — same decision, same input.
      siteIndexable: isSiteIndexable(parsedPages, crawl?.baseUrl ?? "", [
        crawl?.seedUrl,
        crawl?.originalUrl,
      ]),
      entryUrls: crawlEntryUrls(crawl),
      robotsTxt: robotsData,
      // What the site refused, so a rule says "refused" not "absent".
      refusedFetches: crawl?.stats?.refusedFetches,
      llmsTxt: llmsData,
      markdownResponse: markdownData,
      wellKnown: wellKnownData,
      agentAccess: agentAccessData,
      rsl: rslData,
      sitemaps: sitemapDiscovery,
      // repo#2729: see runRulesOnStorage — undefined means "not checked".
      externalLinks: config.external_links?.enabled === false ? undefined : externalLinksData,
      linkDiscoveryOff: crawl?.stats?.linkDiscoveryOff === true,
      externalLinkCheck: crawl?.stats?.externalLinkCheck,
      linkTargetStatuses: assets.linkTargetStatuses,
      internalLinkProbe: assets.internalLinkProbe,
      sitemapOffSiteSkipped: assets.sitemapOffSiteSkipped,
      fetchedTargets,
      resourceSizes,
      scripts,
      preloadedScripts,
      externalAssets,
      assetCapDropped,
      pdfSizes,
      sitemapUrlStatuses,
      webAppManifests,
      webAppManifestsDropped,
      cloakingProbes,
      crawlLimits: {
        pagesCrawled: totalPageCount,
        maxPages: config.crawler?.max_pages ?? 100,
      },
      unfetchedPages,
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
  rateLimitedPages: ReadonlyArray<{ url: string; status: number }>,
  collectedSignals: CollectedSiteSignals,
  siteQuery: SiteQuery,
  endpointSurface: EndpointSurface,
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
      runner.runSiteRules(siteData, siteQuery, collectedSignals, endpointSurface),
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

    // #1829, verbatim from runRulesOnStorage and in v1's position (after the WAF
    // notice, before the asset-degradation note). This was MISSING from the
    // streaming twin: #1829 landed after the #1021 golden gate was written and
    // the golden fixtures carry no 429/430 pages, so the gate never caught it —
    // a throttled cloud crawl silently lost the advisory on this path.
    if (rateLimitedPages.length > 0) {
      const sampledPages = rateLimitedPages.slice(0, 5).map((page) => page.url);
      const statuses = Array.from(new Set(rateLimitedPages.map((page) => page.status))).sort(
        (a, b) => a - b,
      );

      const rateLimitCheck: CheckResult = {
        name: "Rate-limited pages",
        status: "info",
        message: `${rateLimitedPages.length} page(s) were rate limited (${statuses.join(", ")}); their status is unverified and they were excluded from page-level rule scoring.`,
        pages: sampledPages,
        details: {
          totalRateLimitedPages: rateLimitedPages.length,
          statuses,
          sampledPages,
        },
      };

      const rateLimitRuleResult: RuleRunResult = {
        meta: {
          id: "crawl/rate-limited-pages",
          name: "Rate-Limited Pages",
          description:
            "Pages the origin answered with rate limiting (429/430), so their real status could not be verified.",
          solution:
            "Slow the crawl down for this host: set `[crawler] per_host_concurrency = 1` and `per_host_delay_ms = 500` in squirrel.toml, and raise `max_backoff_ms` if the host needs longer recovery windows.",
          category: "crawl",
          scope: "site",
          severity: "info",
          weight: 0,
        },
        checks: [rateLimitCheck],
      };

      siteResult.checks.push(rateLimitCheck);
      siteRuleResults.set(rateLimitRuleResult.meta.id, [rateLimitCheck]);
      siteRuleRunResults.set(rateLimitRuleResult.meta.id, rateLimitRuleResult);
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

/**
 * The sub-phases of {@link runStreamingRules}, in execution order. Named so a
 * memory or wall-clock step can be attributed to one of them instead of to
 * "rules" as a whole (#1860).
 */
export type StreamingRulePhase =
  /** Pass 1: the streamed DOM-free scalar universe. */
  | "universe"
  /** Steps 2+3: robots/sitemaps/links/cloaking/soft-404, plus siteData assembly. */
  | "site-fetch"
  /** Pass 2: the streamed page-rule loop (this one already heartbeats per N pages). */
  | "page-rules"
  /** The bounded aggregate view over the crawl (incoming links, page_features). */
  | "site-query"
  /** The site-rule pass over the DOM-free universe + collected signals. */
  | "site-rules"
  /** Merging + folding the site results and building the report's parsed cache. */
  | "assemble";

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
  /**
   * What the per-page rule-result cache did this run (#1990). Zeros with no
   * `disabledReason` mean no cache was supplied (the cloud); zeros WITH one mean a
   * cache was supplied and deliberately not used.
   */
  ruleCache: RuleCacheStats;
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
    /**
     * #1252 page-loop hooks, forwarded to {@link streamPageRules}. The cloud
     * passes them so the sync page-rule CPU yields to the event loop and emits a
     * progress marker every N pages; omitted → byte-identical local behavior.
     */
    pageLoopHooks?: PageRuleLoopHooks;
    /**
     * Sub-phase boundaries inside the rules pass (#1860).
     *
     * The pass emits nothing between "rules started" and "rules completed", and a
     * production run at 150 pages showed two ~1 GB steps hiding in exactly those
     * gaps — one before the first page heartbeat, one after the last — which the
     * event stream could not attribute to anything. Callers hook this to sample
     * RSS (or time) per sub-phase. The engine deliberately does not sample
     * anything itself: `process` is the caller's concern.
     */
    onPhase?: (phase: StreamingRulePhase, boundary: "start" | "end") => void;
    /**
     * Template fan-out (#1951), forwarded to {@link streamPageRules}. Omitted →
     * the env default (ON, `SQUIRREL_TEMPLATE_FANOUT=0` to kill it). Benches and
     * the equivalence test set it explicitly to run both arms in one process.
     */
    templateFanout?: boolean;
    /**
     * Per-page rule-result cache (#1990). A store here turns on replay: a page
     * whose inputs are unchanged since a previous audit skips its parse and its
     * rules. Omitted → every page runs, exactly as before, which is what the
     * cloud does (it has no project.db to cache into).
     */
    ruleCache?: {
      /** Where entries live. The CLI backs this with `project.db`. */
      store: RuleCacheStore;
      /**
       * The build identity of the rules that produced (and will consume) the
       * entries — the CLI's release version. Part of the key, so upgrading the
       * binary invalidates every entry even when no rule id or option changed.
       */
      engineVersion: string;
      /**
       * A hash of the rule code, also part of the key, so a rule change that
       * ships without a version bump still invalidates every entry.
       */
      rulesVersion: string;
    };
    /**
     * Take ownership of each page's rule output as it is produced (#2343), so it
     * does not have to be held until the report. Forwarded verbatim to
     * {@link streamPageRules} — see {@link PageResultSink}.
     */
    pageSink?: PageResultSink;
    /**
     * The transport resolves once and connects to the address it validated (the
     * hosted container's egress proxy), so the soft-404 and cloaking probes do
     * not pin their own hops (#2831). Same meaning as
     * `ResourceCheckOverrides.egressPinnedByTransport`.
     */
    egressPinnedByTransport?: boolean;
    /**
     * Vet and pin the site's own hosts in the soft-404 and cloaking probes too
     * (repo#3430). Same meaning as `ResourceCheckOverrides.pinOwnHosts`.
     */
    pinOwnHosts?: boolean;
    /**
     * The soft-404 and cloaking probes send nothing to a host outside the
     * audited site (`squirrel audit --offline`, #819). Same meaning as
     * `ResourceCheckOverrides.ownSiteOnly`.
     */
    ownSiteOnly?: boolean;
    /**
     * Keep the O(pages × page bytes) result maps. Default TRUE (today's
     * behaviour, and what the cloud path runs on).
     *
     * FALSE (#2343) is the bounded mode the CLI runs: `pageResults`,
     * `pageRuleResults` and `parsedPages` come back EMPTY, and `ruleResultsMap`
     * carries the SITE rules only. `tallies` still carries every rule's meta and
     * exact counts, which is everything scoring needs
     * (`calculateHealthScoreFromTallies`). A caller passing false MUST have a
     * `pageSink`, or the run's page-level findings go nowhere.
     */
    retainPageResults?: boolean;
  },
): Effect.Effect<StreamingRuleExecutionResult, never, never> {
  return Effect.gen(function* () {
    // Clamped — see streaming.ts; a 0 batch would loop forever over the crawl.
    const batchSize = Math.max(1, opts?.batchSize ?? STREAM_PAGE_BATCH);
    const retainPageResults = opts?.retainPageResults ?? true;
    const onPhase = opts?.onPhase;
    const phase = <T,>(name: StreamingRulePhase, body: () => Effect.Effect<T, never, never>) =>
      Effect.gen(function* () {
        onPhase?.(name, "start");
        const out = yield* body();
        onPhase?.(name, "end");
        return out;
      });

    // Threat-intel scope + runner (mirror of runRulesOnStorage).
    const effectiveScope =
      config.intel?.enabled && !scope?.intel ? { ...scope, intel: localIntelContext() } : scope;
    const runner = createRunner(config, effectiveScope);

    // Pass 1: DOM-free scalar universe (one batch of DOMs live at a time).
    const {
      parsedPages,
      pageDataMap,
      totalPageCount,
      wafBlockedPages,
      rateLimitedPages,
      fetchedTargets,
    } = yield* phase("universe", () => streamParsedUniverse(storage, crawlId, batchSize));

    // Steps 2+3: site-fetch phase + soft-404 verdict map.
    const { siteDataForPageRules, soft404Map } = yield* phase("site-fetch", () =>
      buildStreamingSiteData(
        storage,
        crawlId,
        config,
        assets,
        parsedPages,
        pageDataMap,
        totalPageCount,
        fetchedTargets,
        opts?.egressPinnedByTransport,
        opts?.pinOwnHosts,
        opts?.ownSiteOnly,
      ),
    );

    // Pass 2: streamed page-rule pass — per-page DOM-drop, merge + fold. The
    // page-signal collector captures the six all-pages DOM-scanner rules' per-page
    // signal (leaked-secrets, byte weight, template fingerprint + integrity signals,
    // script srcs, sub-processor links) while each DOM is live (#1021 E-E2), so the
    // site pass reads `ctx.collectedSignals` instead of re-materializing every DOM.
    // #1990: the run context — every input a page rule can read that is not the
    // page itself. Resolved AFTER the site-fetch phase because two of its
    // ingredients (`scripts`, `resourceSizes`) come from it, and before the page
    // loop because every key depends on it. Threat intel is a hard OFF rather than
    // an ingredient: its verdicts come from feeds behind a memoized handle with no
    // exact identity to hash, so an unchanged key would not mean an unchanged
    // answer. See rule-cache.ts.
    let ruleCache: StreamRuleCache | undefined;
    let ruleCacheDisabled: RuleCacheDisabledReason | undefined;
    const ruleCacheOpts = opts?.ruleCache;
    if (ruleCacheOpts) {
      if (effectiveScope?.intel) {
        ruleCacheDisabled = "threat-intel-enabled";
      } else {
        const ctxHash = yield* Effect.promise(() =>
          computeRunContextHash({
            engineVersion: ruleCacheOpts.engineVersion,
            rulesVersion: ruleCacheOpts.rulesVersion,
            pageRules: runner.pageRuleSignature(),
            siteData: siteDataForPageRules,
            siteMetadata: effectiveScope?.siteMetadata,
            cloudResults: effectiveScope?.cloudResults,
            // Read through the runner's own view of config (`RulesConfig`), which
            // is where the escape hatch is declared; the engine's `Config` type
            // predates it and does not carry it.
            ignoreApplicability:
              (config.rules as { ignore_applicability?: boolean } | undefined)
                ?.ignore_applicability === true,
            utcYear: new Date().getUTCFullYear(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        );
        if ("hash" in ctxHash) ruleCache = bindRuleCache(ruleCacheOpts.store, ctxHash.hash);
        else ruleCacheDisabled = ctxHash.disabled;
      }
    }

    const collectedPages: CollectedPageSignal[] = [];
    const signalCollector: PageSignalCollector = {
      id: "site-dom-signals",
      collect(page, parsed, shared) {
        const signal = detachFromPage(
          // `shared.fingerprint` is the one the loop already built for
          // page_features' cluster key (#1949) — reusing it keeps this pass at
          // one DOM walk per page. detachFromPage clones it, so the signal this
          // array retains does not hold the loop's copy or its page.
          buildCollectedPageSignal({
            url: page.normalizedUrl,
            finalUrl: page.finalUrl,
            parsed,
            fingerprint: shared.fingerprint,
            htmlBytes: page.sizeBytes,
            // links/broken-anchors: an unrendered client shell's ids are unconfirmed.
            rendered: isRenderedFetch(page.fetcherId),
            // The extractors are rules' per-page work, so they share the rules'
            // budget, including a `[rules] time_budget_ms` override (#578).
            budgetMs: runner.ruleTimeBudgetMs,
          }),
          "collected-signal",
        );
        collectedPages.push(signal);
        // The value the rule cache stores for this page. It is already detached
        // and holds no DOM, so it is exactly what a replay needs (#1990). An
        // extractor that ran past its time budget left a hole, which must not be
        // replayed: `undefined` keeps the page out of the cache.
        return signal.timedOut ? undefined : signal;
      },
      // A replayed page contributes at the same point in the stream, so
      // `collectedPages` stays in crawl order whether a page ran or replayed —
      // which matters because the site rules aggregate over that order.
      replay(_page, snapshot) {
        collectedPages.push(snapshot as CollectedPageSignal);
      },
    };
    const endpointCollector = createEndpointCollector({
      headersOf: buildTechHeadersMap,
      entryUrl: siteDataForPageRules.baseUrl,
    });
    const streamed = yield* phase("page-rules", () =>
      streamPageRules(storage, crawlId, runner, siteDataForPageRules, {
      batchSize,
      soft404Confirmations: soft404Map,
      collectors: [signalCollector, endpointCollector],
      hooks: opts?.hooks,
      signal: opts?.signal,
      // v1's page-rule universe verbatim (its `pageDataMap` keys), so the streamed
      // pass can't drift from it — notably it excludes rate-limited pages, which
      // `isAuditablePage` alone does not (#1829).
      pageUniverse: new Set(pageDataMap.keys()),
      totalPages: pageDataMap.size,
      pageLoopHooks: opts?.pageLoopHooks,
      templateFanout: opts?.templateFanout,
      ruleCache,
      pageSink: opts?.pageSink,
      retainPageResults: opts?.retainPageResults,
      }),
    );
    const collectedSignals: CollectedSiteSignals = { pages: collectedPages };

    // Bounded, read-only aggregate view over the crawl (#1022): the site pass's
    // Bucket-C/D dual-path rules read its rollups (incoming-link counts, duplicate
    // groups, page_features) instead of scanning `site.pages`, so scoring a large
    // site never holds every page's scalars resident. page_features were populated
    // fresh during the stream (streamPageRules → upsertPageFeatures). orDie: a read
    // failure is a hard error, not a silent empty view (matches the streaming reads).
    // `universe` = v1's assembled site.pages order (parsedPages) so the incoming-link
    // graph's membership/order/sources match v1 exactly (E-E2 (b) reconciliation).
    const siteQuery = yield* phase("site-query", () =>
      createSiteQuery(storage, crawlId, {
        universe: parsedPages.map((p) => p.url),
        pageScanBatchSize: batchSize,
      }).pipe(Effect.orDie),
    );

    // Step 5: site pass over the DOM-free scalar universe (no re-materialization).
    const sitePass = yield* phase("site-rules", () =>
      runSitePass(
        runner,
        siteDataForPageRules,
        assets,
        wafBlockedPages,
        rateLimitedPages,
        collectedSignals,
        siteQuery,
        endpointCollector.finish(siteDataForPageRules),
      ),
    );

    // Step 6: assemble. Page rules were already merged + folded by streamPageRules;
    // merge + fold the site rules on top so ruleResultsMap and tallies stay in
    // lockstep — calculateHealthScoreFromTallies(tallies) === calculateHealthScore(ruleResultsMap).
    //
    // Reported as a phase like the rest: this is where the report's parsed-page
    // cache is built, which is one of the structures that still scales with page
    // count, so it is exactly the step whose cost we want visible when deciding
    // whether to bound it. It was the one declared phase the pass never emitted.
    const { ruleResultsMap, tallies, parsedPagesCache } = yield* phase("assemble", () =>
      Effect.sync(() => {
        const map = streamed.ruleResultsMap;
        const folded = streamed.tallies;
        for (const [ruleId, rr] of sitePass.siteRuleRunResults) {
          mergeRuleRunResult(map, ruleId, rr);
          foldRuleResultIntoTallies(folded, ruleId, rr);
        }

        // Parsed-page cache for the report tail — same universe (auditable pages)
        // v1 returns, with DOMs already dropped (report reads only extracted
        // fields). Skipped in the bounded mode (#2343): its only readers are
        // buildV1Report/buildV2Report's summary pass, and a caller that opted out
        // of the retained maps is not on that path — the CLI rebuilds its report
        // from SQLite. The pages themselves are held by `parsedPages` either way
        // (this Map is a second index over the same objects), so what this saves
        // is the index, and what it buys is a single owner for the universe.
        const cache = new Map<string, ParsedPage>();
        if (retainPageResults) {
          for (const [url, { parsed }] of pageDataMap) cache.set(url, parsed);
        }
        return { ruleResultsMap: map, tallies: folded, parsedPagesCache: cache };
      }),
    );

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
      ruleCache: ruleCacheDisabled
        ? { ...streamed.ruleCache, disabledReason: ruleCacheDisabled }
        : streamed.ruleCache,
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
  unfetchedFrontierCount,
  V1_REPORT_PAGE_BATCH,
  type AuditSummary,
  type BuildV1ReportOptions,
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
  options?: BuildV1ReportOptions,
): Effect.Effect<FullAuditReport, never, never> {
  return buildV1Report(storage, crawlId, ruleResults, options);
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
 * How long the external link check may take (repo#2613). Absent fields mean no
 * limit, which is what every caller had before.
 */
export interface ExternalLinkCheckLimits {
  /**
   * The check's wall-clock budget, from when the links are sent. The links it
   * has not reached by then are not requested; they are counted in the stats
   * as `outOfTime` and reported as not checked, never as broken. Zero or less,
   * or not a number: no budget.
   */
  budgetMs?: number;
  /**
   * The longest one bulk call or one local check is waited on: a backstop for
   * a request whose own timeout does not hold, so set it above both.
   */
  maxWaitMs?: number;
}

/**
 * Check all external links from site context
 * Results are stored in the crawl storage for use by rules
 *
 * @param siteContext - Pre-parsed site context (eliminates redundant parsing)
 * @param linkCache - Optional injectable link cache (CLI provides SQLite-backed; cloud passes null)
 * @param bulkChecker - Optional cloud bulk checker (paid dead_links service), tried first per url
 */
interface ExternalLinkOccurrence {
  pageUrl: string;
  text: string;
  position: LinkPosition;
  isNofollow: boolean;
}

/** Per-href external-link appearances, accumulated across page batches. */
export type ExternalLinkOccurrences = Map<string, ExternalLinkOccurrence[]>;

/**
 * Collect one batch's external-link appearances into `target`. MUST be called
 * with the batch's DOMs live: link POSITION (nav/header/footer/body) is not in
 * stored parsedData, so this is the one pre-rules step that genuinely needs a
 * parsed document per page. Split out of {@link checkExternalLinksOnStorage}
 * (#1860) so the cloud can accumulate over batches instead of holding every
 * page's DOM resident to make one pass.
 *
 * The appearances are DETACHED before they land in `target`, for the same
 * reason the page-rule findings are (#1860). `href` and `text` are read off the
 * batch's live DOM, so both are slices of that page's html, and JSC keeps a
 * slice attached to the buffer it came from. `target` outlives every batch, so
 * one retained anchor text holds its whole page as UTF-16 until the walk ends —
 * including the map KEY, which pins a page just as effectively as a value.
 *
 * Measured by scripts/prerules-retention.ts over real 959 KB pages with
 * per-page-distinct external links, batch 50, against a control that absorbs
 * nothing. String backing store held above the control:
 *
 *          50 pages   100 pages   150 pages
 *   before    0 MB       94 MB      187 MB
 *   after     3 MB        0 MB       -1 MB
 *
 * 1.87 MB per page, which is one 959 KB page as UTF-16 — every page walked,
 * pinned whole, for ~200 KB of actual link data. It reads as zero at 50 pages
 * because that is one batch: the retention only shows once a pinned page is one
 * the walk has already moved past.
 */
export function absorbExternalLinkOccurrences(
  target: ExternalLinkOccurrences,
  siteContext: SiteContextPage[],
): void {
  // Collected for THIS call first so the whole batch is detached in ONE
  // structuredClone. Cloning per link would be the same detach at many times
  // the per-call cost, and a link-heavy crawl absorbs tens of thousands.
  const fresh: Array<{ href: string; occurrence: ExternalLinkOccurrence }> = [];

  for (const { page, parsed } of siteContext) {
    if (!parsed || !parsed.document) continue; // Skip non-HTML or failed parses

    // Extract links from pre-parsed document (no additional parsing)
    // We need position info which isn't stored in parsedData
    const links = extractLinks(parsed.document, page.finalUrl);

    for (const link of links) {
      if (!link.isInternal && link.href) {
        fresh.push({
          href: link.href,
          occurrence: {
            pageUrl: page.normalizedUrl,
            text: link.text,
            position: link.position,
            isNofollow: link.isNofollow,
          },
        });
      }
    }
  }

  // Merged in absorption order, so `target` ends up with exactly the entries and
  // per-href order the attached version produced. String map keys compare by
  // value, so a detached href still finds an entry an earlier batch stored.
  for (const { href, occurrence } of detachFromPage(fresh, "external-links")) {
    const occurrences = target.get(href) ?? [];
    occurrences.push(occurrence);
    target.set(href, occurrences);
  }
}

// repo#2729: the internal link probe's action filter lives with the probe.
export { looksLikeAnAction } from "./link-target-probe";

/**
 * Normalized targets of the page's rel=nofollow links whose text is an action
 * ("Log out", "Delete"), read from the DOM: the stored link scalars the
 * collector reads carry no rel.
 */
function nofollowActionTargets(page: {
  url: string;
  finalUrl?: string;
  parsed: ParsedPage;
}): Set<string> {
  const out = new Set<string>();
  const doc = page.parsed.document;
  if (!doc) return out;
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const rel = (anchor.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("nofollow")) continue;
    if (!linkTextLooksLikeAnAction(anchor.textContent ?? "", true)) continue;
    try {
      out.add(normalizeUrl(new URL(anchor.getAttribute("href") ?? "", page.finalUrl ?? page.url).href));
    } catch {
      // An href that does not resolve is not a link the probe could request.
    }
  }
  return out;
}

/**
 * The egress policy for the end-of-crawl probes (#2831), the same as the asset
 * phase's own-site pool (#2764): private networks allowed (a LAN audit),
 * link-local and metadata addresses refused, the hosts the crawl itself
 * requests sent as the crawl sends them, every other hop vetted.
 */
export function probeEgress(
  baseUrl: string,
  config: Config,
  egressPinnedByTransport?: boolean,
  pinOwnHosts?: boolean,
  ownSiteOnly?: boolean,
): EgressPolicy {
  const policy: EgressPolicy = {
    allowPrivateNetwork: true,
    resolve: memoizeResolveHost(resolveHostAddresses),
    pin: egressPinnedByTransport !== true,
    // #819: an offline audit's probes reach the audited site and nothing else,
    // on the first hop and on every redirect after it.
    ...(ownSiteOnly === true
      ? { allowHost: ownSiteHostMatcher({ baseUrl, domains: config.project?.domains }) }
      : {}),
  };
  // repo#3430: with the own hosts pinned, they are vetted like the rest.
  if (ownHostsPinned({ pinOwnHosts, egressPinnedByTransport })) return policy;
  return {
    ...policy,
    trustTarget: (url) => {
      if (!baseUrl) return false;
      try {
        return isInScope(url.href, {
          baseUrl,
          include: [],
          exclude: [],
          allowedDomains: config.project?.domains ?? [],
        }).allowed;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The egress policy for an audit's external links (#767): public addresses
 * only, private ones too when the audited site is itself on a private
 * network, never link-local or cloud metadata; each hop pinned to the vetted
 * address unless the transport pins.
 */
function externalLinkEgress(baseUrl: string, egressPinnedByTransport?: boolean): EgressPolicy {
  const siteHost = getHostname(baseUrl).replace(/^\[|\]$/g, "");
  return {
    allowPrivateNetwork: siteHost !== "" && isNonPublicHostname(siteHost),
    resolve: memoizeResolveHost(resolveHostAddresses),
    pin: egressPinnedByTransport !== true,
  };
}

/** Not-requested external links kept as a sample in the crawl stats, and source pages per link. */
const NOT_REQUESTED_SAMPLE_LINKS = 50;
const NOT_REQUESTED_SAMPLE_PAGES = 10;

/**
 * An external link the checker never requests (repo#2759): its URL looks like
 * an action or carries a token, or some page's link text is plainly an action
 * ("Log out", "Unsubscribe", "Delete account"). rel=nofollow does not widen it
 * here as it does for internal links: on an external link it marks a paid or
 * untrusted link ("Buy on Amazon", "Follow us"), not an action.
 */
export function isNotRequestedExternalLink(href: string, linkTexts: Iterable<string>): boolean {
  if (looksLikeAnAction(href)) return true;
  for (const text of linkTexts) if (linkTextLooksLikeAnAction(text, false)) return true;
  return false;
}

/**
 * Split the external links into those the checker may request and those it
 * never requests ({@link isNotRequestedExternalLink}). The second come back as
 * a count and a sample, most-linked first, then by URL, each with its first
 * source pages, how many pages link it, and its URL with token-like values
 * masked (`maskLinkTokens`, a best effort) for a report that may be published.
 */
export function splitNotRequestedExternalLinks(occurrences: ExternalLinkOccurrences): {
  requestable: ExternalLinkOccurrences;
  notRequested: {
    count: number;
    sample: Array<{ href: string; sourcePages: string[]; pageCount: number }>;
  };
} {
  const requestable: ExternalLinkOccurrences = new Map();
  const skipped: Array<{ href: string; pages: string[] }> = [];
  for (const [href, occs] of occurrences) {
    if (!isNotRequestedExternalLink(href, occs.map((o) => o.text))) {
      requestable.set(href, occs);
      continue;
    }
    skipped.push({ href, pages: [...new Set(occs.map((o) => o.pageUrl))] });
  }
  return {
    requestable,
    notRequested: { count: skipped.length, sample: sampleLinkPages(skipped) },
  };
}

/** {@link sampleLinkPages} over collected occurrences. */
function sampleExternalLinks(
  occurrences: ExternalLinkOccurrences,
): Array<{ href: string; sourcePages: string[]; pageCount: number }> {
  return sampleLinkPages(
    [...occurrences].map(([href, occs]) => ({ href, pages: [...new Set(occs.map((o) => o.pageUrl))] })),
  );
}

/**
 * The report sample of links the checker did not request: most-linked first,
 * then by URL, each URL masked (`maskLinkTokens`), and links that mask the
 * same (`?u=1`, `?u=2`) merged into one entry with their pages combined, since
 * a report keys items by id and would drop one.
 */
function sampleLinkPages(
  links: Array<{ href: string; pages: string[] }>,
): Array<{ href: string; sourcePages: string[]; pageCount: number }> {
  const byMasked = new Map<string, Set<string>>();
  for (const { href, pages } of links) {
    const masked = maskLinkTokens(href);
    const merged = byMasked.get(masked) ?? new Set<string>();
    for (const page of pages) merged.add(page);
    byMasked.set(masked, merged);
  }
  const entries = [...byMasked].map(([href, pages]) => ({ href, pages: [...pages] }));
  entries.sort(
    (a, b) => b.pages.length - a.pages.length || (a.href < b.href ? -1 : a.href > b.href ? 1 : 0),
  );
  return entries.slice(0, NOT_REQUESTED_SAMPLE_LINKS).map(({ href, pages }) => ({
    href,
    sourcePages: pages.slice(0, NOT_REQUESTED_SAMPLE_PAGES),
    pageCount: pages.length,
  }));
}

/**
 * The external links an audit checks under a `max_links` limit (repo#2729):
 * all of them when there is no limit or they fit. Otherwise `priority` first
 * (links the caller must see again, such as the ones an open finding names, so
 * a capped run can still tell it fixed), then the ones on the most pages, ties
 * broken by URL so the same crawl always checks the same set.
 */
export function selectExternalLinksToCheck(
  occurrences: ExternalLinkOccurrences,
  maxLinks: number | undefined,
  priority: readonly string[] = [],
): string[] {
  const hrefs = Array.from(occurrences.keys());
  if (maxLinks === undefined || hrefs.length <= maxLinks) return hrefs;
  const first = new Set(priority.filter((href) => occurrences.has(href)));
  const pagesOf = (href: string): number =>
    new Set((occurrences.get(href) ?? []).map((o) => o.pageUrl)).size;
  const ranked = hrefs
    .filter((href) => !first.has(href))
    .map((href) => ({ href, pages: pagesOf(href) }))
    .sort((a, b) => b.pages - a.pages || (a.href < b.href ? -1 : a.href > b.href ? 1 : 0));
  return [...first, ...ranked.map((r) => r.href)].slice(0, Math.max(0, maxLinks));
}

export function checkExternalLinksOnStorage(
  storage: CrawlStorage,
  crawlId: string,
  siteContext: SiteContextPage[],
  config: ExternalLinksConfig,
  onProgress?: (progress: ExternalLinkCheckProgress) => void,
  linkCache?: LinkCache | null,
  bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>,
): Effect.Effect<ExternalCheckResult[], never, never> {
  if (!config.enabled) return Effect.succeed([]);
  const externalLinkOccurrences: ExternalLinkOccurrences = new Map();
  absorbExternalLinkOccurrences(externalLinkOccurrences, siteContext);
  return checkCollectedExternalLinks(
    storage,
    crawlId,
    externalLinkOccurrences,
    config,
    onProgress,
    linkCache,
    bulkChecker,
  );
}

/**
 * The external-link phase's network + persistence tail, over occurrences already
 * collected by {@link absorbExternalLinkOccurrences}. Same body
 * {@link checkExternalLinksOnStorage} always ran; split so both the resident and
 * the streamed collection paths land here (#1860).
 */
export function checkCollectedExternalLinks(
  storage: CrawlStorage,
  crawlId: string,
  externalLinkOccurrences: ExternalLinkOccurrences,
  config: ExternalLinksConfig,
  onProgress?: (progress: ExternalLinkCheckProgress) => void,
  linkCache?: LinkCache | null,
  bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>,
  priorityHrefs?: readonly string[],
  /** The transport resolves once and connects to what it validated (the hosted container). */
  egressPinnedByTransport?: boolean,
  limits?: ExternalLinkCheckLimits,
): Effect.Effect<ExternalCheckResult[], never, never> {
  return Effect.gen(function* () {
    if (!config.enabled) {
      return [];
    }

    if (externalLinkOccurrences.size === 0) {
      return [];
    }

    // An external link is the page's to name, so every local request and every
    // redirect hop it leads to is held to the third-party probes' policy:
    // public addresses only (private ones too when the audited site is itself
    // on a private network), never link-local or cloud metadata, and connected
    // to the address that was vetted. No custom headers ever go with it.
    const crawl = yield* storage.getCrawl(crawlId).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const egress = externalLinkEgress(crawl?.baseUrl ?? "", egressPinnedByTransport);

    // Check external links using injected cache (or null for no caching)
    const cache = linkCache ?? null;
    const ttlSeconds = config.cache_ttl_days * 24 * 60 * 60;

    // repo#2759: a link that looks like an action or carries a token (a
    // third-party unsubscribe or magic link, a signed download URL) is never
    // requested, locally or by the cloud's bulk checker: the URL itself can be
    // the credential. Same rules as the internal link probe, URL and link text
    // alike. Counted, sampled, and reported by links/broken-external-links.
    const { requestable: requestableOrRefused, notRequested } =
      splitNotRequestedExternalLinks(externalLinkOccurrences);
    // pub#770: an address the policy refuses on the URL alone (a private,
    // link-local or metadata IP literal, `localhost`, a metadata name) is
    // never requested either, so it takes no slot under `max_links` and is
    // never stored as a row. Listed with the refusals the check itself makes.
    const requestable: ExternalLinkOccurrences = new Map();
    const refusedByUrl: string[] = [];
    for (const [href, occs] of requestableOrRefused) {
      if (refusedWithoutLookup(href, egress)) refusedByUrl.push(href);
      else requestable.set(href, occs);
    }
    const notRequestedHrefs = [...externalLinkOccurrences.keys()].filter((href) => !requestable.has(href));

    // repo#2729: a site can link out to tens of thousands of URLs, and in the
    // cloud each link is a credit, so an audit checks at most `max_links` of
    // them: the most-linked first (nav and footer links every page shares),
    // then by URL so the choice is stable. The rest are counted and reported as
    // not checked.
    const hrefs = selectExternalLinksToCheck(requestable, config.max_links, priorityHrefs);
    const externalLinkCheck = {
      found: externalLinkOccurrences.size,
      checked: hrefs.length,
      cap: config.max_links ?? requestable.size,
      ...(notRequested.count > 0
        ? { notRequested: notRequested.count, notRequestedLinks: notRequested.sample }
        : {}),
      ...(refusedByUrl.length > 0 ? { refusedByUrl: refusedByUrl.length } : {}),
    };
    yield* storage
      .updateStats(crawlId, { externalLinkCheck })
      .pipe(
        // Without the stat the over-limit "Not checked" line cannot be shown,
        // so say so rather than read as a complete check.
        Effect.catchAll((error) =>
          Effect.sync(() =>
            logger.warn("could not record external link check coverage", { error: String(error) }),
          ),
        ),
      );

    const results = yield* checkExternalLinks(hrefs, cache, {
      ttlSeconds,
      concurrency: config.concurrency,
      timeoutMs: config.timeout_ms,
      userAgent: SQUIRRELSCAN_USER_AGENT,
      bulkChecker,
      egress,
      // repo#2613: a long check reports as it goes, and stops at its budget. A
      // budget of zero or less, or not a number, is no budget, as elsewhere.
      ...(limits?.budgetMs !== undefined && Number.isFinite(limits.budgetMs) && limits.budgetMs > 0
        ? { deadlineAt: Date.now() + limits.budgetMs }
        : {}),
      ...(limits?.maxWaitMs !== undefined ? { maxWaitMs: limits.maxWaitMs } : {}),
      onProgress: (progress) =>
        onProgress?.({ checked: progress.done, total: hrefs.length, fromCache: progress.fromCache }),
    });

    // repo#2613: the links the budget ran out on were never answered. They are
    // left out of the results (so out of the stored rows), counted here, and
    // reported as not checked, never as broken or as passing.
    const outOfTime = hrefs.length - results.length;

    // pub#770: the links the egress policy refused (a private, link-local or
    // metadata address on a public site's page) were never requested. Counted
    // and sampled like the not-requested ones, so the report can say so
    // rather than leave them out of every line.
    const refusedHrefs = [...refusedByUrl, ...results.filter((r) => r.refused).map((r) => r.href)];
    if (refusedHrefs.length > 0 || outOfTime > 0) {
      const refusedOccurrences: ExternalLinkOccurrences = new Map(
        refusedHrefs.map((href) => [href, externalLinkOccurrences.get(href) ?? []]),
      );
      yield* storage
        .updateStats(crawlId, {
          externalLinkCheck: {
            ...externalLinkCheck,
            ...(refusedHrefs.length > 0
              ? { refused: refusedHrefs.length, refusedLinks: sampleExternalLinks(refusedOccurrences) }
              : {}),
            ...(outOfTime > 0 ? { outOfTime } : {}),
          },
        })
        .pipe(
          Effect.catchAll((error) =>
            Effect.sync(() =>
              logger.warn("could not record refused or unreached external links", {
                error: String(error),
              }),
            ),
          ),
        );
    }

    // Store results in per-crawl storage
    // Collect all appearances for batch insert
    const allAppearances: LinkAppearanceRecord[] = [];

    for (const result of results) {
      // Never requested: no row, so no line reads it as checked (pub#770).
      // Its appearances are still written, like the not-requested links'.
      if (!result.refused) {
        yield* storage
          .upsertLink(crawlId, {
            href: result.href,
            isInternal: false,
            status: result.status ?? undefined,
            error: result.error ?? undefined,
            checkedAt: Date.now(),
            wafBlocked: result.wafBlocked,
            wafProvider: result.wafProvider,
            // pub#821: why it is unverifiable, for the item label.
            unverifiedReason: result.unverifiedReason,
            // #1829: persisted, not re-derived — the 503 + Retry-After case
            // cannot be recovered from the status code the rules read.
            rateLimited: result.rateLimited,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }

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

    // repo#2759: the links never requested get their appearances too, though
    // no row. An incremental crawl copies a reused page's link rows, earlier
    // verdicts included, but not its appearances; with these the rule-data
    // builders can tell such a row is a link this run never requested by its
    // link text, not only by its URL, and leave it out.
    for (const href of notRequestedHrefs) {
      for (const occ of externalLinkOccurrences.get(href) ?? []) {
        allAppearances.push({
          href,
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
        .pipe(
          Effect.catchAll((error) =>
            Effect.sync(() =>
              logger.warn("could not record external link appearances", { error: String(error) }),
            ),
          ),
        );
    }

    // Report progress
    const fromCache = results.filter((r) => r.fromCache).length;
    onProgress?.({
      checked: results.length,
      total: hrefs.length,
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
  /** See {@link SiteAssetOccurrences.imagesSelected}. */
  imagesSelected?: Map<string, Set<string>>;
  /** See {@link SiteAssetOccurrences.imagesEager}. */
  imagesEager?: Map<string, Set<string>>;
  scripts: Map<string, Set<string>>;
  preloads: Map<string, Set<string>>;
  fonts: Map<string, Set<string>>;
  externalCss: Map<string, Set<string>>;
  externalScripts: Map<string, Set<string>>;
  externalFonts: Map<string, Set<string>>;
}

/** A `<meta http-equiv="Content-Security-Policy">` is an enforced policy too. */
function hasMetaCsp(doc: Document | null): boolean {
  if (!doc) return false;
  for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
    if (meta.getAttribute("http-equiv")?.trim().toLowerCase() === "content-security-policy") return true;
  }
  return false;
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
  const target: ResourceOccurrenceMap = {
    css: new Map<string, Set<string>>(),
    images: new Map<string, Set<string>>(),
    imagesSelected: new Map<string, Set<string>>(),
    imagesEager: new Map<string, Set<string>>(),
    scripts: new Map<string, Set<string>>(),
    preloads: new Map<string, Set<string>>(),
    fonts: new Map<string, Set<string>>(),
    externalCss: new Map<string, Set<string>>(),
    externalScripts: new Map<string, Set<string>>(),
    externalFonts: new Map<string, Set<string>>(),
  };
  absorbResourceOccurrences(target, pages, baseUrl);
  return target;
}

/** {@link collectResourceOccurrences}' body, accumulating into `target` so the
 * streamed pre-rules pass can feed it one page batch at a time (DOMs live) and
 * the whole-array entry point stays a one-shot call into the same code. */
export function absorbResourceOccurrences(
  target: ResourceOccurrenceMap,
  pages: Array<{
    url: string;
    finalUrl?: string;
    parsed: ParsedPage;
    /** The page enforces a CSP (header or meta); only then are its preloads wanted. */
    hasCsp?: boolean;
  }>,
  baseUrl: string,
  /**
   * More hosts that are the site's own beyond the base host and its subdomains
   * (an offline audit's `www` or apex twin and `[project] domains`, #819): a
   * reference on one is read as the site's own, not as a third party's.
   */
  isOwnHost?: (hostname: string) => boolean,
): void {
  const baseHost = getHostname(baseUrl).toLowerCase();
  const ownResource = (url: string): boolean =>
    isSameDomainResource(url, baseHost) || (isOwnHost?.(getHostname(url)) ?? false);
  const ownScript = (url: string): boolean =>
    isSameDomainScript(url, baseHost) || (isOwnHost?.(getHostname(url)) ?? false);
  const { css, images, scripts, preloads, fonts, externalCss, externalScripts, externalFonts } =
    target;

  for (const page of pages) {
    const pageUrl = page.finalUrl ?? page.url;
    const doc = page.parsed.document;
    if (!doc) continue;

    const stylesheetRefs = extractStylesheets(doc, pageUrl);
    for (const sheet of stylesheetRefs) {
      if (!sheet.href || sheet.href.startsWith("data:")) continue;
      const sheets = ownResource(sheet.href) ? css : externalCss;
      const sources = sheets.get(sheet.href) ?? new Set<string>();
      sources.add(page.url);
      sheets.set(sheet.href, sources);
    }

    // Which file each image loads, and whether it loads at page load (#1251, #1252).
    // Every referenced file is still measured (responsive-size pairs an <img> with
    // its `src`), but the two maps below say which of them visitors download.
    const imagesSelected = (target.imagesSelected ??= new Map<string, Set<string>>());
    const imagesEager = (target.imagesEager ??= new Map<string, Set<string>>());
    const inViewport = initialViewportFlags(page.parsed.images);
    const note = (map: Map<string, Set<string>>, url: string): void => {
      const sources = map.get(url) ?? new Set<string>();
      sources.add(page.url);
      map.set(url, sources);
    };
    const resolveOwn = (raw: string): string | null => {
      if (!raw || raw.startsWith("data:")) return null;
      let resolved = raw;
      try {
        resolved = new URL(raw, pageUrl).toString();
      } catch {
        // Ignore invalid URLs
      }
      return ownResource(resolved) ? resolved : null;
    };
    page.parsed.images.forEach((image, index) => {
      const src = resolveOwn(image.src);
      if (src) note(images, src);
      // A <picture> may pick its file from a <source> this model cannot read, so
      // its <img> keeps its src as the loaded file, as before.
      const chosen =
        image.srcset && !image.inPicture
          ? selectImageCandidate({ src: image.src, srcset: image.srcset, sizes: image.sizes })
          : image.src;
      // A selected candidate on another origin is not measured (only the site's own
      // files are), so the image falls back to its own-host src, which stays measured
      // and counted as it was before srcset selection.
      const selected = (chosen ? resolveOwn(chosen) : null) ?? src;
      if (!selected) return;
      note(images, selected);
      note(imagesSelected, selected);
      if (!(image.loading === "lazy" && !inViewport[index])) note(imagesEager, selected);
    });

    for (const fontUrl of extractFontUrls(doc, pageUrl)) {
      const fontMap = ownResource(fontUrl) ? fonts : externalFonts;
      const sources = fontMap.get(fontUrl) ?? new Set<string>();
      sources.add(page.url);
      fontMap.set(fontUrl, sources);
    }

    // Extract external script URLs
    const scriptRefs = extractScripts(doc, pageUrl);
    for (const script of scriptRefs) {
      if (!script.src || script.src.startsWith("data:")) continue;
      const scriptMap = ownScript(script.src) ? scripts : externalScripts;
      const sources = scriptMap.get(script.src) ?? new Set<string>();
      sources.add(page.url);
      scriptMap.set(script.src, sources);
    }

    // Preloaded chunks name the lazy third-party scripts a page loads. They go in
    // their own map so no script rule's input changes, and only pages that
    // enforce a CSP are read, since nothing else needs them.
    for (const src of page.hasCsp ? extractPreloadedScriptUrls(doc, pageUrl) : []) {
      if (!ownScript(src)) continue;
      const sources = preloads.get(src) ?? new Set<string>();
      sources.add(page.url);
      preloads.set(src, sources);
    }
  }
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
