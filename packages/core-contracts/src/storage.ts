// Canonical storage types — crawl records, interfaces, and contracts
// All storage adapters (SQLite, D1, R2, filesystem) implement these interfaces.

import type { Effect } from "effect";

// ============================================
// SHARED DOMAIN TYPES (used by storage + report)
// ============================================

export interface RedirectHop {
  url: string;
  statusCode: number;
  type: "http" | "javascript" | "meta-refresh";
}

export interface RedirectChain {
  sourceUrl: string;
  finalUrl: string;
  hops: RedirectHop[];
  chainLength: number;
  isLoop: boolean;
  endsInError: boolean;
  httpsToHttp: boolean;
  httpToHttps: boolean;
}

export interface SecurityHeaders {
  hsts: string | null;
  csp: string | null;
  xFrameOptions: string | null;
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  permissionsPolicy: string | null;
  xRobotsTag: string | null;
}

// ============================================
// ERROR TYPES
// ============================================

export class StorageError extends Error {
  readonly _tag = "StorageError";
  readonly operation: string;
  readonly cause?: unknown;

  constructor(operation: string, cause?: unknown) {
    const causeText = cause instanceof Error ? cause.message : String(cause ?? "");
    const lower = causeText.toLowerCase();
    const isDbLocked =
      lower.includes("database is locked") ||
      lower.includes("database table is locked") ||
      lower.includes("sqlite_busy");

    const message = isDbLocked
      ? `Storage error during ${operation}: SQLite database is busy (locked). Another SquirrelScan crawl/report/analyze command may be running in parallel. Wait for it to finish and retry.`
      : `Storage error during ${operation}: ${cause}`;

    super(message);
    this.name = "StorageError";
    this.operation = operation;
    this.cause = cause;
  }

  static init(cause?: unknown): StorageError {
    return new StorageError("init", cause);
  }

  static close(cause?: unknown): StorageError {
    return new StorageError("close", cause);
  }

  static read(cause?: unknown): StorageError {
    return new StorageError("read", cause);
  }

  static write(cause?: unknown): StorageError {
    return new StorageError("write", cause);
  }
}

// ============================================
// CRAWL METADATA
// ============================================

// "stopped" = the crawl loop was hard-interrupted mid-frontier by the wall-clock
// backstop (stop()), NOT drained to completion (#969). Distinct from "completed"
// so a direct CrawlStorage consumer can't read a partial crawl as a full one; the
// pages collected before the interrupt are still analyzable/resumable.
export type CrawlStatus =
  | "running"
  | "paused"
  | "crawled"
  | "analyzed"
  | "completed"
  | "stopped"
  | "failed";

/**
 * Why a fetch was avoided (cache hit). Spans pages AND sub-resources (#107).
 * - `max-age`/`s-maxage`/`expires`/`immutable`: origin freshness honored — NO
 *   request was made at all (the cheapest, full bandwidth saving).
 * - `304`: a conditional GET was made and the server answered Not Modified
 *   (request spent, body bytes saved).
 * - `hash_match`: a full fetch happened but the content hash matched the prior
 *   crawl (request + body spent, but no re-parse/re-analysis).
 * - `stale-while-revalidate`: stale copy served now, no request this run.
 */
export type CacheHitReason =
  | "max-age"
  | "s-maxage"
  | "expires"
  | "immutable"
  | "304"
  | "hash_match"
  | "stale-while-revalidate";

/** Per-reason hit counts. Optional keys keep persisted blobs forward-compatible. */
export type CacheHitsByReason = Partial<Record<CacheHitReason, number>>;

export interface CrawlStats {
  pagesTotal: number;
  pagesFetched: number;
  pagesFailed: number;
  /**
   * Fetch failures where the server actively refused the crawler (403 →
   * CrawlError `blocked`, 429 → `rate_limit`) — a subset of `pagesFailed`.
   * These fail the fetch BEFORE any page record is stored, so a walled ROOT
   * page leaves 0 stored pages; this count lets status derivation classify the
   * run as `blocked` rather than a generic empty crawl (#792). Optional for
   * backward compatibility with older persisted stats blobs.
   */
  pagesBlocked?: number;
  pagesSkipped: number;
  pagesUnchanged: number;
  /**
   * Pages served from cache with NO network request at all (origin freshness
   * honored — max-age/Expires/immutable). Subset of pagesUnchanged. Optional
   * for backward compatibility with older persisted stats. (#106)
   */
  pagesCacheFresh?: number;
  /** Approximate bytes saved by skipping fresh requests entirely. (#106) */
  bytesCacheSaved?: number;
  /**
   * Per-reason cache-hit counts across pages AND sub-resources (#107/#108).
   * Drives the hits-by-reason breakdown. Optional for backward compatibility.
   */
  cacheHitsByReason?: CacheHitsByReason;
  /**
   * Sub-resources (CSS/JS/img/fonts) reused from cache without a full transfer
   * this run (origin-fresh or 304). Subset of resources checked. (#107)
   */
  resourceCacheFresh?: number;
  /** Approximate sub-resource bytes saved by cache reuse this run. (#107) */
  resourceBytesCacheSaved?: number;
  linksTotal: number;
  imagesTotal: number;
  bytesTotal: number;
  avgLoadTimeMs: number;
}

