// Shared cloud-service contracts: request/response shapes for the credit-gated
// Gemini-backed enrichment services (CLI -> API). Dep-free plain TypeScript
// (type-only imports below are erased at compile time).

import type { DomainStatsMetrics, ReportTechnology, SoftwareAdvisory } from "./index";

export type CloudServiceId =
  | "ai-parse"
  | "ai-content"
  | "authority-signals"
  | "site-metadata"
  | "blocklist-check"
  | "content-gaps"
  | "keyword-gaps"
  | "dead-links"
  | "tech-detect"
  | "editor-summary"
  | "domain-stats"
  | "archive-indexing"
  | "render";

// Slim per-page payload sent from the CLI for AI analysis.
// textExcerpt is capped client-side (~6KB).
export interface CloudPagePayload {
  url: string;
  title?: string;
  textExcerpt: string;
  meta?: Record<string, string>;
  headings?: string[];
  links?: { href: string; text?: string }[];
}

// --- ai-parse -------------------------------------------------------------

export type AiParsePageType =
  | "article"
  | "product"
  | "homepage"
  | "contact"
  | "category"
  | "listing"
  | "about"
  | "docs"
  | "other";

export interface AiParseRequest {
  auditId?: string;
  pages: CloudPagePayload[];
}

export interface AiParseResult {
  url: string;
  pageType: AiParsePageType;
  parsabilityScore: number;
  confidence: number;
}

export interface AiParseResponse {
  results: AiParseResult[];
}

// --- authority-signals ----------------------------------------------------

export interface AuthorityRequest {
  auditId?: string;
  pages: CloudPagePayload[];
}

export interface AuthorityResult {
  url: string;
  authorPresent: boolean;
  citationCount: number;
  outboundLinkCount: number;
  signals: string[];
}

export interface AuthorityResponse {
  results: AuthorityResult[];
}

// --- dead-links -------------------------------------------------------------

export interface DeadLinksRequest {
  auditId?: string;
  urls: string[];
}

export interface DeadLinkResult {
  url: string;
  ok: boolean;
  /** HTTP status, or null for a transport failure. */
  status: number | null;
  redirectUrl?: string | null;
  error?: string | null;
  /** Served from the shared global cache (no fresh fetch this run). */
  fromCache: boolean;
}

export interface DeadLinksResponse {
  results: DeadLinkResult[];
}

// --- blocklist-check --------------------------------------------------------

export interface BlocklistCheckRequest {
  auditId?: string;
  /** Outbound link / resource URLs to match against network filter rules. */
  urls?: string[];
  /** CSS selectors (classes/ids) present on pages, matched against cosmetic rules. */
  selectors?: string[];
}

export interface BlocklistMatch {
  /** The url or selector that matched. */
  value: string;
  kind: "url" | "selector";
  list: "easylist" | "easyprivacy";
  /** The filter rule that matched (for display). */
  rule?: string;
}

export interface BlocklistCheckResponse {
  matches: BlocklistMatch[];
  /** Version/date stamp of the server-side lists used. */
  listsVersion: string;
}

// --- keyword-gaps -----------------------------------------------------------

export interface KeywordGapsRequest {
  auditId?: string;
  /** Site apex domain (e.g. example.com). */
  domain: string;
  /** ISO country (default "US"). */
  country?: string;
  /** Language code (default "en"). */
  language?: string;
  /** Competitor domains to compare against (config-provided). */
  competitors?: string[];
  /** Seed keywords (from site titles/headings). */
  seedKeywords?: string[];
}

export interface KeywordGapItem {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  competition: number | null;
}

export interface KeywordGapsResponse {
  gaps: KeywordGapItem[];
  summary: string;
}

// --- content-gaps -----------------------------------------------------------

export interface ContentGapsRequest {
  auditId?: string;
  domain: string;
  country?: string;
  language?: string;
  competitors?: string[];
  /** Topics the site already covers (from titles/headings). */
  coveredTopics?: string[];
}

