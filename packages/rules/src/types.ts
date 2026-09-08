// Rule interface definitions for SquirrelScan linter-style architecture

import type { Document } from "linkedom";

import { z } from "zod";

import type { PageType, Soft404Confirmation, Soft404Signal } from "@squirrelscan/parser";
import type { AuthorInfo, SchemaCollection } from "@squirrelscan/parser";
// Import and re-export RuleCategory from categories.ts (single source of truth)
import type { RuleCategory } from "./categories";
import type { CollectedSiteSignals } from "./collected-signals";
import type { CloudResultStore, RuleCloudSpec } from "./cloud";
import type {
  BusinessCategory,
  CheckResult,
  CloakingProbeData,
  ContactLinkData,
  ContentAnalysis,
  HeadingHierarchy,
  ImageData,
  IntelContext,
  LinkData,
  LlmsTxtData,
  MarkdownProbeData,
  WellKnownProbeData,
  AgentAccessData,
  RslData,
  MetaData,
  OpenGraphData,
  RedirectChain,
  RobotsTxtData,
  ResourceSizeData,
  SchemaData,
  ScriptContentData,
  SiteMetadata,
  SiteQuery,
  SiteType,
  SitemapDiscovery,
  SitemapUrlStatusData,
  TwitterData,
} from "@squirrelscan/core-contracts";
export type { RuleCategory };
export type { PageType };

// Rule scope - when the rule runs
export type RuleScope = "page" | "site";

// Rule severity - default severity of issues found
export type RuleSeverity = "error" | "warning" | "info";

/**
 * Whether a page rule's verdict is a property of the page's TEMPLATE or of the
 * PAGE itself (#1950).
 *
 * "template" is a claim that every page sharing a template cluster key
 * (`page_features.template_fp`, #1949) gets the same verdict from this rule, so
 * the rule may be run once per cluster and its verdict fanned out to the members
 * (#1951). "page" means it must run on every page.
 *
 * It lives on `meta`, next to `scope` and `severity`, because it is a property of
 * the rule's INPUTS and it goes stale the moment those change: a rule that reads
 * only the head today and starts reading the body next month stops being
 * template-scoped, and the person making that change is looking at this file, not
 * at a registry somewhere else.
 *
 * WHEN A RULE MAY DECLARE "template". Only when its verdict is determined by
 * markup the TEMPLATE emits into every member: the document head, the chrome
 * landmarks, and the page's asset graph — the stylesheet hrefs, script and asset
 * hosts, body classes and CSS custom properties the cluster key already pins.
 *
 * Three input classes are NOT that, and disqualify a rule however stable it looks
 * on real crawls:
 *
 *  - **Response headers.** The cluster key constrains none of them. Two pages of
 *    one template routinely differ in `Cache-Control`, `Set-Cookie` or
 *    `SourceMap`, so `perf/cache-headers`, `security/cookie-flags` and
 *    `perf/source-maps` are page-scoped. `perf/compression` is the sharpest case:
 *    its verdict is stable but its MESSAGE interpolates the page's byte count.
 *  - **The page url.** Per-page by construction; `url/*` and `security/https`
 *    read nothing else.
 *  - **Anything inside the page's main content** — body text, images, links,
 *    headings, per-page meta, JSON-LD. That is what template siblings differ in by
 *    definition, so a rule scanning the whole document for a pattern that can
 *    appear in body content (`security/mixed-content`, `security/form-https`,
 *    `legal/terms-of-service`, most `a11y/aria-*`) stays page-scoped even where
 *    two real corpora agree.
 *
 * A detection-only rule that emits NOTHING when a page is clean is also
 * page-scoped: fanning out its silence claims a page nobody looked at is clean,
 * and for `integrity/*` and `security/*` that is the expensive direction to be
 * wrong in.
 *
 * WHAT THE CLUSTER KEY DOES NOT CHECK FOR YOU. The key is chrome only — asset
 * hosts, body classes, CSS custom properties, stylesheet hrefs, nav/footer
 * presence — so two pages can share it and still differ in markup it never looked
 * at: a missing viewport `<meta>`, a second `<main>`, a script whose PATH differs
 * on the same host (per-route hashed bundles do this). A declaration is therefore
 * a claim about how the site's templates are BUILT, not something the key
 * enforces, and it is why "constant on two crawls" is evidence rather than proof.
 * Tracked as squirrelscan/squirrelscan#275. Two things are not left to the
 * declaration: the fan-out groups by page ORIGIN as well as by template, and a
 * rule reading a response header is disqualified outright (see `core/charset`).
 *
 * A declaration is a claim, not a proof, and it has two falsifiers.
 * `template-fanout-parity-golden.test.ts` runs in CI over an authored corpus with
 * real multi-page clusters; `apps/cli/scripts/template-rule-invariance.ts --check`
 * runs against a real crawl, and its result over gymshark.com and
 * openelectricity.org.au is recorded in
 * `packages/rules/tests/fixtures/template-invariance-measured.json`, which
 * `rule-verdict-scope.test.ts` asserts every declaration against.
 */
