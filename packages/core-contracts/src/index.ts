// Re-export all storage types (CrawlStorage, PageRecord, etc.)
export * from "./storage";

// Cache-stats aggregation helper (#108).
export * from "./cache-stats";

// Plans, credits, and service limits.
export * from "./plans";
export * from "./credits";
export * from "./limits";
export * from "./clamp";

// Org-scoped API keys — token format, env→prefix map, scopes (shared by
// API mint/parse, dashboard display, CLI precedence).
export * from "./api-keys";

// Cloud-service request/response contracts.
export * from "./services";

// Site-metadata cloud-service contracts (enums + SiteMetadata profile).
export * from "./site-metadata";

// Threat-intel contracts (#117) — feeds, lookups, signatures, ctx.intel handle.
export * from "./threat-intel";

// #1185: unsampled publish resolution signal (type + hash).
export * from "./resolution";

// Import storage types needed locally by interfaces in this file
import type {
  AgentAccessProbe,
  CacheHitReason,
  CacheStats,
  RslLicenseDoc,
  SecurityHeaders,
  WellKnownProbe,
} from "./storage";
import type { SiteMetadata } from "./site-metadata";
import type { ResolutionSignal } from "./resolution";

export interface CheckItem {
  id: string;
  label?: string;
  snippet?: string;
  sourcePages?: string[];
  meta?: Record<string, unknown>;
}

export type CheckStatus = "pass" | "warn" | "fail" | "info" | "skipped";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  pageUrl?: string;
  items?: CheckItem[];
  details?: Record<string, unknown>;
  pages?: string[];
  value?: string | number | null;
  expected?: string | number | null;
  skipReason?: string;
  /**
   * Smart audits (#110): provenance for findings carried across audits.
   * `carried` = re-injected from the per-page store for a page not re-crawled
   * this run; absent / `fresh` = evaluated this run. `lastSeenAt` = epoch ms of
   * the last run that observed it. Only set when `smart_audits` is enabled.
   */
  provenance?: "fresh" | "carried";
  lastSeenAt?: number;
}

export type RuleScope = "page" | "site";
export type RuleSeverity = "error" | "warning" | "info";

export interface RuleMetaLite {
  id: string;
  name: string;
  description: string;
  solution?: string;
  category: string;
  /** Optional sub-group within a category (e.g. blocking → "ad" | "privacy"). */
  subcategory?: string;
  scope: RuleScope;
  severity: RuleSeverity;
  weight: number;
}

export interface ReportRuleResult {
  meta: RuleMetaLite;
  checks: CheckResult[];
}

/**
 * Legacy category-code aliases. Reports stored before a category rename keep
 * the old code; normalize before display/grouping. `adblock` → `blocking`,
 * `ai` → `ax` (AI Analysis folded into Agent Experience).
 *
 * CANONICAL definition. Mirrored (intentionally, to keep those packages
 * dep-light) in packages/rules/src/categories.ts,
 * packages/report/src/categories.ts, and packages/utils/src/rule-pattern.ts
 * (the alias-aware matcher) — update all four together when adding an alias
 * (guarded by apps/cli/tests/rules/category-alias-consistency.test.ts).
 * (Dedup into a single source is a tracked follow-up.)
 */
const CATEGORY_ALIASES: Record<string, string> = { adblock: "blocking", ai: "ax" };

/** Map a (possibly legacy) category code to its current canonical code. */
export function normalizeCategoryCode(code: string): string {
  return CATEGORY_ALIASES[code] ?? code;
}

/**
 * Derive a blocking subcategory for legacy reports whose rule meta predates the
 * `subcategory` field. Keyed on the stable blocking rule IDs.
 *
 * New blocking rules MUST set `meta.subcategory` directly — this backfill only
 * covers reports stored before that field existed, so a new `adblock/*` rule
 * not listed here would render without a sub-group for those old reports.
 */
export function deriveBlockingSubcategory(ruleId: string): string | undefined {
  if (ruleId === "adblock/privacy-blocked") return "privacy";
  if (ruleId === "adblock/blocked-links" || ruleId === "adblock/element-hiding") {
    return "ad";
  }
  return undefined;
}

/** Rule category codes — kept in sync with packages/rules/src/categories.ts */
export type RuleCategory =
  | "crawl"
  | "core"
  | "security"
  | "integrity"
  | "links"
  | "content"
  | "schema"
  | "images"
  | "perf"
  | "social"
  | "a11y"
  | "mobile"
  | "url"
  | "i18n"
  | "eeat"
  | "legal"
  | "local"
  | "video"
  | "analytics"
  | "ax"
  | "blocking"
  | "gaps"
  | "other";

/**
 * Top-level rule groups (#626): a coarse layer above the 23 categories. Every
 * category maps to exactly one group. Kept in sync with the `group` field on
 * CATEGORIES in packages/rules/src/categories.ts (canonical) and its dep-free
 * mirror packages/report/src/categories.ts.
 */
export type RuleGroup = "seo" | "performance" | "security" | "ai";

export interface CategoryScore {
  category: RuleCategory;
  name: string;
  score: number;
  passed: number;
  warnings: number;
  failed: number;
  total: number;
}

/**
 * Per-group aggregate score (#626) — the same shape as {@link CategoryScore},
 * summed over the categories in the group. `score` uses the same pass-ratio +
 * curve treatment as a category (no site-level penalties, which apply to
 * `overall` only).
 */
export interface GroupScore {
  group: RuleGroup;
  name: string;
  score: number;
  passed: number;
  warnings: number;
  failed: number;
  total: number;
}