export interface ContentGapItem {
  topic: string;
  volume: number | null;
  reason: string;
}

export interface ContentGapsResponse {
  gaps: ContentGapItem[];
  summary: string;
}

// --- tech-detect ------------------------------------------------------------
// Deterministic, server-side technology fingerprinting (run-unit feature
// `tech_detect`). The CLI sends a slim sample of crawled pages (home page +
// a few others) carrying response headers, raw HTML, and discovered script
// URLs/content. The server runs the fingerprint engine, persists a per-(org,
// domain) snapshot, and returns the current stack plus the added/removed diff
// vs the org's previous scan of that domain. Report-only — never scores.

/** One page's raw signals for fingerprinting. HTML is capped server-side. */
export interface TechDetectPagePayload {
  url: string;
  /** Lowercased response header name → value (subset relevant to detection). */
  headers?: Record<string, string>;
  /** Raw HTML (caller pre-caps; server re-caps defensively). */
  html: string;
  /** Discovered scripts — URL always, content only for small inline/critical. */
  scripts?: { url: string; content?: string }[];
  /** <meta name> → content. */
  meta?: Record<string, string>;
}

export interface TechDetectRequest {
  auditId?: string;
  /** Optional registered website id (unused for diffing — domain is the key). */
  websiteId?: string;
  /** Site base URL — its apex/host is the per-org snapshot key. */
  url: string;
  /** Sampled pages (first entry SHOULD be the home page). */
  pages: TechDetectPagePayload[];
}

export interface TechDetectResponse {
  /** Current detected stack. */
  technologies: ReportTechnology[];
  /** techIds newly seen since the org's previous scan of this domain. */
  added: string[];
  /** techIds present previously but absent now. */
  removed: string[];
  /** True when this is the first scan recorded globally for this domain. */
  firstScan: boolean;
  /** Scaffold — always empty today (see plans/technology-version-security.md). */
  advisories?: SoftwareAdvisory[];
}

// --- editor-summary ---------------------------------------------------------
// An auto-generated "editor's-style" audit summary (credit-only, any signed-in
// plan), framed like a
// quick exec-email to management: prose narrative + point-form big-ticket items.
// ONE Sonnet 4.6 call per audit from the audit aggregate. Credited,
// report-only / non-scoring. The CLI sends a slim, pre-aggregated digest (never
// the full report) — the server is a thin, untrusted wrapper around the model.

/** One audit-category score line fed to the summary model. */
export interface EditorSummaryCategoryInput {
  /** Category code (e.g. "security"). */
  category: string;
  /** Human label (e.g. "Security"). */
  name: string;
  /** 0–100 category score. */
  score: number;
  failed: number;
  warnings: number;
}

/** One top issue fed to the summary model (already ranked by the CLI). */
export interface EditorSummaryIssueInput {
  ruleId: string;
  title: string;
  category: string;
  /** "error" (fail) or "warning". */
  severity: "error" | "warning";
  /** Rule weight — higher = bigger score impact. */
  weight: number;
  /** Pages/occurrences affected by this rule, when known. */
  occurrences?: number;
}

/**
 * Optional deltas vs the previous audit of the same site. Omit entirely when no
 * prior run is available — the model degrades to a first-run framing.
 */
export interface EditorSummaryDeltaInput {
  previousHealthScore?: number | null;
  previousFailed?: number | null;
  previousWarnings?: number | null;
}

export interface EditorSummaryRequest {
  auditId?: string;
  websiteId?: string;
  /** Site base URL — its apex/host is the idempotency/ref key. */
  url: string;
  /** Overall 0–100 health score (null when unscored). */
  healthScore: number | null;
  totalPages: number;
  passed: number;
  warnings: number;
  failed: number;
  /** Per-category scores (CLI pre-caps to the worst few). */
  categories: EditorSummaryCategoryInput[];
  /** Highest-impact issues, pre-ranked + pre-capped by the CLI. */
  topIssues: EditorSummaryIssueInput[];
  /** Deltas vs the previous audit, when the CLI has a prior run. */
  delta?: EditorSummaryDeltaInput;
  /**
   * Resolved Stage-0 site-metadata profile for framing (site type, identity,
   * audience). Slimmed by the CLI; absent when no metadata was resolved.
   */
  siteProfile?: EditorSummarySiteProfile;
}