export type VerdictScope = "template" | "page";

/**
 * Run-time applicability declaration. A rule with `appliesWhen` is GATED by the
 * Stage-0 site-metadata profile: when the resolved metadata does not match, the
 * runner emits ONE visible `skipped` check and skips `run()` (see
 * `applicability.ts` for the exact contract — all keys optional, AND-across-keys,
 * OR-within-each-list). Omit entirely for safety rules (security, broken links)
 * that must ALWAYS run, and for any rule that should behave as today.
 */
export interface RuleApplicability {
  /** Run only when the resolved site type is one of these. */
  siteTypes?: SiteType[];
  /** Run only when the resolved business category is one of these. */
  businessCategories?: BusinessCategory[];
  /** Run only when the audience scope / declared audiences overlap these. */
  audiences?: string[];
  /** Run only when the resolved primary country is one of these (ISO alpha-2). */
  countries?: string[];
  /** Run only for sites flagged as a real-world local business (NAP). */
  requiresLocalBusiness?: boolean;
  /** Run only for Your-Money-or-Your-Life sites (stricter trust rules). */
  requiresYMYL?: boolean;
  /** Run only when site ownership is verified (Phase 2 — always false in v1). */
  requiresOwnership?: boolean;
}

// Rule metadata - describes the rule
export interface RuleMeta {
  id: string; // "core/meta-title"
  name: string; // "Meta Title"
  description: string;
  solution?: string; // optional 1-2 paragraphs of guidance for fixing issues
  category: RuleCategory;
  subcategory?: string; // optional sub-group within a category (e.g. "ad" | "privacy")
  scope: RuleScope;
  severity: RuleSeverity;
  weight: number; // scoring weight (1-10)
  // Zod schema for rule options - self-describing with defaults
  optionsSchema?: z.ZodObject<z.ZodRawShape>;
  disabled?: boolean; // Internal flag - hides rule from all listings and execution
  // Cloud-backed rules declare the credit-gated service they read (prefetched).
  cloud?: RuleCloudSpec;
  // Context-aware rules declare when they apply; gated by the Stage-0 metadata.
  appliesWhen?: RuleApplicability;
  /**
   * Page-scope content/mechanism rules set this so the runner emits a visible
   * `skipped` check (reason "soft-404") instead of running them on a soft-404
   * page — a URL that serves 404/error content with a 2xx status (see
   * `parsed.isSoft404`). Prevents one broken error template from spraying
   * per-page legal/quality warnings. Omit for status/security/crawl rules that
   * must always run (the `crawl/soft-404` rule itself must NOT set it).
   */
  skipOnSoft404?: boolean;
  /**
   * Page rules only: see {@link VerdictScope}. REQUIRED on every page rule, and
   * enforced by `rule-verdict-scope.test.ts` rather than by the type, so that a
   * rule added without it fails a named test instead of turning every rule file
   * into a discriminated union.
   *
   * Optional in the type and unset on site rules, so read it ONLY through
   * {@link mayFanOutAcrossTemplate}, which requires an explicit "template".
   * Absent must never mean fannable: the whole point of the field is that an
   * unclassified rule keeps running per page.
   */
  verdictScope?: VerdictScope;
}

/**
 * Whether this rule may be run once per template cluster and its verdict fanned
 * out to the cluster's other members (#1951).
 *
 * The ONLY reader of `meta.verdictScope`, and it is deliberately closed: a site
 * rule, and a page rule that has not declared, both answer false. Fan-out is a
 * claim about pages the rule never ran on, so silence has to mean "no".
 */
export function mayFanOutAcrossTemplate(meta: RuleMeta): boolean {
  return meta.scope === "page" && meta.verdictScope === "template";
}

// Generate docs URL for a rule
export function getDocsUrl(ruleId: string): string {
  return `https://docs.squirrelscan.com/rules/${ruleId}`;
}