export interface HealthScore {
  /** null when no real audit happened (0 pages / down / blocked) — N/A, not 0 (#586). */
  overall: number | null;
  categories: CategoryScore[];
  /**
   * Per-group aggregates (#626), coarser than `categories`. Optional for
   * back-compat: reports stored before #626 lack it (renderers read `?? []`).
   * `calculateHealthScore` always populates it.
   */
  groups?: GroupScore[];
  errorCount: number;
  warningCount: number;
  passedCount: number;
  debug?: {
    base: number;
    curved: number;
    penalties: number;
    issuePenalty?: number;
    issueDensity?: number;
  };
}

/**
 * Whether a real audit actually happened. `failed`/`blocked` mean there was
 * effectively no auditable content (site down/DNS-fail/0 pages, or every page
 * was blocked by a 403/bot-wall) — renderers show this state instead of a
 * meaningless grade. `partial` = a real audit, but some pages were blocked or
 * carried-forward. Absent ⇒ treat as `completed` (back-compat for older reports).
 */
export type AuditStatus = "completed" | "failed" | "blocked" | "partial";

/**
 * Collapse an {@link AuditStatus} onto the coarse lifecycle status used by the
 * stored audit record / DO (which has no `blocked`/`partial`): `failed` and
 * `blocked` → `"failed"`; everything else → `"completed"`. So a blocked/down
 * audit surfaces a failure badge in the dashboard audit list, not a 0%/F
 * "completed" row (#489).
 */
export function auditStatusToLifecycle(
  status: AuditStatus | null | undefined,
): "completed" | "failed" {
  return status === "failed" || status === "blocked" ? "failed" : "completed";
}