/**
 * Aggregate cache stats for a whole audit, derived from {@link CrawlStats} +
 * sub-resource cache results. Persisted on the report and surfaced in the
 * dashboard panel + CLI/HTML report line (#108). Spans pages and sub-resources.
 */
export interface CacheStats {
  /** Total cacheable items considered (pages + sub-resources). */
  total: number;
  /** Items served from cache without a full transfer (any reason). */
  hits: number;
  /** hits / total, 0–1. (Computed; carried for convenience.) */
  hitRate: number;
  /** Approximate total bytes saved by cache reuse. */
  bytesSaved: number;
  /** Hit counts keyed by reason (304 vs max-age vs hash-match, …). */
  hitsByReason: CacheHitsByReason;
  /** Breakdown for the page vs sub-resource split. */
  pages: { total: number; hits: number; bytesSaved: number };
  resources: { total: number; hits: number; bytesSaved: number };
}

export interface CrawlMetadata {
  id: string;
  baseUrl: string;
  seedUrl?: string;
  originalUrl?: string;
  startedAt: number;
  completedAt?: number;
  status: CrawlStatus;
  config: CrawlerConfigSnapshot;
  stats: CrawlStats;
}

export interface CrawlerConfigSnapshot {
  maxPages: number;
  concurrency: number;
  perHostConcurrency: number;
  delayMs: number;
  perHostDelayMs: number;
  timeoutMs: number;
  userAgent: string;
  followRedirects: boolean;
  respectRobots: boolean;
  incremental: boolean;
  include: string[];
  exclude: string[];
  allowQueryParams: string[];
  dropQueryPrefixes: string[];
  allowedDomains: string[];
}

// ============================================
// PAGE RECORDS
// ============================================

export interface ResponseHeaders {
  contentType: string | null;
  contentEncoding: string | null;
  cacheControl: string | null;
  /**
   * Legacy Expires header — freshness fallback when Cache-Control has no
   * max-age. Optional for backward compatibility with records/literals that
   * predate browser-cache emulation.
   */
  expires?: string | null;
  vary: string | null;
  etag: string | null;
  server: string | null;
  lastModified: string | null;
  link: string | null;
  serverTiming: string | null;
  age: string | null;
  xCache: string | null;
  cfCacheStatus: string | null;
  xVercelCache: string | null;
  altSvc: string | null;
  acceptRanges: string | null;
  /**
   * Raw Set-Cookie header value(s), "\n"-joined when a page sets more than
   * one (via `Headers.getSetCookie()` — comma-joining is ambiguous with
   * commas embedded in a cookie's own Expires attribute, squirrelscan/repo#973).
   * See packages/rules/src/security/cookie-flags.ts's splitter. Optional for
   * backward compatibility with records that predate the security/cookie-flags
   * rule (#748).
   */
  setCookie?: string | null;
}

export interface PageRecord {
  url: string;
  normalizedUrl: string;
  finalUrl: string;
  depth: number;
  parentUrl?: string;
  redirectChain?: RedirectChain;

  status: number;
  contentType: string | null;
  sizeBytes: number;
  loadTimeMs: number;
  ttfb?: number;
  downloadTime?: number;
  fetchedAt: number;

  etag: string | null;
  lastModified: string | null;
  contentHash: string;

  html: string | null;
  parsedData: string | null;
  headers: ResponseHeaders;
  securityHeaders: SecurityHeaders;

  /**
   * Request headers sent when this entry was fetched, used for Vary-aware cache
   * keying (browser-cache emulation). Only the small, stable set we actually
   * vary on is stored. Optional for backward compatibility with older records.
   */
  requestHeaders?: Record<string, string> | null;

  /**
   * Which fetcher/egress served this page (e.g. "cloud-render", "fetch",
   * "browser") + why a fallback egress served it (e.g. "render-block") (#512).
   * Optional/backward-compatible: absent on records written before #512.
   */
  fetcherId?: string;
  fallbackReason?: string;

  /**
   * sha256 of the NORMALIZED raw source (Cloudflare challenge-platform injection
   * stripped) at the last render-path probe (#839). Lets a re-run reuse the
   * stored render when the origin rolls its Last-Modified but the real content is
   * unchanged. Absent on records written before #839 and on pages never probed.
   */
  sourceHash?: string | null;
}

// ============================================
// FRONTIER RECORDS
// ============================================