/** Slim site-metadata context for the summary prompt (never the full profile). */
export interface EditorSummarySiteProfile {
  siteType?: string | null;
  businessCategory?: string | null;
  audienceScope?: string | null;
  primaryCountry?: string | null;
  entityName?: string | null;
  isYMYL?: boolean;
  isLocalBusiness?: boolean;
}

/**
 * The generated summary. `prose` is 2–3 short exec-email paragraphs; `bigTicket`
 * is the point-form list of highest-impact action items. `verdict` is a single
 * one-line bottom-line. Report-only — NEVER affects the health score.
 */
export interface EditorSummaryResponse {
  /** 2–3 short prose paragraphs (joined by blank lines). */
  prose: string;
  /** Point-form big-ticket items (highest-impact things to act on). */
  bigTicket: string[];
  /** One-line bottom-line verdict. */
  verdict: string;
  /** Model id that produced this (e.g. "google/gemini-3.1-flash-lite"). */
  model: string;
  /** ISO timestamp the summary was generated. */
  generatedAt: string;
  /**
   * Served from the digest content cache (#1012) — no fresh provider call;
   * `generatedAt` is the original generation time. Absent on fresh results.
   */
  cached?: boolean;
}

// --- domain-stats -----------------------------------------------------------
// Credited domain-level SEO stats (#111, credit-only, any signed-in plan): ONE DataForSEO
// whois/overview lookup per domain → backlink SUMMARY totals + organic/paid
// traffic + keyword distribution. Summary stats ONLY (no full backlink crawl).
// Report-only / non-scoring. 30-day per-domain cache → a repeat audit of the
// same domain in-window is a 0-credit cache hit. History snapshots fill the
// dashboard trend graphs (schema shared with GSC #103).

export interface DomainStatsRequest {
  auditId?: string;
  websiteId?: string;
  /** Site base URL — its apex/host is the per-domain snapshot/cache key. */
  url: string;
  /** ISO country for traffic/keyword metrics (default "US"). */
  country?: string;
}

export interface DomainStatsResponse {
  /** Normalized domain the stats are for. */
  domain: string;
  metrics: DomainStatsMetrics;
  /** ISO timestamp the snapshot was captured. */
  capturedAt: string;
  /** Served from the 30-day per-domain cache (no fresh provider call). */
  cached: boolean;
}

/** One point-in-time snapshot for the dashboard trend graphs. */
export interface DomainStatsSnapshot {
  metrics: DomainStatsMetrics;
  /** ISO timestamp the snapshot was captured. */
  capturedAt: string;
}

/**
 * Dashboard read: the latest snapshot + the full history series for a domain.
 * PUBLIC PROJECTION — provenance (org/audit) is never exposed.
 */
export interface DomainStatsHistoryResponse {
  domain: string;
  latest: DomainStatsSnapshot | null;
  history: DomainStatsSnapshot[];
  /** True when the history series was capped (more rows exist). */
  hasMore: boolean;
}

// --- archive-indexing ---------------------------------------------------------
// Archive Indexing (#789, Pro): is the site present in the web archives that
// feed AI training corpora? Two independent lookups per domain — the Wayback
// Machine availability API and the latest Common Crawl CDX index. They are NOT
// subsets of each other: Common Crawl runs its own crawler (CCBot) and the
// Internet Archive ingests CC's crawls, so a Wayback snapshot does not imply
// CC inclusion. Per-domain snapshot cache: negative results re-check after 7
// days, positive after 30. Report via ax/archive-indexing.

export interface ArchiveIndexingRequest {
  auditId?: string;
  /** Site base URL — its apex/host is the per-domain snapshot/cache key. */
  url: string;
}