export interface AuditReport {
  crawlId?: string;
  baseUrl: string;
  timestamp: string;
  totalPages: number;
  passed: number;
  warnings: number;
  failed: number;
  /**
   * Audit validity (see {@link AuditStatus}). Set only when NOT `completed`;
   * absent ⇒ `completed`. Renderers suppress the grade ring for `failed`/`blocked`.
   */
  status?: AuditStatus;
  /** Short human reason shown when `status` is failed/blocked (e.g. "No pages were crawled"). */
  statusReason?: string;
  healthScore?: HealthScore;
  ruleResults: Record<string, ReportRuleResult>;
  /**
   * Detected technology stack — a REPORT-ONLY section, surfaced separately from
   * issues at the top of the report. It NEVER contributes to `healthScore`
   * (scoring is computed solely from ruleResults/categories). Present only when
   * the credited cloud tech-detect ran (logged-in users); absent otherwise.
   */
  technologies?: ReportTechnologies;
  /**
   * Resolved site-metadata "profile" (site type, business category, country,
   * audience, identity, contacts, socials, domain age). Like `technologies`,
   * it is a REPORT-ONLY section that NEVER contributes to `healthScore`.
   * Present only when the credited Stage-0 cloud metadata call ran (or a fresh
   * cache hit); absent for anonymous/offline runs.
   */
  siteMetadata?: SiteMetadata;
  /**
   * Auto-generated "editor's-style" audit summary — prose narrative + point-form
   * big-ticket items, framed like a quick exec-email to management. Like
   * `technologies` / `siteMetadata`, a REPORT-ONLY section surfaced at the TOP of
   * the report that NEVER contributes to `healthScore`. Present only when the
   * credited cloud editor-summary call ran (any logged-in plan);
   * absent for anonymous/offline runs.
   */
  editorSummary?: EditorSummary;
  /**
   * Domain-level SEO stats (#111): backlink summary totals + organic/paid traffic
   * + keyword distribution from the credited cloud domain-stats call
   * (one DataForSEO whois/overview lookup). Like `technologies` / `siteMetadata`,
   * a REPORT-ONLY section that NEVER contributes to `healthScore`. Present for
   * any logged-in plan (or a fresh 30-day cache hit); absent otherwise.
   */
  domainStats?: DomainStats;
  /**
   * Smart audits (#110): present only when the `smart_audits` flag is on. The
   * health score + ruleResults cover the UNION of all known non-removed pages;
   * `auditedPages` of `knownPages` were freshly re-crawled this run, the rest
   * carried forward. Surfaced as a coverage line so a partial re-audit reads as
   * "audited N of M known pages" rather than silently dropping issues.
   */
  coverage?: {
    auditedPages: number;
    knownPages: number;
    carriedFindings: number;
  };
  /**
   * Scan scope disclosure (#1180): where the audit ran and how much of the site
   * it crawled, so a score always reads with its basis ("crawled 100 of 505
   * known pages, capped at 100"). `capped` = the page limit was the binding
   * constraint, driving the "run a full scan for a full-site score" hint.
   * REPORT-ONLY — never feeds `healthScore`. Absent on pre-#1180 reports.
   */
  scanScope?: ScanScope;
  /**
   * Smart audits CLOUD (#195): compact per-page HTTP status for THIS run, used
   * by the server-side finding merge at publish. `pages[]` is dropped on publish
   * (renderers use `ruleResults`), so this is the only signal the API has to tell
   * a page that 404/410'd this run (→ stale its carried findings) from an
   * un-crawled page (→ carry findings forward). Populated by the CLI publish path
   * only; absent → the server derives crawled pages from `ruleResults` check
   * `pageUrl`s and skips removed-page detection (carry-only). Capped to the
   * publish page limit. Like other publish-transport context it NEVER feeds
   * `healthScore` directly — it only shapes the cross-audit merge.
   */
  pageStatuses?: Array<{ url: string; status: number }>;
  /**
   * Smart audits CLOUD (#1185): compact UNSAMPLED per-run resolution signal —
   * crawled-URL list + per-rule-check failing-page hash sets — attached by the
   * publish producers BEFORE #1167 sampling clips `pages[]`, so the server
   * merge can resolve findings on pages crawled clean this run even when they
   * were clipped out of every check's published sample. Absent for older
   * CLIs/containers and local runs → the merge behaves exactly as pre-#1185.
   * Transport-only: NEVER rendered, NEVER feeds `healthScore` directly.
   */
  resolutionSignal?: ResolutionSignal;
  /**
   * Aggregate crawl-cache stats for this audit — hit rate, bytes saved, and a
   * hits-by-reason breakdown across pages AND sub-resources (#108). Derived from
   * the crawl + sub-resource cache results via `buildCacheStats`. Present only
   * for incremental re-audits with cache reuse; absent on a first/cold run.
   * REPORT-ONLY context — NEVER contributes to `healthScore`.
   */
  cacheStats?: CacheStats;
  /**
   * Resolved, absolute URL of the website's full-page screenshot in R2/assets
   * (`getScreenshotUrl(websiteId)`), injected into the rendered public HTML at
   * publish time so the report shows the screenshot ALONGSIDE the category
   * reports. A REPORT-ONLY field that NEVER contributes to `healthScore`.
   * Optional and backward-compatible: absent for local/offline/logged-out runs
   * and for reports published before this field existed — renderers show
   * nothing then. The image may 404 (screenshot capture is async/best-effort)
   * so the renderer hides it on load error.
   */
  screenshotUrl?: string;
  /**
   * Homepage <title>/<meta description> carried through publish (full `pages[]`
   * is dropped) so the API can seed the website record AND the report header can
   * show the site's real title/description. Set by the CLI publish path; absent
   * for local/offline runs. REPORT-ONLY — never feeds `healthScore`.
   */
  homepage?: { title: string | null; description: string | null };
  /**
   * Version of the generator (`squirrel` CLI) that produced this report, shown
   * in the report footer. Optional + backward-compatible: absent for reports
   * generated before this field existed.
   */
  generatorVersion?: string;
  /**
   * Cloud-/Pro-gated rules that did NOT run this audit (free/offline runs skip
   * the credited cloud services). Surfaced at the bottom of the report as a
   * "locked" upsell. REPORT-ONLY. Empty/absent → no upsell shown (e.g. a Pro run
   * that exercised every cloud check). Computed by the CLI publish path.
   */
  lockedRules?: LockedRule[];
  /**
   * Account tier that generated this report (#368). Drives the locked-rules
   * messaging: signed-in ("free"/"paid") runs never show the "get a free
   * account" upsell. REPORT-ONLY. Absent → treated as "anonymous" (the legacy
   * free-account upsell), keeping old reports rendering as before.
   */
  cloudPlan?: CloudPlanTier;
  /**
   * Resolved cloud fetch mode for this run (#368). "http" = the user opted out of
   * cloud rendering (--http / [cloud] rendering = "http"), so locked cloud checks
   * are a deliberate choice — never framed as "temporarily unavailable". REPORT-ONLY.
   */
  cloudMode?: CloudRenderMode;
  /**
   * Coverage mode this audit ran with (#747). CLI quick coverage skips ALL
   * cloud enrichment by design, so the renderer frames locked cloud rules as a
   * coverage choice ("re-run with -C surface/full") — never a cloud outage.
   * Stamped by the CLI publish path only; absent for cloud-triggered runs
   * (cloud enrichment runs there regardless of coverage) and pre-#747 reports,
   * which keep the legacy messaging. REPORT-ONLY.
   */
  coverageMode?: CoverageMode;
  /**
   * Render-block recovery summary (#512/#490): pages whose browser/cloud render
   * was blocked (403/WAF) and were recovered via a non-browser fallback fetch.
   * Surfaced as an informational note. REPORT-ONLY — never feeds `healthScore`.
   * Absent when nothing was recovered.
   */
  fetchFallbacks?: { recovered: number };
}

/** Where an audit executed + how much of the site it crawled (#1180). */
export interface ScanScope {
  /** "cli" = local machine, "ci" = CI runner, "cloud" = squirrelscan cloud container. */
  origin: "cli" | "ci" | "cloud";
  /** Page cap in effect for this run; absent when the runner had no cap. */
  maxPages?: number;
  /** Pages freshly crawled this run (the report.pages basis, before publish drops pages[]). */
  pagesCrawled: number;
  /** The page cap was the binding constraint — the site likely has more pages. */
  capped: boolean;
}

/** Locked-rules audience for a report — anonymous/local vs signed-in tier (#368). */
export type CloudPlanTier = "anonymous" | "free" | "paid";

/** Resolved cloud fetch mode stamped on a report — plain HTTP vs browser render (#368). */
export type CloudRenderMode = "http" | "browser";

/** A cloud-/Pro-gated rule that was not run — shown locked in the report upsell. */
export interface LockedRule {
  id: string;
  name: string;
}

/**
 * Report-stored editor's summary (the persisted slice of `EditorSummaryResponse`
 * — drops the transport-only fields not needed by renderers). Exec-email shape:
 * prose paragraphs + point-form big-ticket items + a one-line verdict.
 */
export interface EditorSummary {
  /** 2–3 short prose paragraphs (joined by blank lines). */
  prose: string;
  /** Point-form big-ticket items (highest-impact things to act on). */
  bigTicket: string[];
  /** One-line bottom-line verdict. */
  verdict: string;
  /** Model id that produced this. */
  model: string;
  /** ISO timestamp the summary was generated. */
  generatedAt: string;
}