export type FrontierStatus = "pending" | "fetching" | "done" | "failed" | "skipped";

// "carried" = a page holding open carried findings, pre-seeded ahead of generic
// discovery so its findings get re-checked within budget (#1146).
export type FrontierSource = "seed" | "sitemap" | "discovered" | "carried";

export interface FrontierRecord {
  normalizedUrl: string;
  rawUrl: string;
  depth: number;
  parentUrl?: string;
  priority: number;
  status: FrontierStatus;
  source: FrontierSource;
  enqueuedAt: number;
  fetchedAt?: number;
  retryCount: number;
  reason?: string;
}

// ============================================
// LINK RECORDS
// ============================================

export type LinkPosition = "header" | "footer" | "nav" | "content" | "sidebar" | "unknown";

export interface LinkRecord {
  href: string;
  isInternal: boolean;
  status?: number;
  error?: string;
  checkedAt?: number;
  wafBlocked?: boolean;
  wafProvider?: string;
}

export interface LinkAppearanceRecord {
  href: string;
  pageUrl: string;
  anchorText: string;
  position: LinkPosition;
  rel?: string[];
  isNofollow: boolean;
}

// ============================================
// IMAGE RECORDS
// ============================================

export interface ImageRecord {
  src: string;
  status?: number;
  error?: string;
  checkedAt?: number;
  contentType?: string;
  size?: number;
}

export interface ImageAppearanceRecord {
  src: string;
  pageUrl: string;
  alt?: string;
  width?: string;
  height?: string;
  isLazyLoaded: boolean;
  inFigure: boolean;
}

export interface ResourceSizeRecord {
  type: "css" | "image";
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sourcePages: string[];
  /**
   * Compression + caching metadata captured per sub-resource (#107). All
   * optional for backward compatibility with records written before #107.
   */
  /** content-encoding (gzip/br/deflate/zstd) or null for identity/none. */
  contentEncoding?: string | null;
  /** Bytes actually transferred over the wire (compressed body). */
  transferBytes?: number | null;
  /** Cache-Control header verbatim (drives freshness + the bad-caching rule). */
  cacheControl?: string | null;
  /** ETag validator, if present. */
  etag?: string | null;
  /** Last-Modified validator, if present. */
  lastModified?: string | null;
  /**
   * Vary header verbatim. When present (non-empty / not just trivial), the
   * sub-resource is NOT reused from cache — the resource checker sends a fixed,
   * minimal request context and cannot reason about variant matching, so it
   * conservatively re-fetches rather than risk serving the wrong variant. (#107)
   */
  vary?: string | null;
  /**
   * Cache-hit reason if this resource was reused from a prior crawl without a
   * full transfer this run; null/absent on a real (miss) fetch. (#107)
   */
  cacheReason?: CacheHitReason | null;
}

export interface SitemapUrlStatusRecord {
  url: string;
  status: number | null;
  error: string | null;
}

/**
 * A sub-resource record from a PRIOR crawl, paired with when that crawl ran, so
 * the resource checker can apply the same browser-like freshness logic to
 * sub-resources as to pages (#107). `fetchedAt` is the prior crawl's startedAt
 * (resource records have no per-row timestamp; the crawl start is the closest
 * proxy and is conservative — it makes the entry look slightly OLDER than it is).
 */
export interface CachedResourceRecord extends ResourceSizeRecord {
  /** Epoch ms of the prior crawl that produced this record. */
  fetchedAt: number;
}

// ============================================
// SMART AUDITS — SITE-SCOPED FINDING STORE (#110)
// ============================================
//
// Cross-crawl, site-keyed finding state. Unlike rule_results (keyed by
// crawl_id), these tables persist per-page finding state across audits so a
// partial re-audit can carry forward issues on un-crawled pages and supersede
// re-crawled ones (evidence-based). Gated behind the `smart_audits` flag.

/** Lifecycle state of a persisted finding. */
export type FindingState = "open" | "resolved" | "stale";

/** Provenance of a finding in a merged (union) report. */
export type FindingProvenance = "fresh" | "carried";

/**
 * A single persisted finding, keyed by (siteKey, normalizedUrl, ruleId,
 * checkName, locator). `locator` defaults to "" (whole-page check). The
 * fingerprint = sha256(status + message + value + expected) detects change /
 * resolution between crawls.
 */
export interface PageFindingRecord {
  siteKey: string;
  normalizedUrl: string;
  ruleId: string;
  checkName: string;
  /** Stable within-page locator (item id / selector). "" = whole-page check. */
  locator: string;
  status: string;
  /** Rule severity at last write — kept for surfacing carried findings. */
  severity: string;
  message: string;
  value: string | null;
  expected: string | null;
  /** JSON-serialized extra payload (items/details/pages) for report rebuild. */
  payload: string | null;
  fingerprint: string;
  firstSeenAt: number;
  lastSeenCrawlId: string;
  lastSeenAt: number;
  provenance: FindingProvenance;
  state: FindingState;
}

