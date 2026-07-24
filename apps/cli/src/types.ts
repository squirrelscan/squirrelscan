// Type definitions for SEO audit

export interface AuditResult {
  url: string;
  status: "pass" | "warn" | "fail";
  checks: CheckResult[];
  timestamp: string;
}

// ============================================
// ROBOTS.TXT TYPES
// ============================================

export interface RobotsRule {
  userAgent: string;
  rules: {
    type: "allow" | "disallow";
    path: string;
  }[];
  crawlDelay?: number;
}

export interface RobotsTxtData {
  exists: boolean;
  url: string;
  content: string | null;
  sizeBytes: number;
  sitemaps: string[];
  rules: RobotsRule[];
  errors: string[];
}

// ============================================
// SITEMAP TYPES
// ============================================

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapData {
  url: string;
  type: "urlset" | "index";
  urls: SitemapUrl[];
  childSitemaps: string[];
  errors: string[];
  urlCount: number;
}

export interface SitemapFetchFailure {
  url: string;
  source: "robots.txt" | "common";
  error: string; // "HTTP 404", "Network error", etc.
}

export interface SitemapDiscovery {
  discovered: SitemapData[];
  sources: {
    robotsTxt: string[];
    commonLocations: string[];
  };
  totalUrls: number;
  orphanPages: string[]; // in sitemap but not crawled
  missingPages: string[]; // crawled but not in sitemap
  failed: SitemapFetchFailure[]; // sitemaps that failed to fetch
}

// ============================================
// URL STRUCTURE TYPES
// ============================================

export interface UrlAnalysis {
  url: string;
  length: number;
  hasNonAscii: boolean;
  hasUnderscores: boolean;
  hasUppercase: boolean;
  hasParameters: boolean;
  parameterCount: number;
  hasTrailingSlash: boolean;
  hasDoubleSlashes: boolean;
  hasSessionId: boolean;
  fileExtension: string | null;
  depth: number; // path segments count
}

// ============================================
// REDIRECT TYPES (canonical source: @squirrelscan/core-contracts)
// ============================================

import type {
  RedirectHop as _RedirectHop,
  RedirectChain as _RedirectChain,
  SecurityHeaders as _SecurityHeaders,
} from "@squirrelscan/core-contracts";
export type RedirectHop = _RedirectHop;
export type RedirectChain = _RedirectChain;

// ============================================
// CONTENT ANALYSIS TYPES
// ============================================

export interface HeadingData {
  level: number; // 1-6
  text: string;
  order: number; // position in document
}

export interface HeadingHierarchy {
  headings: HeadingData[];
  h1Count: number;
  h1Texts: string[];
  hasSkippedLevels: boolean;
  skippedLevels: string[]; // e.g., ["H1 -> H3"]
  emptyHeadings: HeadingData[];
  longHeadings: HeadingData[]; // > 70 chars
  duplicateHeadings: string[];
  outline: string; // text outline
}

export interface ContentAnalysis {
  wordCount: number;
  textLength: number;
  htmlLength: number;
  textToHtmlRatio: number;
  isThinContent: boolean; // < 300 words
  contentHash: string; // for duplicate detection
  textContent: string; // clean text extracted via DOM (scripts/styles removed)
}

// ============================================
// SECURITY TYPES
// ============================================

export type SecurityHeaders = _SecurityHeaders;

export interface SecurityAnalysis {
  isHttps: boolean;
  hasMixedContent: boolean;
  mixedContentUrls: string[];
  insecureFormActions: string[];
  headers: SecurityHeaders;
  httpToHttpsRedirect: boolean;
}

// ============================================
// RESPONSE HEADERS
// ============================================

export interface ResponseHeaders {
  contentType: string | null;
  contentEncoding: string | null;
  cacheControl: string | null;
  vary: string | null;
  etag: string | null;
  server: string | null;
  lastModified: string | null;
  // Additional headers for SEO/performance rules
  link: string | null; // canonical-header rule
  serverTiming: string | null; // performance metrics
  age: string | null; // cache age
  xCache: string | null; // CDN cache status
  cfCacheStatus: string | null; // Cloudflare cache
  xVercelCache: string | null; // Vercel cache
  altSvc: string | null; // HTTP/2/3 support
  acceptRanges: string | null; // range request support
}