// ── Domain stats (report-only, non-scoring) ───────────────────────

/**
 * Organic SERP position distribution buckets, as returned by DataForSEO's
 * whois/overview `metrics.organic`. Each is the count of keywords the domain
 * ranks for in that position band. Null = not reported for the domain.
 */
export interface DomainStatsPositions {
  pos1: number | null;
  pos2_3: number | null;
  pos4_10: number | null;
  pos11_20: number | null;
  pos21_30: number | null;
  pos31_40: number | null;
  pos41_50: number | null;
  pos51_60: number | null;
  pos61_70: number | null;
  pos71_80: number | null;
  pos81_90: number | null;
  pos91_100: number | null;
}

/**
 * Domain-level SEO metrics — backlink SUMMARY totals + organic/paid traffic +
 * keyword distribution. Summary stats ONLY: NO full backlink crawl (no anchors,
 * referring-page lists, or link-level new/lost). Every field is nullable: the
 * provider omits metrics it can't resolve for a domain. Shared shape across the
 * cloud response, the report section, and the history snapshot blob.
 */
export interface DomainStatsMetrics {
  // ── Backlink summary (DataForSEO backlinks_info) ──
  /** Total backlinks pointing at the domain. */
  backlinks: number | null;
  /** Distinct referring domains. */
  referringDomains: number | null;
  /** Distinct referring registered (main) domains. */
  referringMainDomains: number | null;
  /** Distinct referring pages. */
  referringPages: number | null;
  /** Dofollow backlinks. */
  dofollow: number | null;
  /** Domain rank (0–1000 backlink-authority scale). */
  rank: number | null;
  /** ISO timestamp the provider's backlink index was last updated. */
  backlinksUpdatedAt: string | null;
  // ── Organic search/traffic (DataForSEO metrics.organic) ──
  /** Ranked organic keyword count (SERP results the domain appears in). */
  organicKeywords: number | null;
  /** Estimated monthly organic traffic (etv). */
  organicTraffic: number | null;
  /** Estimated monthly organic impressions (impressions_etv). */
  organicImpressions: number | null;
  /** Organic SERP position distribution. */
  positions: DomainStatsPositions | null;
  // ── Paid search (DataForSEO metrics.paid) ──
  /** Ranked paid keyword count. */
  paidKeywords: number | null;
  /** Estimated monthly paid traffic (etv). */
  paidTraffic: number | null;
  /** Estimated monthly paid traffic cost (USD). */
  paidTrafficCost: number | null;
}

/**
 * Report-stored domain stats — the persisted slice of `DomainStatsResponse`
 * (drops transport-only fields). A REPORT-ONLY section that NEVER affects the
 * health score.
 */
export interface DomainStats {
  /** Normalized domain the stats are for (lowercase host, no leading www). */
  domain: string;
  metrics: DomainStatsMetrics;
  /** ISO timestamp the snapshot was captured. */
  capturedAt: string;
}

// ── Technologies (report-only, non-scoring) ───────────────────────

/** Coarse technology grouping. Mirrors @squirrelscan/tech-detect's TechCategory. */
export type TechnologyCategory =
  | "cms"
  | "framework"
  | "analytics"
  | "cdn"
  | "ad-network"
  | "payment"
  | "web-server"
  | "hosting"
  | "security"
  | "tag-manager"
  | "chat"
  | "font"
  | "video"
  | "widget"
  | "other";

/** A single detected technology, serializable for the report + cloud transport. */
export interface ReportTechnology {
  id: string;
  name: string;
  category: TechnologyCategory;
  /** Resolved version when a versionPattern matched, else null. */
  version: string | null;
  confidence: "high" | "medium" | "low";
  /** Short label of the detector that matched (e.g. "html:cdn.shopify.com"). */
  detectedBy: string;
  /** Vendor homepage (for report links). */
  website?: string;
  /** Icon slug (logo asset key). */
  icon?: string;
}

/**
 * Forward-looking software-version advisory. SCAFFOLD ONLY for now — the
 * detector never emits these yet (see plans/technology-version-security.md).
 * When implemented it maps a detected (tech, version) to known EOL / CVE data.
 */
export interface SoftwareAdvisory {
  techId: string;
  techName: string;
  installedVersion: string | null;
  /** "info" until severity scoring exists. */
  severity: "info" | "low" | "medium" | "high" | "critical";
  kind: "outdated" | "eol" | "vulnerability";
  title: string;
  detail?: string;
  /** Associated CVE identifiers, when kind === "vulnerability". */
  cve?: string[];
  /** Earliest non-vulnerable / supported version, when known. */
  fixedVersion?: string | null;
  reference?: string;
}

/** The report-level technologies section: current stack + change tracking. */
export interface ReportTechnologies {
  /** Current detected stack (sorted by category then name by the renderer). */
  items: ReportTechnology[];
  /** techIds newly seen since this org's previous scan of the domain. */
  added: string[];
  /** techIds present in the previous scan but gone now. */
  removed: string[];
  /** True when this is the first scan recorded globally for this domain. */
  firstScan: boolean;
  /**
   * Software-version advisories. Empty/absent today (scaffold). Surfaced as a
   * future report sub-section; will NOT affect healthScore unless a later
   * decision wires version-security into the security category.
   */
  advisories?: SoftwareAdvisory[];
  /** ISO timestamp of the scan that produced this snapshot. */
  scannedAt?: string;
}

// RedirectHop and RedirectChain are now in ./storage.ts (re-exported above)