/** Lifecycle state of a known site page. */
export type SitePageState = "active" | "removed";

/**
 * Tuning for {@link CrawlStorage.compactFindings}. All bounds are conservative
 * hardcoded defaults (no `squirrel.toml` surface in v1, #197); these knobs exist
 * for tests. Compaction ONLY ever prunes terminal rows — `resolved`/`stale`
 * findings and `removed` site_pages — and NEVER touches `open` findings or
 * `active` pages (the #110 carry-indefinitely invariant).
 */
export interface CompactFindingsOptions {
  /** Prune terminal rows older than this many ms. Default ~90d. */
  maxAgeMs?: number;
  /** Per-siteKey cap on terminal findings; keep the NEWEST. Default ~5000. */
  maxTerminalFindings?: number;
  /** Override "now" (epoch ms) for the age cutoff — tests only. */
  now?: number;
}

/** A page known to belong to a site, with its last-observed status + state. */
export interface SitePageRecord {
  siteKey: string;
  normalizedUrl: string;
  lastStatus: number;
  state: SitePageState;
  lastSeenCrawlId: string;
  lastSeenAt: number;
}

// ============================================
// PAGE FEATURES ACCUMULATOR (#1022)
// ============================================
//
// One row per crawled URL, upserted while the page's DOM is still live during
// the streaming rule loop (#1021). It distills the per-page scalars the ~30
// site rules that currently scan `SiteData.pages` actually read (duplicate
// title/description, page-type rollups, template clustering, transfer weight,
// secret hits) so those rules can query bounded SQL aggregates instead of
// holding every parsed page resident. Purely additive: nothing reads these rows
// yet (PR-A of the streaming-engine blueprint); the accumulator is always
// written, v1 behaviour is byte-identical.

/**
 * One accumulated page-features row (keyed by crawlId + normalizedUrl in the
 * table; `crawlId` is a method parameter, mirroring {@link PageRecord}). Hashes
 * are the same content hashes the crawler already computes, so duplicate scans
 * are `GROUP BY <hash>` rather than O(pages²) JS comparisons. The three
 * boolean-presence fields (`robotsNoindex`, `visibleAuthor`, `visibleDate`) are
 * stored as 0/1 INTEGER — the eeat/legal per-URL rules only need presence, not
 * the underlying string.
 */
export interface PageFeatureRow {
  normalizedUrl: string;
  status: number;
  depth: number;
  /** Raw <title>; kept for surfacing a representative sample in duplicate groups. */
  title: string | null;
  /** Hash of the normalized title (duplicate-title grouping key). */
  titleHash: string | null;
  /** Raw <meta description>; kept for the duplicate-description sample. */
  description: string | null;
  /** Hash of the normalized description (duplicate-description grouping key). */
  descHash: string | null;
  /** Visible-content hash (duplicate-content grouping key). */
  contentHash: string | null;
  wordCount: number | null;
  /** Coarse page classification (e.g. "article", "product", "listing"). */
  pageType: string | null;
  /** Distinct schema.org @types present on the page. */
  schemaTypes: string[];
  /** meta robots / X-Robots-Tag noindex present. */
  robotsNoindex: boolean;
  canonical: string | null;
  /** A visible (non-schema) author byline was detected. */
  visibleAuthor: boolean;
  /** A visible published/modified date was detected. */
  visibleDate: boolean;
  /** Wire bytes transferred for the page document (compressed body). */
  transferBytes: number | null;
  /** Template fingerprint (near-identical page shell clustering key). */
  templateFp: string | null;
  /** Count of leaked-secret matches found on the page. */
  secretHits: number | null;
  /**
   * Token-exact meta-robots noindex (`robots.split(",").map(trim).includes("noindex")`)
   * — the meta-ONLY notion the crawl/robots-meta-conflict + crawl/noindex-in-sitemap
   * rules use. Deliberately DISTINCT from `robotsNoindex`, which is the combined
   * meta-OR-header substring notion `isPageIndexable` uses (#1022, PR-D).
   */
  metaNoindex: boolean;
  /**
   * `isPageIndexable(parsed, headers).reasons` — the meta+header indexability
   * reasons only (e.g. ["meta:noindex"], ["header:noindex"], or ["unparseable"]).
   * The robots.txt reason is site-level, so rules append `"robots.txt:disallowed"`
   * themselves from `ctx.site.robotsTxt` at run time; storing the 2-arg subset here
   * lets both the 2-arg (indexability-conflicts) and 4-arg (all-noindex,
   * schema-noindex) callers be reconstructed exactly. Bounded (≤2 short strings).
   */
  indexableReasons: string[];
  /** `getRichResultTypes(parsed.schemas)` — canonical-cased rich-result @types (≤16). */
  richResultTypes: string[];
}