/** One archive's verdict for the domain. */
export interface ArchivePresence {
  /** At least one capture of the domain exists in this archive. */
  indexed: boolean;
  /** ISO timestamp of the most recent capture found (absent when not indexed). */
  latestCapture?: string;
  /** Human id of the index consulted (e.g. Common Crawl "CC-MAIN-2026-26"). */
  source?: string;
}

export interface ArchiveIndexingResponse {
  /** Normalized domain the lookups ran against. */
  domain: string;
  wayback: ArchivePresence;
  commonCrawl: ArchivePresence;
  /** ISO timestamp the snapshot was captured. */
  capturedAt: string;
  /** Served from the per-domain cache (no fresh archive lookups). */
  cached: boolean;
}

// --- render -----------------------------------------------------------------

export interface RenderRequest {
  urls: string[];
  /** Per-page render timeout. Server clamps to BROWSER_QUEUE bounds. */
  timeoutMs?: number;
  /**
   * Cloud run this render batch belongs to (#1134). Tags the render debit with
   * `metadata.runId` + `ref_id` so per-audit credit accounting can attribute
   * rendered-page spend to the run. Optional + backward-compatible: the CLI's
   * dualAuth render path (which carries no server-side run context) supplies it
   * so its debits stop landing untagged; container runs already carry the run
   * via the internal-auth header, so it's redundant-but-harmless there.
   */
  runId?: string;
  /**
   * Optional client-computed sha256 (64 lowercase hex) of each url's RAW source,
   * keyed by url (render cache, #822). Used ONLY as a fallback when the server's
   * own source probe can't reach the origin (e.g. a Cloudflare bot wall 403s our
   * API-worker egress) — the server probe stays authoritative when it succeeds.
   * Entries for urls not in `urls`, or that aren't 64-hex, are ignored.
   */
  sourceHashes?: Record<string, string>;
}

/** One per-feature debit line for a render batch (render misses vs render_cached hits). #279 */
export interface RenderChargeLine {
  feature: "render" | "render_cached";
  units: number;
  credits: number;
}

export interface RenderJobResponse {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  /** Credits actually debited at submit (render misses + render_cached hits); absent on older servers. */
  charged?: number;
  /** Per-feature debit split so the CLI shows render_cached cache savings as its own line; absent on older servers. #279 */
  chargedBreakdown?: RenderChargeLine[];
}

export interface RenderResultItem {
  url: string;
  status: number | null;
  html?: string;
  /** Response headers from the browser render (lowercase keys). Absent on failure. */
  headers?: Record<string, string>;
  error?: string | null;
  redirectChain?: { url: string; status: number }[];
  /** Browser render cost only, mirrored from crawler-worker. Absent on a render-cache hit (#826). */
  renderTimeMs?: number;
  /** Queue delivery lag + browser-pool acquisition + concurrency-slot wait before rendering started. Absent on a render-cache hit (#826). */
  queueWaitMs?: number;
}

export interface RenderResultResponse {
  jobId: string;
  status: "queued" | "running" | "done" | "error";
  results?: RenderResultItem[];
  /**
   * Per-item early delivery (#992): on a NON-terminal poll (`queued`/`running`),
   * the items for jobs that already reached a per-job-terminal state
   * (completed/cached/failed) so the client can settle those pages' waiters
   * without waiting for the batch's slowest render. Additive + optional: absent
   * on older servers and on terminal responses (which carry everything in
   * `results`). `missing` jobs are NOT surfaced here — early in the poll window a
   * job may simply not be registered yet, so its terminal semantics are decided
   * only by the batch-level aggregation.
   */
  completed?: RenderResultItem[];
  error?: string | null;
}

// --- shared error envelope ------------------------------------------------

/** Typed error envelope from `/v1/services/*` (#214); `required` rides on 402s. */
export interface CloudServiceError {
  error: {
    code: string;
    message: string;
    required?: number;
  };
}