export type CrawlerEvent =
  | { type: "started"; crawlId: string; baseUrl: string; timestamp: number }
  | { type: "page:fetching"; url: string; depth: number; timestamp: number }
  | {
      type: "page:fetched";
      url: string;
      status: number;
      loadTimeMs: number;
      ttfbMs?: number;
      sizeBytes: number;
      depth: number;
      fetcherId?: string;
      rendered?: boolean;
      timestamp: number;
      /** Browser render cost only, set only for browser-queue-rendered pages (#826). */
      renderTimeMs?: number;
      /** Queue delivery lag + browser-pool acquisition + concurrency-slot wait, set only for browser-queue-rendered pages (#826). */
      queueWaitMs?: number;
    }
  | {
      type: "page:failed";
      url: string;
      error: string;
      retryable: boolean;
      depth: number;
      timestamp: number;
    }
  | {
      type: "page:skipped";
      url: string;
      reason: string;
      depth: number;
      timestamp: number;
    }
  | {
      type: "page:unchanged";
      url: string;
      reason:
        | "304"
        | "hash_match"
        | "etag_match"
        | "max-age"
        | "s-maxage"
        | "expires"
        | "immutable"
        | "stale-while-revalidate";
      depth: number;
      timestamp: number;
    }
  | {
      type: "url:discovered";
      url: string;
      fromUrl: string;
      depth: number;
      timestamp: number;
    }
  | {
      type: "url:enqueued";
      url: string;
      priority: number;
      source: "seed" | "sitemap" | "discovered" | "carried";
      depth: number;
      timestamp: number;
    }
  | {
      type: "progress";
      fetched: number;
      pending: number;
      failed: number;
      skipped: number;
      unchanged: number;
      total: number;
      bytesTotal: number;
      avgLoadTimeMs: number;
      timestamp: number;
    }
  | { type: "paused"; reason: string; timestamp: number }
  | { type: "resumed"; timestamp: number }
  | {
      type: "completed";
      stats: {
        pagesFetched: number;
        pagesFailed: number;
        pagesSkipped: number;
        pagesUnchanged: number;
        bytesTotal: number;
        avgLoadTimeMs: number;
      };
      durationMs: number;
      timestamp: number;
    }
  | { type: "error"; error: string; fatal: boolean; timestamp: number };

export interface AuditLifecycleEvent {
  type:
    | "audit:started"
    | "audit:crawling"
    | "audit:external-links"
    | "audit:rules"
    | "audit:report"
    | "audit:completed"
    | "audit:failed";
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface ComponentError {
  code: string;
  message: string;
  cause?: unknown;
}

export type CompletionReason =
  | "success"
  | "timeout"
  | "turn_limit"
  | "credit_cap"
  | "credit_limit"
  | "user_cancel"
  | "error"
  | "container_exit"
  | "context_overflow"
  | "stale";

export type UsageMetric =
  | "audits"
  | "pages"
  | "fixes"
  | "input_tokens"
  | "output_tokens"
  | "llm_cost"
  | "infra_cost";

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
  remaining?: Partial<Record<UsageMetric, number>>;
}