/** Which hashed field a {@link SiteQuery.duplicateGroups} scan is keyed on. */
export type PageFeatureDuplicateField = "title" | "description" | "content";

/**
 * A set of URLs sharing one identical hashed value (title / description /
 * visible content). `urls` is bounded (capped per group) and deterministically
 * ordered; `sample` is a representative raw value (the shared title/description
 * text) or null for content-hash groups where no scalar text is carried.
 */
export interface DuplicateGroup {
  hash: string;
  sample: string | null;
  urls: string[];
  /** Total pages in the group before the per-group url cap (may exceed urls.length). */
  count: number;
}

/** A set of URLs sharing one template fingerprint (near-identical shell). */
export interface TemplateCluster {
  fp: string;
  urls: string[];
  /** Total pages in the cluster before the per-cluster url cap. */
  count: number;
}

/**
 * Read-only, bounded aggregate view over one crawl's {@link PageFeatureRow}s +
 * the existing link_appearances graph, threaded onto RuleContext as the
 * `ctx.siteQuery` replacement for `SiteData.pages` (blueprint §2). Small
 * aggregates are pre-materialized so site rules stay synchronous; `pagesMatching`
 * is an async cursor so a rare full scan never pins the whole page set.
 *
 * PR-A defines this contract only — the concrete implementation (built over the
 * SQLite read methods below + the existing `getAllIncomingLinkCounts`) lands in
 * a later PR alongside the streaming loop. Declared here so `packages/rules` can
 * depend on the shape without importing crawler internals.
 */
export interface SiteQuery {
  /** Number of accumulated page rows for the crawl. */
  pageCount(): number;
  /** URL sets sharing an identical title/description/content hash (count > 1). */
  duplicateGroups(field: PageFeatureDuplicateField): DuplicateGroup[];
  /**
   * Incoming internal-link counts, keyed by each crawled page's stored
   * (normalized) URL. NOTE: reconstructed from the pages' parsed links, not
   * `link_appearances` — that table stores only EXTERNAL links, so its counts
   * cannot answer internal orphan / weak-internal-link questions.
   */
  incomingLinkCounts(): Map<string, number>;
  /** Normalized URLs of pages classified as `type`. */
  pagesByType(type: string): string[];
  /** URL sets sharing one template fingerprint (count > 1). */
  templateClusters(): TemplateCluster[];
  /** Sum of per-page transfer bytes across the crawl. */
  sumTransferBytes(): number;
  /** Sum of per-page leaked-secret hit counts across the crawl. */
  sumSecretHits(): number;
  /** The homepage (shallowest) page-features row, or null for an empty crawl. */
  homepage(): PageFeatureRow | null;
  /** Cursor over every page row (never a full resident array), predicate-filtered. */
  pagesMatching(pred: (row: PageFeatureRow) => boolean): AsyncIterable<PageFeatureRow>;
}

// ============================================
// PUBLISHED REPORTS
// ============================================

export type PublishedReportVisibility = "public" | "unlisted" | "private";

export interface PublishedReportRecord {
  crawlId: string;
  reportId: string;
  url: string;
  visibility: PublishedReportVisibility;
  publishedAt: string;
}

// ============================================
// ROBOTS & SITEMAPS
// ============================================

export interface RobotsTxtRecord {
  url: string;
  exists: boolean;
  content: string | null;
  sizeBytes: number;
  sitemaps: string[];
  fetchedAt: number;
}

// Persisted llms.txt + llms-full.txt root fetch; mirrors RobotsTxtRecord.
export interface LlmsTxtFileRecord {
  url: string;
  exists: boolean;
  content: string | null;
  sizeBytes: number;
}

export interface LlmsTxtRecord {
  llmsTxt: LlmsTxtFileRecord;
  llmsFullTxt: LlmsTxtFileRecord;
  fetchedAt: number;
}

// Persisted homepage markdown content-negotiation + .md variant probe.
export interface MarkdownProbeRecord {
  negotiatedUrl: string;
  negotiatedContentType: string | null;
  servesMarkdown: boolean;
  mdVariantUrl: string;
  mdVariantExists: boolean;
  mdVariantContentType: string | null;
  /** Optional: undefined for rows persisted before these fields existed (no SQLite columns yet). */
  negotiatedVary?: string | null;
  markdownTokensHeader?: string | null;
  originalTokensHeader?: string | null;
  alternateMarkdownUrl?: string | null;
  fetchedAt: number;
}

// ============================================
// AGENT EXPERIENCE (AX) PREFETCHES
// ============================================