// Page data provided to rules
export interface PageData {
  url: string;
  html: string;
  statusCode: number;
  loadTime: number;
  ttfb?: number; // time to first byte
  downloadTime?: number; // body download time
  headers: Record<string, string>;
  parsed?: ParsedPage; // Optional pre-parsed data (Phase 3: stored parsed data)
  finalUrl?: string;
  redirectChain?: RedirectChain;
  /**
   * True when this page's crawl HTML came from a browser render (crawl fetcher
   * "cloud-render"/"browser"), so `html`/`parsed` already reflect the post-JS
   * DOM. ax/content-without-js reads it to SKIP: comparing raw vs cloud-rendered
   * content is self-identical when the crawl itself rendered (#673). Absent →
   * treat as raw HTML (rule runs as today).
   */
  rendered?: boolean;
}

// Parsed page content - extracted by core modules
export interface ParsedPage {
  document: Document | null; // Pre-parsed DOM - null for error pages (4xx/5xx)
  meta: MetaData;
  h1: { count: number; texts: string[] };
  og: OpenGraphData;
  twitter: TwitterData;
  links: LinkData[];
  // tel:/mailto: anchors — dropped from `links` (not crawlable), carried here so
  // site rules can compare declared contact details across pages.
  contactLinks?: ContactLinkData[];
  images: ImageData[];
  headings: HeadingHierarchy;
  content: ContentAnalysis;

  // Rich schema data - use schemas.article, schemas.product, etc.
  schemas: SchemaCollection;

  // Convenience accessors
  author: AuthorInfo | null; // From schema only (LLM extraction = pro feature)
  pageType: PageType; // Schema-based + URL patterns

  // Visible (non-schema) author/date markup — hCard byline, entry-meta <time>.
  // Optional so deserialized/legacy parsed records without these stay valid.
  visibleAuthor?: string | null;
  visibleDatePublished?: string | null;
  visibleDateModified?: string | null;

  /**
   * True when this 2xx page serves 404/error content (see `detectSoft404`).
   * Computed per-run by the runner (needs the page's status code), so it is
   * absent on parsed records read straight from storage until the runner sets
   * it. Read by `crawl/soft-404` and drives `skipOnSoft404` gating.
   */
  isSoft404?: boolean;
  /** The signals that produced `isSoft404` (empty/absent when not a soft-404). */
  soft404Signals?: Soft404Signal[];
  /**
   * Verdict from the end-of-crawl confirmation re-fetch (#1177). Set by the
   * audit-engine confirm pass BEFORE page rules run; `crawl/soft-404` reads it to
   * pick the finding variant. Absent on runner-only paths (no confirm pass) —
   * the rule then treats it as unconfirmed (warns, annotated), never drops.
   */
  soft404Confirmation?: Soft404Confirmation;

  // DEPRECATED: Use schemas.types, schemas.valid, etc. instead
  schema: SchemaData;
}

// External link check result
export interface ExternalLinkCheckData {
  href: string;
  status: number | null;
  error: string | null;
  sourcePages: string[];
  /** True if 403 appears to be WAF/bot protection rather than real forbidden */
  wafBlocked?: boolean;
  /** Detected WAF provider if wafBlocked is true */
  wafProvider?: string;
  /**
   * The target answered with rate limiting (429/430, or 503 + `Retry-After`),
   * so its status is unverified rather than broken (#1829). Link rules must
   * report these as info, never as dead links.
   */
  rateLimited?: boolean;
}

// Site-level data for site-scope rules
export interface SiteData {
  baseUrl: string;
  pages: Array<{
    url: string;
    finalUrl?: string;
    statusCode: number;
    parsed: ParsedPage;
    headers?: Record<string, string>;
    redirectChain?: RedirectChain;
  }>;
  robotsTxt: RobotsTxtData | null;
  sitemaps: SitemapDiscovery | null;
  // Root llms.txt + llms-full.txt fetch; optional like the other extras.
  llmsTxt?: LlmsTxtData | null;
  // Homepage markdown content-negotiation + .md variant probe.
  markdownResponse?: MarkdownProbeData | null;
  // AX: fixed-list well-known/agent-file probes (MCP, A2A, OpenAPI, AGENTS.md, …).
  wellKnown?: WellKnownProbeData | null;
  // AX: homepage fetched as browser + GPTBot + Claude-User (access parity / blocking / pay-per-crawl).
  agentAccess?: AgentAccessData | null;
  // AX: robots.txt-derived RSL licensing (License: directives + fetched RSL docs).
  rsl?: RslData | null;
  externalLinks?: ExternalLinkCheckData[];
  resourceSizes?: {
    css: ResourceSizeData[];
    images: ResourceSizeData[];
  };
  scripts?: ScriptContentData[];
  pdfSizes?: ResourceSizeData[];
  sitemapUrlStatuses?: SitemapUrlStatusData[];
  // Differential cloaking-probe results (#118). Undefined when the opt-in probe
  // is off; an empty array means it ran but found no suspicious paths to probe.
  cloakingProbes?: CloakingProbeData[];
  // Raw pages crawled this run vs the configured page cap (#697) — lets
  // site-scope rules tell "crawl was truncated by the coverage profile" apart
  // from "the crawler genuinely could not reach these pages". Undefined for
  // callers that haven't threaded it through (treat as not-capped).
  crawlLimits?: { pagesCrawled: number; maxPages: number };
}