export interface UsageEvent {
  idempotencyKey: string;
  userId: string;
  runId?: string;
  crawlId?: string;
  metric: UsageMetric;
  quantity: number;
  unit: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditIssueAggregate {
  category: string;
  severity: "error" | "warning" | "info";
  count: number;
}

export interface AuditHistorySnapshot {
  runId: string;
  siteKey: string;
  url: string;
  score: number | null;
  issuesFound: number;
  auditedAt: string;
  createdAt: string;
  issueAggregates: AuditIssueAggregate[];
}

export interface AuditHistoryDelta {
  runId: string;
  previousRunId: string | null;
  scoreDelta: number | null;
  issueDelta: number | null;
}

export interface AuditHistorySite {
  siteKey: string;
  canonicalUrl: string;
  latestRunId: string;
  latestAuditedAt: string;
  latestScore: number | null;
  latestIssueCount: number;
}

export interface AuditHistoryStore {
  upsertSnapshot(userId: string, snapshot: AuditHistorySnapshot): Promise<void>;
  listSites(userId: string, limit?: number): Promise<AuditHistorySite[]>;
  listHistory(userId: string, siteKey: string, limit?: number): Promise<AuditHistorySnapshot[]>;
  computeDelta(userId: string, siteKey: string, runId: string): Promise<AuditHistoryDelta | null>;
}

export type ArtifactKind = "page" | "script" | "link-index" | "image-index";

export interface ArtifactRef {
  key: string;
  contentHash: string;
  kind: ArtifactKind;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PageArtifactRecord {
  crawlId: string;
  url: string;
  normalizedUrl: string;
  status: number;
  depth: number;
  parentUrl?: string;
  headers: Record<string, string>;
  html: string;
  links: string[];
  fetcherId: string;
  rendered: boolean;
  fetchedAt: string;
  renderTimeMs: number;
}

export interface ArtifactStore {
  putPageArtifact(record: PageArtifactRecord): Promise<ArtifactRef>;
  getPageArtifactByUrl(normalizedUrl: string): Promise<PageArtifactRecord | null>;
  getPageArtifactByRef(ref: ArtifactRef): Promise<PageArtifactRecord | null>;
}

export type CrawlFrontierStatus = "pending" | "processing" | "done" | "failed" | "skipped";

export interface CrawlFrontierEntry {
  normalizedUrl: string;
  rawUrl: string;
  depth: number;
  parentUrl?: string;
  status: CrawlFrontierStatus;
  retries: number;
  reason?: string;
  enqueuedAt: number;
  updatedAt: number;
}

export interface CrawlStateSnapshot {
  crawlId: string;
  baseUrl: string;
  startedAt: string;
  completedAt?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  pagesFetched: number;
  pagesFailed: number;
  pagesSkipped: number;
}

export interface CrawlStateStore {
  createCrawl(snapshot: CrawlStateSnapshot): Promise<void>;
  upsertFrontier(crawlId: string, entry: CrawlFrontierEntry): Promise<void>;
  reserveNextFrontier(crawlId: string, limit: number): Promise<CrawlFrontierEntry[]>;
  completeFrontier(crawlId: string, normalizedUrl: string): Promise<void>;
  failFrontier(crawlId: string, normalizedUrl: string, reason: string): Promise<void>;
  updateStats(
    crawlId: string,
    patch: Partial<
      Pick<
        CrawlStateSnapshot,
        "pagesFetched" | "pagesFailed" | "pagesSkipped" | "status" | "completedAt"
      >
    >,
  ): Promise<void>;
  getCrawl(crawlId: string): Promise<CrawlStateSnapshot | null>;
}

export interface UsageStore {
  record(event: UsageEvent): Promise<void>;
  recordBatch(events: UsageEvent[]): Promise<void>;
  getUsage(userId: string, metric: UsageMetric, month: string): Promise<number>;
  checkQuota(userId: string, month: string): Promise<QuotaDecision>;
}

export interface RunLifecycleEvent {
  schemaVersion: 1;
  idempotencyKey: string;
  runId: string;
  userId: string;
  type: "run:created" | "run:started" | "run:completed" | "run:failed";
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface CrawlProgressEvent {
  schemaVersion: 1;
  idempotencyKey: string;
  crawlId: string;
  runId?: string;
  userId: string;
  timestamp: string;
  fetched: number;
  failed: number;
  skipped: number;
  pending: number;
}

// ============================================
// DOMAIN TYPES (shared across packages)
// ============================================

export interface RobotsRule {
  userAgent: string;
  rules: { type: "allow" | "disallow"; path: string }[];
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

// One well-known llms.txt-family file fetched at the domain root.
export interface LlmsTxtFile {
  url: string;
  exists: boolean;
  content: string | null;
  sizeBytes: number;
}

// Both llms.txt-family files, threaded onto SiteData for the ax/llms-txt rule.
export interface LlmsTxtData {
  llmsTxt: LlmsTxtFile;
  llmsFullTxt: LlmsTxtFile;
}

// Homepage markdown content-negotiation + .md variant probe for ax/markdown-response.
export interface MarkdownProbeData {
  // Homepage requested with `Accept: text/markdown`.
  negotiatedUrl: string;
  negotiatedContentType: string | null;
  servesMarkdown: boolean;
  // `.md` variant of the homepage (e.g. /index.md).
  mdVariantUrl: string;
  mdVariantExists: boolean;
  mdVariantContentType: string | null;
  // `Vary` response header on the negotiated fetch (should list `Accept` when
  // content negotiation is genuinely in play, so caches don't serve the wrong variant).
  // Optional: undefined for storage rows persisted before these fields existed.
  negotiatedVary?: string | null;
  // Cloudflare AI Crawl Control markdown-transform fingerprint headers, if present.
  markdownTokensHeader?: string | null;
  originalTokensHeader?: string | null;
  // Absolute URL from a `Link: <...>; rel="alternate"; type="text/markdown"`
  // response header on the negotiated fetch, or null if none was sent.
  alternateMarkdownUrl?: string | null;
}

// One differential cloaking probe of a suspicious path (integrity Phase 3, #118).
// The probe re-fetches the path with the DEFAULT crawl UA (baseline) and with a
// Googlebot UA, and optionally with an appended query token, then records the
// responses + a similarity verdict for `integrity/cloaking` to compare. Opt-in &
// bounded — the array is absent when the probe feature is off.
export interface CloakingProbeData {
  /** The probed URL (absolute). */
  url: string;
  /** Why this path was selected as suspicious. */
  reason: "orphan" | "recent-lastmod";
  /** Baseline fetch (default crawl UA) HTTP status; 0 = network error. */
  defaultStatus: number;
  /** Baseline response body size (bytes of decoded text). */
  defaultBytes: number;
  /** Googlebot-UA fetch HTTP status; 0 = network error. */
  googlebotStatus: number;
  /** Googlebot-UA response body size. */
  googlebotBytes: number;
  /** Visible-text Jaccard similarity default-UA vs googlebot-UA (0..1). */
  uaSimilarity: number;
  /** True when googlebot content materially diverges from default (UA cloaking). */
  uaCloaking: boolean;
  /** Query-variation probe URL (default UA + appended token), or null if not run. */
  queryUrl: string | null;
  /** Query-variation HTTP status; null when not run. */
  queryStatus: number | null;
  /** Query-variation response body size; null when not run. */
  queryBytes: number | null;
  /** Visible-text Jaccard similarity baseline vs query-variation; null when not run. */
  querySimilarity: number | null;
  /** True when the appended query token materially changes the response (token-gating). */
  tokenGated: boolean;
  /** Non-fatal note when a fetch failed (kept for transparency); null otherwise. */
  error: string | null;
}

// ---- Agent Experience (AX) prefetch data, threaded onto SiteData ----
// Element + Record types live in ./storage; these Data wrappers reuse them.
// Fixed-list well-known/agent-file probes for ax/well-known-agent & ax/api-discovery.
export interface WellKnownProbeData {
  probes: WellKnownProbe[];
}

// Homepage fetched under browser + GPTBot + Claude-User for ax/agent-blocking & ax/pay-per-crawl.
export interface AgentAccessData {
  probes: AgentAccessProbe[];
}

// robots.txt-derived RSL licensing for ax/rsl.
export interface RslData {
  /** Absolute license URLs from robots.txt `License:` + `Link: rel=license`. */
  licenseUrls: string[];
  robotsHasLicense: boolean;
  linkHeaderPresent: boolean;
  documents: RslLicenseDoc[];
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

export interface ImageData {
  src: string;
  alt: string | null;
  width: string | null;
  height: string | null;
}

export interface HeadingData {
  level: number;
  text: string;
  order: number;
}

export interface HeadingHierarchy {
  headings: HeadingData[];
  h1Count: number;
  h1Texts: string[];
  hasSkippedLevels: boolean;
  skippedLevels: string[];
  emptyHeadings: HeadingData[];
  longHeadings: HeadingData[];
  duplicateHeadings: string[];
  outline: string;
}

export interface ContentAnalysis {
  wordCount: number;
  textLength: number;
  htmlLength: number;
  textToHtmlRatio: number;
  isThinContent: boolean;
  contentHash: string;
  textContent: string;
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
  cacheReason?: CacheHitReason | null;
}

export interface ScriptContentData {
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  content: string | null;
  sourcePages: string[];
  redirected?: boolean;
  finalUrl?: string;
  sourceMapHeader?: string;
}

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
  error: string;
}

export interface SitemapDiscovery {
  discovered: SitemapData[];
  sources: { robotsTxt: string[]; commonLocations: string[] };
  totalUrls: number;
  orphanPages: string[];
  missingPages: string[];
  failed: SitemapFetchFailure[];
}

export interface SitemapUrlStatusData {
  url: string;
  status: number | null;
  error: string | null;
}

// SecurityHeaders is now in ./storage.ts (re-exported above)

export interface HreflangTag {
  hreflang: string;
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

// Minimal SchemaCollection interface for cross-package use.
// Full class is in @squirrelscan/parser.
export interface SchemaCollectionLike {
  types: string[];
  valid: boolean;
  errors: string[];
  raw: string | null;
}

// Use SchemaCollectionLike as the cross-package type
export type { SchemaCollectionLike as SchemaCollection };

// Minimal ParsedPage for cross-package use (without DOM reference).
// Full type with Document is in @squirrelscan/parser.
export interface ParsedPage {
  meta: MetaData;
  h1: { count: number; texts: string[] };
  og: OpenGraphData;
  twitter: TwitterData;
  links: LinkData[];
  images: ImageData[];
  headings: HeadingHierarchy;
  content: ContentAnalysis;
  schemas: SchemaCollectionLike;
  schema: SchemaData;
  // Visible (non-schema) author/date markup — hCard byline, entry-meta <time>.
  // Optional so deserialized/legacy parsed records without these stay valid.
  visibleAuthor?: string | null;
  visibleDatePublished?: string | null;
  visibleDateModified?: string | null;
}

export type CoverageMode = "quick" | "surface" | "full";

// Per-website cloud-render override (#318): auto = engine decides, always =
// force browser render, never = plain HTTP fetch.
export type RenderMode = "auto" | "always" | "never";

// Websites list sort (#815). "name" compares title-or-domain
// case-insensitively; null score/issue-count always sorts last.
export type WebsiteSortField = "recent" | "name" | "score" | "issues";
export type WebsiteSortOrder = "asc" | "desc";

// ── Audit source / runner ──────────────────────────────────────────
// Where an audit was initiated from — surfaced in the dashboard. Derived from
// the storage-level `agent_runs.trigger` so the UI has a single, stable
// taxonomy regardless of internal trigger values.
export type AuditSource = "cli" | "cloud" | "scheduled" | "github";

/** Map a raw `agent_runs.trigger` value to a user-facing audit source. */
export function triggerToAuditSource(trigger: string | null | undefined): AuditSource {
  switch (trigger) {
    case "cli":
      return "cli";
    case "scheduled":
      return "scheduled";
    case "github":
      return "github";
    // "api"/"observer" are dashboard-initiated; null/undefined = no linked run.
    // Any future/unknown trigger also falls through to "cloud" — the safe
    // default. (No console.warn here: this package runs in the browser bundle,
    // and a prod console spam isn't worth it. New triggers are added on the API
    // side, which is where a mapping gap should be caught.)
    default:
      return "cloud";
  }
}

// ── Agent-run lifecycle & org-sync `runs` delta ────────────────────

/** Hosted agent-run status lifecycle. */
export type AgentRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Statuses where a run is finished — it leaves live "running now" feeds and
 * worker-agent stops reconciling it. Typed `ReadonlySet<string>` so callers
 * holding a raw status string can `.has()` without a cast; the `Set<AgentRunStatus>`
 * literal still rejects typos at the definition.
 */
export const TERMINAL_AGENT_RUN_STATUSES: ReadonlySet<string> = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Coarse org-sync `runs` oplog payload — produced by the api tee
 * (`buildRunEventChange`/`buildRunStatusChange`, #459), consumed by the
 * dashboard live-sync (#460). Partial delta merged by runId. `progress` is the
 * raw crawler progress event (`{fetched,total,…}`, worker-agent
 * postCrawlerProgress) — NOT the CLI `/progress` `progressRunSchema`
 * (`pagesFetched`/…).
 */
export interface RunSyncDelta {
  status?: AgentRunStatus;
  phase?: string | null;
  progress?: { fetched?: number; total?: number } | null;
}

// ── Organization & Plan types ──────────────────────────────────────

export type PlanId = "free" | "starter" | "team";
export type OrgRole = "owner" | "admin" | "editor" | "viewer" | "billing";

/** Stripe subscription billing interval. Annual prepays 12 months at the
 * price of 10 — credits are still granted MONTHLY (see credits:annual-monthly-grant). */
export type BillingInterval = "month" | "year";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceMonthUsd?: number;
  /** Annual price (12 months prepaid at the cost of 10). Absent = no annual option. */
  priceYearUsd?: number;
  monthlyCredits: number;
  maxOrgs: number;
  maxWebsites: number;
  maxMembers: number;
  /**
   * Max concurrent in-flight cloud render jobs per audit. Clamps the CLI's
   * `[cloud].render_concurrency` (schema max 10) — enforced client-side; the
   * binary fetches it from `GET /v1/credits` at crawl start.
   */
  renderConcurrency: number;
  /**
   * Recurring scheduled audits (daily/weekly/monthly). Paid-plan upsell:
   * free orgs default to disabled and cannot enable; the `audit:scheduled`
   * handler skips any schedule whose org lacks this capability.
   */
  scheduledCrawls: boolean;
  /**
   * Raw per-plan cloud-audit page ceiling (#1020 ladder: Free 500 / Pro
   * 2,000 / Team 5,000). This is the plan's OWN allowance, not the effective
   * runtime ceiling — hosted dispatch sites clamp it further to
   * `REPORT_LIMITS.maxPages`, the report/publish ingest cap. Team's raw value
   * exceeds that cap today on purpose: raising the cap later (separate
   * engine/report-pipeline work) auto-unlocks Team with no plan-data change.
   * Local CLI audits are UNAFFECTED — they use their own generous
   * MAX_PAGES_CAP regardless of plan.
   */
  maxPagesPerAudit: number;
  /**
   * Per-website custom HTTP request headers (e.g. Web Bot Auth signatures)
   * applied to cloud audits (#494). Paid-plan upsell: the settings route rejects
   * free orgs with 403 `upgrade_required`, and `resolveWebsiteRunConfig` never
   * forwards stored headers for a non-capable plan (defense in depth).
   */
  customHeaders: boolean;
  /**
   * Per-seat pricing for seat-based plans (Team, #625). Only seat-based plans
   * set it; `undefined` means flat subscription pricing (free/starter). At
   * launch, the monthly credit grant is pooled into the org's monthly bucket as
   * `seats * includedCreditsPerSeat`, and checkout uses `quantity = seats` with
   * a `minSeats` floor.
   * TODO(#625 Phase 2): Team's values are TBD — pricing questions still open.
   */
  perSeat?: {
    priceMonthUsd: number;
    /** Annual per-seat price (12 months prepaid at the cost of 10). */
    priceYearUsd?: number;
    includedCreditsPerSeat: number;
    minSeats: number;
  };
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  planId: PlanId;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  createdAt: string;
  updatedAt: string;
}

export interface OrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface SecurityAnalysis {
  isHttps: boolean;
  hasMixedContent: boolean;
  mixedContentUrls: string[];
  insecureFormActions: string[];
  headers: SecurityHeaders;
  httpToHttpsRedirect: boolean;
}

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
  depth: number;
}

export interface EnhancedImageData extends ImageData {
  format: string | null;
  hasLazyLoading: boolean;
  hasSrcset: boolean;
  hasSizes: boolean;
  isDecorativeAlt: boolean;
  filenameQuality: "good" | "generic" | "random";
  inFigure: boolean;
  hasFigcaption: boolean;
}

export interface CWVHints {
  largeImagesWithoutPreload: string[];
  renderBlockingResources: string[];
  fontsWithoutSwap: string[];
  missingPreconnect: string[];
  imagesWithoutDimensions: string[];
  iframesWithoutDimensions: string[];
  largeScripts: { src: string; size?: number }[];
  thirdPartyScripts: string[];
  preloadTags: string[];
  prefetchTags: string[];
  preconnectTags: string[];
  dnsPrefetchTags: string[];
  asyncScripts: number;
  deferScripts: number;
  blockingScripts: number;
  totalScripts: number;
}

// ── Issues & Recommendations ──────────────────────────────────────

export type CommentType = "user" | "recommendation" | "review";

export interface IssueComment {
  id: string;
  issueId: string;
  userId: string | null;
  type: CommentType;
  body: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export type IssueStatus = "open" | "in_progress" | "resolved" | "dismissed";
export type IssueSeverity = "critical" | "high" | "medium" | "low";
export type IssueSource = "audit" | "recommendation";
export type IssueEffort = "quick-win" | "moderate" | "significant";

export interface Issue {
  id: string;
  number: number;
  websiteId: string;
  userId: string;
  orgId: string | null;
  assignedTo: string | null;
  ruleId: string | null;
  auditId: string | null;
  runId: string | null;
  source: IssueSource;
  status: IssueStatus;
  severity: IssueSeverity;
  category: string;
  title: string;
  description: string;
  impact: string | null;
  recommendation: string | null;
  platformGuide: string | null;
  platform: string | null;
  affectedPages: string[] | null;
  occurrences: number;
  firstDetectedAt: string;
  lastDetectedAt: string | null;
  resolvedAt: string | null;
  fixRunId: string | null;
  fixPrUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationSummary {
  overview: string;
  topPriorities: string[];
  estimatedEffort: string;
}

export interface RecommendationOutput {
  summary: RecommendationSummary;
  issues: Array<{
    ruleId: string | null;
    severity: IssueSeverity;
    title: string;
    description: string;
    impact: string;
    recommendation: string;
    platformGuide: string;
    effort: IssueEffort;
  }>;
}