// One probed well-known/agent-file path. Rules decide meaning; the crawler only
// records validation hints so SPA-fallback 200s (HTML for every path) are rejectable.
export interface WellKnownProbe {
  path: string;
  url: string;
  /** Final HTTP status after redirects; 0 = network error. */
  status: number;
  contentType: string | null;
  /** Decoded body size in bytes (capped at fetch time). */
  bodySize: number;
  /** Body sniffed as HTML (<!doctype/<html) — the SPA-fallback trap. */
  looksHtml: boolean;
  /** Body parsed as JSON (never true when looksHtml). */
  jsonValid: boolean;
  /** Top-level keys of the parsed JSON object (empty for arrays/scalars/non-JSON). */
  jsonKeys: string[];
  /** Body looks like Markdown (ATX heading or md links) and is not HTML. */
  markdownLike: boolean;
  /** Capped body excerpt for rules to inspect (~2KB; ~64KB for OAuth metadata paths). */
  excerpt: string;
  /**
   * OAuth AS/PRM metadata `registration_endpoint` (dynamic client registration),
   * extracted for the two `/.well-known/oauth-*` probes. null for other paths,
   * non-JSON, HTML fallback, or when the field is absent.
   */
  oauthRegistrationEndpoint: string | null;
  /**
   * OAuth AS/PRM metadata `client_id_metadata_document_supported` (CIMD, the
   * client.dev pattern). null for other paths / non-JSON / when the field is absent.
   */
  oauthClientIdMetadataDocumentSupported: boolean | null;
  /** Non-fatal fetch error note; null otherwise. */
  error: string | null;
}

export interface WellKnownProbeRecord {
  probes: WellKnownProbe[];
  fetchedAt: number;
}

export type AgentAccessUserAgent = "browser" | "gptbot" | "claude-user";

// One homepage fetch under a specific UA identity, for access-parity comparison.
export interface AgentAccessProbe {
  userAgent: AgentAccessUserAgent;
  /** Full UA header string sent. */
  userAgentString: string;
  /** Final HTTP status; 0 = network error. */
  status: number;
  bodySize: number;
  /** A bot challenge / interstitial was detected. */
  challenged: boolean;
  /** Which signal tripped challenge detection (cf-mitigated, just-a-moment, …), or null. */
  challengeSignal: string | null;
  /** A pay-per-crawl / x402 payment wall was detected. */
  paymentRequired: boolean;
  /** Which signal tripped payment detection (crawler-price, http-402, x402-body, …), or null. */
  paymentSignal: string | null;
  error: string | null;
}

export interface AgentAccessRecord {
  probes: AgentAccessProbe[];
  fetchedAt: number;
}

// One fetched RSL (rslstandard.org) license document referenced from robots.txt.
export interface RslLicenseDoc {
  url: string;
  /** Final HTTP status; 0 = network error. */
  status: number;
  contentType: string | null;
  /** Parsed as XML (and not HTML). */
  xmlValid: boolean;
  /** Root element / namespace looks like RSL. */
  looksRsl: boolean;
  excerpt: string;
  error: string | null;
}

export interface RslRecord {
  /** Absolute license URLs from robots.txt `License:` directives + `Link: rel=license`. */
  licenseUrls: string[];
  /** A `License:` directive was present in robots.txt. */
  robotsHasLicense: boolean;
  /** The robots.txt response carried a `Link: rel="license"` header. */
  linkHeaderPresent: boolean;
  documents: RslLicenseDoc[];
  fetchedAt: number;
}

export interface SitemapRecord {
  url: string;
  type: "urlset" | "index";
  urlCount: number;
  childSitemaps: string[];
  errors: string[];
  fetchedAt: number;
}

export interface SitemapUrlRecord {
  sitemapUrl: string;
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

// ============================================
// PAGINATION & OPTIONS
// ============================================

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface StorageOptions {
  path?: string;
  projectName?: string;
  silent?: boolean;
}

// ============================================
// CRAWL STORAGE INTERFACE
// ============================================

export interface CrawlStorage {
  // Lifecycle
  init(): Effect.Effect<void, StorageError, never>;
  close(): Effect.Effect<void, StorageError, never>;

  // Crawl session
  createCrawl(metadata: Omit<CrawlMetadata, "id">): Effect.Effect<string, StorageError, never>;
  getCrawl(id: string): Effect.Effect<CrawlMetadata | null, StorageError, never>;
  updateCrawl(
    id: string,
    updates: Partial<Omit<CrawlMetadata, "id">>,
  ): Effect.Effect<void, StorageError, never>;
  listCrawls(limit?: number): Effect.Effect<CrawlMetadata[], StorageError, never>;
  getCrawlByUrl(baseUrl: string): Effect.Effect<CrawlMetadata | null, StorageError, never>;