// Context provided to rules when they run
export interface RuleContext {
  // Page data (for page-scope rules)
  page: PageData;

  // Parsed page content (extracted by core modules)
  parsed: ParsedPage;

  // Site data (for site-scope rules, undefined for page-scope)
  site?: SiteData;

  // Bounded, read-only aggregate view over the crawl (#1022). When present, a
  // site rule reads its rollups (incoming-link counts, duplicate groups, …)
  // INSTEAD of materializing `site.pages` — this is what lets a streaming audit
  // score a large site without holding every parsed page resident. Undefined on
  // every path today (v1 engine never sets it): rules MUST treat undefined as
  // "run the legacy `site.pages` path" so behaviour stays byte-identical until
  // the streaming loop (#1021) supplies it. Type-only import keeps this package
  // Worker-clean — no crawler internals leak in.
  siteQuery?: SiteQuery;

  // Page-time DOM signals collected during the streaming page pass (#1021 E-E2).
  // Present only in the streaming engine's site pass; when set, the six all-pages
  // DOM-scanner site rules (leaked-secrets, total-byte-weight, template-
  // discontinuity, integrity/orphan-page, adblock/blocked-links, legal/
  // subprocessor-disclosure) aggregate over these bounded per-page records INSTEAD
  // of re-materializing every page's DOM. Undefined on the v1 path — rules then run
  // their legacy `site.pages[].parsed.document` scan, byte-identical to today.
  collectedSignals?: CollectedSiteSignals;

  // Resolved Stage-0 site profile (cloud). Undefined offline / free / no-credits
  // / no-consent — rules must treat undefined as "run as today" (no gating).
  siteMetadata?: SiteMetadata;

  // Prefetched cloud-service results (service → key → envelope) for THIS audit
  // run. Threaded per-run (not a process global) so concurrent audits in one
  // isolate never read each other's results. Undefined = nothing prefetched
  // (anonymous / cloud disabled) → cloud rules read `undefined` as
  // `not-prefetched`. Cloud rules MUST read via
  // `readCloudResult(ctx.cloudResults, …)`.
  cloudResults?: CloudResultStore;

  // Threat-intel handle (#117) — daily-pull feeds + memoized lookups + kit
  // signatures, resolved by audit-engine BEFORE rules run so the methods stay
  // synchronous/pure. Undefined when the opt-in `[intel]` feature is off; the
  // integrity intel rules then contribute nothing.
  intel?: IntelContext;

  // Rule options from config, with defaults applied
  options: Record<string, unknown>;
}

// Result returned by a rule
export interface RuleResult {
  checks: CheckResult[];
}

// Result after runner processes a rule - includes metadata
export interface RuleRunResult {
  meta: RuleMeta;
  checks: CheckResult[];
  /**
   * Smart-audits union scoring ONLY (#918): count of clean pages this page-scope
   * rule passed on, folded to a number instead of one synthetic "pass"
   * CheckResult per page. Set by `buildScoringResultsFromMerged` (carried-clean
   * pages) and, in the #1023 complete-store path, by `reconstructCompleteResults`
   * (fresh crawled-clean pages) — the two are additive. `calculateHealthScore`
   * adds it to the rule's passed+total denominator. Kept OFF `checks` so a large
   * re-audit can't materialize (page-scope rules × thousands of pages) pass
   * objects and OOM the Worker. Undefined on every non-union result; never
   * serialized (the report uses ReportRuleResult).
   */
  syntheticPassCount?: number;
}

// Rule interface - what every rule must implement
export interface Rule {
  meta: RuleMeta;
  run(ctx: RuleContext): RuleResult | Promise<RuleResult>;
  optionsSchema?: unknown; // Optional Zod schema for rule-specific options
}

// Re-export types for convenience
export type { CheckResult, LlmsTxtData, MarkdownProbeData, RobotsTxtData };