// ============================================
// HEALTH SCORE TYPES
// ============================================

// Re-export from core-contracts (canonical source)
import type {
  AuditStatus as _AS,
  CacheStats as _CST,
  CategoryScore as _CS,
  DomainStats as _DST,
  EditorSummary as _ES,
  GroupScore as _GS,
  HealthScore as _HS,
  ReportTechnologies as _RT,
  RuleCategory as _RC,
  SiteMetadata as _SM,
} from "@squirrelscan/core-contracts";
export type AuditStatus = _AS;
export type CategoryScore = _CS;
export type GroupScore = _GS;
export type HealthScore = _HS;
export type RuleCategory = _RC;
export type ReportTechnologies = _RT;
export type SiteMetadata = _SM;
export type EditorSummary = _ES;
export type DomainStats = _DST;
export type CacheStats = _CST;

// Structured item for CheckResult - represents a single affected resource
export interface CheckItem {
  id: string; // URL, selector, keyword, element ID, etc.
  label?: string; // Human-readable label (defaults to id if not set)
  snippet?: string; // Truncated HTML context (e.g., '<img src="..." alt="">')
  sourcePages?: string[]; // Pages where this item appears (for site-scope rules)
  meta?: Record<string, unknown>; // Rule-specific metadata (e.g., { status: 404, density: 3.2 })
}

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail" | "info" | "skipped";
  message: string;
  pageUrl?: string; // URL of page where issue was found (for page-scope rules)

  // Structured data fields (preferred)
  items?: CheckItem[]; // List of affected items with metadata
  details?: Record<string, unknown>; // Rule-level metadata
  pages?: string[]; // Affected pages (for page-scope rules)

  // Legacy fields (deprecated - use items/details instead)
  value?: string | number | null;
  expected?: string | number | null;
  skipReason?: string; // Why rule was skipped (e.g., "LLM unavailable")

  // Smart audits (#110): provenance for findings carried across audits.
  // `carried` = re-injected from the store for a page not re-crawled this run.
  // Absent (or `fresh`) = evaluated this run. `lastSeenAt` = epoch ms of the
  // last run that observed it. Only set when `smart_audits` is enabled.
  provenance?: "fresh" | "carried";
  lastSeenAt?: number;
}

export interface MetaData {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
}

export interface OpenGraphData {
  title: string | null;
  description: string | null;
  url: string | null;
  type: string | null;
  image: string | null;
  siteName: string | null;
}

export interface TwitterData {
  card: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
}

export interface SchemaData {
  types: string[];
  valid: boolean;
  errors: string[];
  raw: string | null;
}

export interface LinkData {
  url: string;
  text: string;
  isInternal: boolean;
  status?: number;
  error?: string;
  rel?: string[];
  isNofollow?: boolean;
}

export interface ResourceSizeData {
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sourcePages: string[];
  /** content-encoding (gzip/br/deflate/zstd) or null. (#107) */
  contentEncoding?: string | null;
  /** Bytes transferred over the wire (compressed body). (#107) */
  transferBytes?: number | null;
  /** Cache-Control header verbatim. (#107) */
  cacheControl?: string | null;
  /** ETag validator, if present. (#107) */
  etag?: string | null;
  /** Last-Modified validator, if present. (#107) */
  lastModified?: string | null;
  /** Vary header verbatim; gates cache reuse. (#107) */
  vary?: string | null;
  /** Cache-hit reason if reused from a prior crawl; null on a real fetch. (#107) */
  cacheReason?: import("@squirrelscan/core-contracts").CacheHitReason | null;
}

export interface ScriptContentData {
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  content: string | null; // Actual JS content for scanning
  sourcePages: string[];
  redirected?: boolean;
  finalUrl?: string;
  /** SourceMap or X-SourceMap response header value, if present */
  sourceMapHeader?: string;
}

export interface SitemapUrlStatusData {
  url: string;
  status: number | null;
  error: string | null;
}

export interface ImageData {
  src: string;
  alt: string | null;
  width: string | null;
  height: string | null;
}

