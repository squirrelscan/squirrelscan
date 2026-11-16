// Audit Adapter - bridges the new crawler to the audit workflow
// Converts crawler storage data to the format expected by rules and reports
//
// Everything duplicated in @squirrelscan/audit-engine is re-exported from it.
// Deliberately CLI-only, and why: the logger injection (CLI logger), the
// legacy Page/SiteLink/SiteImage converters (pageRecordToPage,
// linkRecordToSiteLink, imageRecordToSiteImage: the engine has no legacy
// `@/infra/context` shapes), and the crawler event subscription.

import type { RenderedRequest } from "@squirrelscan/core-contracts";

import {
  fetchResourceAssets as fetchResourceAssetsCore,
  generateReportFromStorage as generateReportFromStorageCore,
  hasAuditableHtmlBody,
  parsePageRecord,
  resolveStreamBatch,
  runRulesOnStorage as runRulesOnStorageCore,
  runStreamingPreRules as runStreamingPreRulesCore,
  runStreamingRules as runStreamingRulesCore,
  setAdapterLogger,
  STREAM_BATCH_BYTES,
  type AdapterLogger,
  type ExternalCheckResult,
  type PageResultSink,
  type PreFetchedAssets,
  type ResourceCheckOverrides,
  type RuleCacheStats,
  type RuleCacheStore,
  type RuleTally,
  type SiteContextPage,
  type StreamingRulePhase,
} from "@squirrelscan/audit-engine";
import {
  detectPageType,
  extractContactLinks,
  extractContent,
  extractHeadings,
  extractImages,
  extractLinks,
  extractMeta,
  extractOG,
  extractTwitter,
  parseDocument,
  parseNotices,
  parseSchemas,
  runClassifier,
  schemaCollectionFromJSON,
  extractAuthorFromSchema,
  extractVisibleMeta,
  toLinkData,
  type ParsedPageCache,
  type ParsePageOptions,
} from "@squirrelscan/parser";
import { type RunnerScope } from "@squirrelscan/rules";
import { Effect, Stream } from "effect";

import type { Config } from "@/config";
import type { Crawler, CrawlerEvent } from "@/crawler/core/types";
import type {
  CrawlStorage,
  PageRecord,
  LinkRecord,
  ImageRecord,
  ImageAppearanceRecord,
} from "@/crawler/storage/types";
import type {
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
  SitemapUrlStatusData,
} from "@/types";