  // Pages
  upsertPage(crawlId: string, page: PageRecord): Effect.Effect<void, StorageError, never>;
  getPage(
    crawlId: string,
    normalizedUrl: string,
  ): Effect.Effect<PageRecord | null, StorageError, never>;
  getPages(
    crawlId: string,
    options?: PaginationOptions,
  ): Effect.Effect<PageRecord[], StorageError, never>;
  getPageCount(crawlId: string): Effect.Effect<number, StorageError, never>;
  hasPage(crawlId: string, normalizedUrl: string): Effect.Effect<boolean, StorageError, never>;
  getCachedPage(normalizedUrl: string): Effect.Effect<PageRecord | null, StorageError, never>;

  // Frontier
  upsertFrontier(crawlId: string, entry: FrontierRecord): Effect.Effect<void, StorageError, never>;
  getFrontierEntry(
    crawlId: string,
    normalizedUrl: string,
  ): Effect.Effect<FrontierRecord | null, StorageError, never>;
  popNextUrl(crawlId: string): Effect.Effect<FrontierRecord | null, StorageError, never>;
  // perHostLimit (#440): cap URLs per host within a batch so a busy host can't
  // reserve the whole batch while its per-host throttle stalls the extra workers.
  popNextUrls(
    crawlId: string,
    count: number,
    perHostLimit?: number,
  ): Effect.Effect<FrontierRecord[], StorageError, never>;
  getPendingCount(crawlId: string): Effect.Effect<number, StorageError, never>;
  getFetchingCount(crawlId: string): Effect.Effect<number, StorageError, never>;
  updateFrontierStatus(
    crawlId: string,
    normalizedUrl: string,
    status: FrontierStatus,
    reason?: string,
  ): Effect.Effect<void, StorageError, never>;
  resetStaleFetching(crawlId: string): Effect.Effect<number, StorageError, never>;
  getAllFrontierEntries(crawlId: string): Effect.Effect<FrontierRecord[], StorageError, never>;
  clearFrontier(crawlId: string): Effect.Effect<void, StorageError, never>;
  clearCrawlData(crawlId: string): Effect.Effect<void, StorageError, never>;

  // Links
  upsertLink(crawlId: string, link: LinkRecord): Effect.Effect<void, StorageError, never>;
  getLink(crawlId: string, href: string): Effect.Effect<LinkRecord | null, StorageError, never>;
  addLinkAppearance(
    crawlId: string,
    appearance: LinkAppearanceRecord,
  ): Effect.Effect<void, StorageError, never>;
  addLinkAppearancesBatch(
    crawlId: string,
    appearances: LinkAppearanceRecord[],
  ): Effect.Effect<void, StorageError, never>;
  getLinks(
    crawlId: string,
    options?: { unchecked?: boolean },
  ): Effect.Effect<LinkRecord[], StorageError, never>;
  getLinkAppearances(
    crawlId: string,
    href: string,
  ): Effect.Effect<LinkAppearanceRecord[], StorageError, never>;
  getIncomingLinkCount(
    crawlId: string,
    normalizedUrl: string,
  ): Effect.Effect<number, StorageError, never>;
  getAllIncomingLinkCounts(
    crawlId: string,
  ): Effect.Effect<Map<string, number>, StorageError, never>;
  getLinksByPage(pageUrl: string): Effect.Effect<LinkRecord[], StorageError, never>;

  // Images
  upsertImage(crawlId: string, image: ImageRecord): Effect.Effect<void, StorageError, never>;
  getImage(crawlId: string, src: string): Effect.Effect<ImageRecord | null, StorageError, never>;
  addImageAppearance(
    crawlId: string,
    appearance: ImageAppearanceRecord,
  ): Effect.Effect<void, StorageError, never>;
  getImages(crawlId: string): Effect.Effect<ImageRecord[], StorageError, never>;
  getImageAppearances(
    crawlId: string,
    src: string,
  ): Effect.Effect<ImageAppearanceRecord[], StorageError, never>;
  getImagesByPage(pageUrl: string): Effect.Effect<ImageRecord[], StorageError, never>;