export interface PageAudit {
  url: string;
  statusCode: number;
  loadTime: number;
  meta: MetaData;
  og: OpenGraphData;
  twitter: TwitterData;
  schema: SchemaData;
  links: LinkData[];
  images: ImageData[];
  h1Count: number;
  h1Text: string[];
  checks: CheckResult[];
  // New fields for expanded audit
  urlAnalysis?: UrlAnalysis;
  headingHierarchy?: HeadingHierarchy;
  contentAnalysis?: ContentAnalysis;
  security?: SecurityAnalysis;
  responseHeaders?: ResponseHeaders;
  redirectChain?: RedirectChain;
  /** Which egress/method served this page + any fallback reason (#512). */
  fetcherId?: string;
  fallbackReason?: string;
}

// Rule result type for report
export interface ReportRuleResult {
  meta: {
    id: string;
    name: string;
    description: string;
    solution?: string;
    category: RuleCategory;
    subcategory?: string;
    scope: "page" | "site";
    severity: "error" | "warning" | "info";
    weight: number;
  };
  checks: CheckResult[];
}

export interface AuditReport {
  crawlId?: string; // UUID of the crawl this report was generated from
  baseUrl: string;
  timestamp: string;
  totalPages: number;
  passed: number;
  warnings: number;
  failed: number;
  /** Audit validity (#489) — set only when not `completed`; absent ⇒ completed. */
  status?: AuditStatus;
  /** Short human reason shown when `status` is failed/blocked. */
  statusReason?: string;
  siteChecks: CheckResult[];
  pages: PageAudit[];
  summary: {
    missingTitles: string[];
    missingDescriptions: string[];
    missingOgTags: string[];
    missingTwitterCards: string[];
    missingSchemas: string[];
    missingAltText: { page: string; image: string }[];
    multipleH1s: string[];
    // New summary fields
    thinContentPages: string[];
    urlIssues: { url: string; issues: string[] }[];
    redirectChains: RedirectChain[];
    securityIssues: { url: string; issues: string[] }[];
  };
  // New report sections
  robotsTxt?: RobotsTxtData;
  sitemaps?: SitemapDiscovery;
  healthScore?: HealthScore;
  resourceSizes?: {
    css: ResourceSizeData[];
    images: ResourceSizeData[];
  };
  sitemapUrlStatuses?: SitemapUrlStatusData[];
  ruleResults: Record<string, ReportRuleResult>;
  /**
   * Detected technology stack — REPORT-ONLY, surfaced separately from issues.
   * Never contributes to `healthScore`. Present only when the credited cloud
   * tech-detect ran (logged-in users with cloud enabled).
   */
  technologies?: ReportTechnologies;
  /**
   * Resolved Stage-0 site profile — REPORT-ONLY / non-scoring. Present only when
   * the credited cloud `site-metadata` service resolved it (logged-in + cloud +
   * credits). Persisted for explainability: it drives which cloud features and
   * audit rules applied this run. Null/absent → no metadata gating occurred.
   */
  siteMetadata?: SiteMetadata;
  /**
   * Auto-generated editor's summary — REPORT-ONLY / non-scoring, surfaced at the
   * TOP of the report. Present only when the credited cloud
   * editor-summary call ran (any logged-in plan with cloud enabled).
   */
  editorSummary?: EditorSummary;
  /**
   * Domain-level SEO stats (#111) — REPORT-ONLY / non-scoring. Present only when
   * the credited cloud domain-stats call returned data (any logged-in
   * plan with cloud enabled); absent otherwise.
   */
  domainStats?: DomainStats;
  /**
   * Aggregate crawl-cache stats (#108) — hit rate, bytes saved, hits-by-reason
   * across pages + sub-resources. REPORT-ONLY / non-scoring. Present only on
   * incremental re-audits with cache reuse; absent on a cold run.
   */
  cacheStats?: CacheStats;
  /**
   * Per-phase wall-clock breakdown in ms (#857) — DEBUG/DIAGNOSTIC ONLY, never
   * rendered in the report and never scoring. Keys are a fixed, low-cardinality
   * set (crawl, external_links, assets, cloud_prefetch, tech_detect, rules,
   * smart_merge, report, editor_summary, domain_stats, publish); a phase that
   * didn't run this audit is simply absent. Populated by `runAudit`; `publish`
   * is added by the CLI command layer after `runAudit` returns.
   */
  phaseTimingsMs?: Record<string, number>;
  /** Cloud enrichment spend for this audit (present when any cloud call ran). */
  cloudSpend?: {
    lines: Array<{
      service: string;
      feature: string;
      units: number;
      credits: number;
    }>;
    totalSpent: number;
    balanceAfter: number | null;
  };
  /**
   * Failed cloud service calls (present when any attempted call failed).
   * Failed batches are uncharged — without this the only symptom is silently
   * reduced coverage in the cloud-backed checks.
   */
  cloudFailures?: Array<{
    service: string;
    /** Pages (or 1 for site-scope) that got no result. */
    failedUnits: number;
    /** Pages attempted for the service this run. */
    attemptedUnits: number;
    failedBatches: number;
    /** Short cause, e.g. "payload too large", "service error (502)". */
    detail: string;
  }>;
  /**
   * Smart audits (#110): present only when `smart_audits` is on. Records how
   * much of the known site this run actually re-crawled. `auditedPages` of
   * `knownPages` were freshly evaluated; the rest were carried forward.
   */
  coverage?: {
    auditedPages: number;
    knownPages: number;
    carriedFindings: number;
  };
  /**
   * Scan scope disclosure (#1180): where the audit ran and how much of the site
   * it crawled. `capped` = the page limit was the binding constraint, driving
   * the full-scan hint. REPORT-ONLY. Mirrors core-contracts `AuditReport`.
   */
  scanScope?: {
    origin: "cli" | "ci" | "cloud";
    maxPages?: number;
    pagesCrawled: number;
    capped: boolean;
  };
  /** Generator (`squirrel` CLI) version, stamped at publish for the report footer. */
  generatorVersion?: string;
  /**
   * Homepage title/description, derived from `pages` at publish (pickHomepageSummary)
   * and carried through after `pages` is dropped. Mirrors core-contracts `AuditReport`.
   */
  homepage?: { title: string | null; description: string | null };
  /**
   * Cloud-/Pro-gated rules not run this audit — shown locked (upsell) in the
   * report. Computed at publish. Mirrors core-contracts `AuditReport`.
   */
  lockedRules?: Array<{ id: string; name: string }>;
  /**
   * Account tier that generated this report (#368). Drives the locked-rules
   * messaging: "anonymous"/absent → free-account upsell; "free"/"paid" →
   * signed-in framing (no signup upsell). Mirrors core-contracts `AuditReport`.
   */
  cloudPlan?: "anonymous" | "free" | "paid";
  /**
   * Resolved cloud fetch mode this run (#368). "http" = user opted out of cloud
   * rendering, so locked checks are deliberate (not "unavailable"). Mirrors
   * core-contracts `AuditReport`.
   */
  cloudMode?: "http" | "browser";
  /**
   * Coverage mode this audit ran with (#747). "quick" makes locked cloud rules
   * read as a coverage choice ("re-run with -C surface/full"), never a cloud
   * outage. Stamped at publish. Mirrors core-contracts `AuditReport`.
   */
  coverageMode?: CoverageMode;
  /**
   * Render-block recovery summary (#512): pages whose render was blocked and
   * recovered via a non-browser fallback fetch. Mirrors core-contracts
   * `AuditReport`. REPORT-ONLY. Absent when nothing was recovered.
   */
  fetchFallbacks?: { recovered: number };
}