import { pinOwnHosts } from "@/crawl/pin-own-hosts";
import { logger } from "@/utils/logger";

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
 * DOM working-set controls (#858) — the engine implementations are the source
 * of truth; the fork's SiteContextPage is structurally identical, so re-export
 * for the controller. Release before long DOM-free waits (cloud prefetch),
 * re-materialize lazily at the rules phase.
 */
export {
  releaseSiteContextDocuments,
  ensureSiteContextDocuments,
} from "@squirrelscan/audit-engine";

// Batch sizing for the streamed passes (#1913) — same helper and same default
// byte budget the hosted runtime resolves its batch from.
export { resolveStreamBatch, STREAM_BATCH_BYTES };
export type { StreamPreRulesResult } from "@squirrelscan/audit-engine";

// Page parsing and site-context building live ONLY in the engine (repo#1415):
// one implementation, so the CLI cannot drift from the cloud again.
export {
  buildSiteContext,
  hasAuditableHtmlBody,
  isAuditableEmptyBodyStatus,
  parsePageRecord,
} from "@squirrelscan/audit-engine";
export type { SiteContextPage } from "@squirrelscan/audit-engine";

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
  const hasBody = hasAuditableHtmlBody(record);
  const raw: PageRaw | null = hasBody
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
  if (hasBody) {
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

// The asset phase lives once in @squirrelscan/audit-engine: the same fetchers,
// the same egress policy and the same internal link probe as `squirrel audit`.
// `squirrel analyze` used to run a fork of it whose script fetches followed
// redirects natively, so no hop was checked (#768), and which never ran the
// internal link probe (#799).
export type { PreFetchedAssets, ResourceCheckOverrides };

/**
 * Fetch all resource metadata and content the rules need, between the crawl
 * and the rules: HEAD for sizes, GET for scripts, the internal link probe.
 */
export const fetchResourceAssets = fetchResourceAssetsCore;

/**
 * Streamed twin of {@link runRulesOnStorage} — the live CLI rules path (#1913).
 *
 * Delegates to the same engine function the hosted runtime uses: DOM residency
 * is one page batch instead of one per crawled page, and the report it feeds is
 * byte-identical (the engine's canonical-vs-streaming golden and its 518-page
 * baseline gate that). Wired here rather than called directly so the CLI keeps
 * one seam onto the engine and its logger stays injected.
 */
export function runStreamingRules(
  storage: import("@/crawler/storage/sqlite").SQLiteStorage,
  crawlId: string,
  config: Config,
  assets: PreFetchedAssets,
  scope?: RunnerScope,
  opts?: {
    batchSize?: number;
    /** Requests rendered pages issued, for endpoint discovery (repo#4188). */
    renderedRequests?: ReadonlyMap<string, readonly RenderedRequest[]>;
    onPhase?: (phase: StreamingRulePhase, boundary: "start" | "end") => void;
    /** Per-page rule-result cache (#1990); omitted → every page runs. */
    ruleCache?: {
      store: RuleCacheStore;
      engineVersion: string;
      rulesVersion: string;
    };
    /** Where each page's checks go as they are produced (#2343). */
    pageSink?: PageResultSink;
    /** False → the O(pages × page bytes) result maps are never built (#2343). */
    retainPageResults?: boolean;
    /** Vet and pin the site's own hosts in the end-of-crawl probes (repo#3430). */
    pinOwnHosts?: boolean;
    /** Epoch ms after which no further page starts its rules (#1271). */
    deadlineAt?: number;
    /** HTML larger than this is neither parsed nor evaluated; counted in `pagesTooLarge` (#1332). */
    maxPageBytes?: number;
    /** Called once when an `[[ignore]]` entry exhausts its regex work budget. */
    onIgnoreTimeout?: (entry: number) => void;
  }
): Effect.Effect<
  RuleExecutionResult & {
    ruleCache: RuleCacheStats;
    /** Pages whose rules never ran because `deadlineAt` passed first (#1271). */
    pagesNotEvaluated: number;
    pagesTooLarge: number;
    tooLargePages: string[];
    /** `[[ignore]]` entries that ran over their regex work budget and stopped waiving (#1262). */
    ignoreTimedOut: number[];
    /** Folded per-rule tallies — bounded by the RULE count, not the page count. */
    tallies: Map<string, RuleTally>;
  },
  never,
  never
> {
  return runStreamingRulesCore(storage, crawlId, config, assets, scope, opts);
}

export type { StreamingRulePhase };

/**
 * Streamed pre-rules phase (#1913) — the batched walk that replaces
 * `buildSiteContext` + `checkExternalLinksOnStorage` +
 * {@link fetchResourceAssets} over a whole-crawl page array. Same delegating
 * seam as {@link runStreamingRules}.
 */
export const runStreamingPreRules = runStreamingPreRulesCore;

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
    scope,
    undefined,
    // repo#3430: the end-of-crawl probes vet and pin the site's own hosts.
    pinOwnHosts()
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

/**
 * Cloud bulk link checker (wired from the credit-gated /v1/services/dead-links
 * endpoint by the audit controller). The map is keyed by the exact requested
 * url; urls it omits fall back to per-link local checks. The engine's
 * `runBulkChecker` calls it in chunks, and stops after a chunk it answers
 * none of (pub#753).
 */
export type ExternalBulkChecker = (
  urls: string[]
) => Promise<Map<string, ExternalCheckResult>>;

// ============================================
// HELPERS
// ============================================

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}