  // Robots & Sitemaps
  setRobotsTxt(crawlId: string, robots: RobotsTxtRecord): Effect.Effect<void, StorageError, never>;
  getRobotsTxt(crawlId: string): Effect.Effect<RobotsTxtRecord | null, StorageError, never>;
  setLlmsTxt(crawlId: string, llms: LlmsTxtRecord): Effect.Effect<void, StorageError, never>;
  getLlmsTxt(crawlId: string): Effect.Effect<LlmsTxtRecord | null, StorageError, never>;
  setMarkdownProbe(
    crawlId: string,
    probe: MarkdownProbeRecord,
  ): Effect.Effect<void, StorageError, never>;
  getMarkdownProbe(crawlId: string): Effect.Effect<MarkdownProbeRecord | null, StorageError, never>;
  // AX prefetches — mirror the llms/markdown setter/getter shape.
  setWellKnownProbe(
    crawlId: string,
    probe: WellKnownProbeRecord,
  ): Effect.Effect<void, StorageError, never>;
  getWellKnownProbe(
    crawlId: string,
  ): Effect.Effect<WellKnownProbeRecord | null, StorageError, never>;
  setAgentAccess(
    crawlId: string,
    access: AgentAccessRecord,
  ): Effect.Effect<void, StorageError, never>;
  getAgentAccess(crawlId: string): Effect.Effect<AgentAccessRecord | null, StorageError, never>;
  setRsl(crawlId: string, rsl: RslRecord): Effect.Effect<void, StorageError, never>;
  getRsl(crawlId: string): Effect.Effect<RslRecord | null, StorageError, never>;
  addSitemap(crawlId: string, sitemap: SitemapRecord): Effect.Effect<void, StorageError, never>;
  getSitemaps(crawlId: string): Effect.Effect<SitemapRecord[], StorageError, never>;
  addSitemapUrls(
    crawlId: string,
    urls: SitemapUrlRecord[],
  ): Effect.Effect<void, StorageError, never>;
  getSitemapUrls(
    crawlId: string,
    sitemapUrl: string,
  ): Effect.Effect<SitemapUrlRecord[], StorageError, never>;

  // Stats
  updateStats(
    crawlId: string,
    updates: Partial<CrawlStats>,
  ): Effect.Effect<void, StorageError, never>;
  getStats(crawlId: string): Effect.Effect<CrawlStats | null, StorageError, never>;
  saveResourceSizes(
    crawlId: string,
    records: ResourceSizeRecord[],
  ): Effect.Effect<void, StorageError, never>;
  getResourceSizes(crawlId: string): Effect.Effect<ResourceSizeRecord[], StorageError, never>;
  /**
   * Most-recent sub-resource records from PRIOR crawls (excluding `crawlId`),
   * keyed by URL, for browser-like sub-resource cache reuse (#107). Each carries
   * the prior crawl's startedAt as `fetchedAt`. Empty when no prior crawl exists.
   */
  getCachedResources(
    crawlId: string,
  ): Effect.Effect<CachedResourceRecord[], StorageError, never>;
  saveSitemapUrlStatuses(
    crawlId: string,
    statuses: SitemapUrlStatusRecord[],
  ): Effect.Effect<void, StorageError, never>;
  getSitemapUrlStatuses(
    crawlId: string,
  ): Effect.Effect<SitemapUrlStatusRecord[], StorageError, never>;

  // Rule results
  saveRuleResults(
    crawlId: string,
    pageUrl: string,
    ruleId: string,
    checks: unknown[],
  ): Effect.Effect<void, StorageError, never>;
  getRuleResults(crawlId: string, pageUrl?: string): Effect.Effect<unknown[], StorageError, never>;

  // Smart audits — site-scoped finding store (#110, gated by `smart_audits`)
  upsertFindings(findings: PageFindingRecord[]): Effect.Effect<void, StorageError, never>;
  /**
   * Load findings for a site. Pass `states` to restrict to those lifecycle
   * states — the merge hot-path passes `["open"]` so it never scans the
   * (potentially large) resolved/stale history. Omit for all states.
   */
  getFindings(
    siteKey: string,
    states?: FindingState[],
  ): Effect.Effect<PageFindingRecord[], StorageError, never>;
  markPageRemoved(
    siteKey: string,
    normalizedUrl: string,
    crawlId: string,
    lastStatus: number,
  ): Effect.Effect<void, StorageError, never>;
  upsertSitePages(pages: SitePageRecord[]): Effect.Effect<void, StorageError, never>;
  getSitePages(siteKey: string): Effect.Effect<SitePageRecord[], StorageError, never>;
  /**
   * Bounded single-site hygiene for churny sites (#197). Prunes ONLY terminal
   * rows for `siteKey` — `resolved`/`stale` findings and `removed` site_pages —
   * age-bounded with an optional per-siteKey cap (keep newest). NEVER deletes
   * `open` findings or `active` pages, preserving the #110 carry-indefinitely
   * invariant. Best-effort: callers run it after persist and must not let a
   * failure fail the audit. Returns the number of rows deleted.
   */
  compactFindings(
    siteKey: string,
    opts?: CompactFindingsOptions,
  ): Effect.Effect<number, StorageError, never>;

  // Project meta — cross-crawl key/value store scoped to the project database
  // (e.g. the sticky random user-agent, #875).
  getProjectMeta(key: string): Effect.Effect<string | null, StorageError, never>;
  setProjectMeta(key: string, value: string): Effect.Effect<void, StorageError, never>;
}

// ============================================
// REPORT STORAGE INTERFACE
// ============================================

/** Report output storage — filesystem, R2, database JSON field */
export interface ReportStorage<T = unknown> {
  putReport(key: string, report: T): Promise<void>;
  getReport(key: string): Promise<T | null>;
}