export type CoverageMode = "quick" | "surface" | "full";

export interface AuditOptions {
  url: string;
  maxPages?: number;
  maxDepth?: number; // optional crawl-depth ceiling (#318); unset = unlimited
  outputFormat?:
    | "json"
    | "html"
    | "console"
    | "text"
    | "markdown"
    | "xml"
    | "llm";
  outputPath?: string;
  refresh?: boolean; // ignore cache, fetch all pages fresh
  freshUa?: boolean; // re-roll the project's sticky random user-agent (#875)
  incremental?: boolean; // force conditional-GET re-scan on/off (overrides [crawler] incremental); --refresh wins
  resume?: boolean; // resume interrupted crawl for this domain
  verbose?: boolean;
  debug?: boolean;
  projectName?: string; // custom project name (for local addresses)
  coverageMode?: CoverageMode; // quick, surface, or full
  // Crawl parallelism overrides (#1068): global worker pool + per-host cap.
  // Positive integers; override [crawler] concurrency / per_host_concurrency
  // and suppress the loopback fast path.
  concurrency?: number;
  perHostConcurrency?: number;
  // Smart audits (#110/#684): cross-audit finding carry + union scoring. Resolved
  // by the command (signed-in → on, anonymous → off) unless config sets it
  // explicitly. Undefined here → mergeOptionsToConfig falls back to config.
  smartAudits?: boolean;
  offline?: boolean; // disable all network features (cloud, publish, telemetry)
  // Custom HTTP request headers attached to every crawl request (#494); merged
  // over [crawler] headers. Values are secrets — never echo them, redact in logs.
  headers?: Record<string, string>;
  // --rule-include/--rule-exclude (#1066): resolved patterns from
  // parseRuleFilters, applied over config.rules by mergeOptionsToConfig via
  // resolveRulesConfig. include REPLACES config.rules.enable, exclude APPENDS
  // to config.rules.disable.
  ruleInclude?: string[];
  ruleExclude?: string[];
}

// ============================================
// HREFLANG TYPES (Phase 3)
// ============================================

export interface HreflangTag {
  hreflang: string; // e.g., "en-US", "x-default"
  href: string;
  source: "html" | "header" | "sitemap";
}

export interface HreflangAnalysis {
  tags: HreflangTag[];
  hasXDefault: boolean;
  hasSelfReference: boolean;
  languages: string[];
  regions: string[];
  errors: string[];
  returnLinks: { from: string; to: string; missing: boolean }[];
}

// ============================================
// CORE WEB VITALS TYPES (Phase 3)
// ============================================

export interface CWVHints {
  // LCP hints
  largeImagesWithoutPreload: string[];
  renderBlockingResources: string[];
  fontsWithoutSwap: string[];
  missingPreconnect: string[];
  // CLS hints
  imagesWithoutDimensions: string[];
  iframesWithoutDimensions: string[];
  // INP hints
  largeScripts: { src: string; size?: number }[];
  thirdPartyScripts: string[];
  // Resource hints
  preloadTags: string[];
  prefetchTags: string[];
  preconnectTags: string[];
  dnsPrefetchTags: string[];
  // Script loading
  asyncScripts: number;
  deferScripts: number;
  blockingScripts: number;
  totalScripts: number;
}

// ============================================
// ENHANCED LINK TYPES (Phase 4)
// ============================================

export interface EnhancedLinkData extends LinkData {
  rel?: string[];
  isNofollow: boolean;
  isSponsored: boolean;
  isUgc: boolean;
  hasNoopener: boolean;
  target?: string;
  anchorType: "text" | "image" | "empty" | "generic";
}

export interface InternalLinkAnalysis {
  totalInternalLinks: number;
  totalExternalLinks: number;
  orphanPages: string[];
  deepPages: { url: string; depth: number }[]; // > 3 clicks
  crawlDepth: Map<string, number>;
  linkEquity: Map<string, number>; // incoming link count
  pagesWithFewLinks: { url: string; count: number }[];
  pagesWithManyLinks: { url: string; count: number }[];
}

export interface AnchorTextAnalysis {
  genericAnchors: { url: string; text: string }[];
  emptyAnchors: string[];
  imageOnlyLinks: string[];
  keywordRichAnchors: { url: string; text: string }[];
  anchorDistribution: Map<string, number>;
}

// ============================================
// ENHANCED IMAGE TYPES (Phase 4)
// ============================================

export interface EnhancedImageData extends ImageData {
  format: string | null; // webp, avif, jpeg, png, gif, svg
  hasLazyLoading: boolean;
  hasSrcset: boolean;
  hasSizes: boolean;
  isDecorativeAlt: boolean; // empty alt intentional
  filenameQuality: "good" | "generic" | "random";
  inFigure: boolean;
  hasFigcaption: boolean;
}

// ============================================
// ENHANCED OG TYPES (Phase 4)
// ============================================

export interface EnhancedOpenGraphData extends OpenGraphData {
  imageWidth: number | null;
  imageHeight: number | null;
  imageAlt: string | null;
  locale: string | null;
  localeAlternate: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface EnhancedTwitterData extends TwitterData {
  imageWidth: number | null;
  imageHeight: number | null;
  imageAlt: string | null;
  site: string | null;
  creator: string | null;
  player: string | null;
  playerWidth: string | null;
  playerHeight: string | null;
}
