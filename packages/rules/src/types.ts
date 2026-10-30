// Rule interface definitions for SquirrelScan linter-style architecture

import type { Document } from "linkedom";

import { z } from "zod";

import type { PageType, Soft404Confirmation, Soft404Signal } from "@squirrelscan/parser";
import type { AuthorInfo, SchemaCollection } from "@squirrelscan/parser";
// Import and re-export RuleCategory from categories.ts (single source of truth)
import type { RuleCategory } from "./categories";
import type { CollectedSiteSignals } from "./collected-signals";
import type { EndpointSurface } from "./endpoint-surface";
import type { ProbeBudget } from "./probe-budget";
import type { TlsProbeFn } from "@squirrelscan/utils/tls-certificate";
import type { CloudResultStore, RuleCloudSpec } from "./cloud";
import type {
  BusinessCategory,
  CheckItem,
  CheckResult,
  CloakingProbeData,
  ContactLinkData,
  HreflangAlternate,
  ContentAnalysis,
  DiscoveryProbe,
  EntityMap,
  EntityMapEdge,
  EntityMapNode,
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
  PageClassification,
  RedirectChain,
  RefusedFetch,
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
 * WHAT THE CLUSTER KEY DOES NOT CHECK FOR YOU. The stored key is chrome only —
 * asset hosts, body classes, CSS custom properties, stylesheet hrefs, nav/footer
 * presence — so two pages can share it and still differ in markup it never looked
 * at. The fan-out therefore groups on a tighter key than the stored one: the
 * chrome key plus the page ORIGIN plus a rule-input signature (the `<script src>`
 * and stylesheet `<link href>` lists with whether each carries `integrity`, every
 * `<meta>`'s name, property, http-equiv and charset, the `content` of the metas a
 * declared rule reads the value of, the `<main>` landmark count, the `lang`,
 * `xml:lang` and `aria-hidden` of `<html>`, the `aria-hidden` of `<body>`, and
 * the `rel` and `href` of icon links; see `fanoutInputSignature`). That closes the
 * counterexamples tracked as squirrelscan/squirrelscan#275 (a missing viewport
 * `<meta>`, a second `<main>`, a script path that differs on one host) and #614
 * (an `xml:lang` or `aria-hidden` on the root elements, a favicon link). It does
 * NOT make a declaration checkable: any OTHER markup input a rule reads is still
 * not in the key, so a declaration is a claim about how the site's templates are
 * BUILT, and "constant on two crawls" is evidence rather than proof. If your rule
 * reads an input the signature omits, either extend `fanoutInputSignature` or
 * keep the rule page-scoped. A rule reading a response header is disqualified
 * outright (see `core/charset`).
 *
 * THE INPUTS DECLARED RULES READ THAT THE KEY DOES NOT CHECK. The per-rule list
 * is the UNKEYED entries in `tests/template-verdict-inputs.test.ts`, which fails
 * when a declared rule starts reading anything that is not on its reviewed list,
 * and when a rule with an unkeyed read is not named here:
 *
 *  - the raw HTML (`ctx.page.html`): `core/doctype`, `a11y/focus-visible`,
 *    `analytics/consent-mode`, `analytics/gtm-present`, `perf/js-libraries`;
 *  - everything `getCWVHints` reads, which `perf/font-loading`,
 *    `perf/preconnect` and `perf/render-blocking` hand their document and raw
 *    HTML to: preload, prefetch, preconnect and dns-prefetch links, script
 *    `type`, `async`, `defer` and `nomodule`, stylesheet `media`, and images and
 *    iframes with their size and style (`perf/font-loading` also reads every
 *    `<link href>`);
 *  - inline `<script>` and `<style>` bodies and the script `type`: `perf/legacy-js`
 *    (also `type="module"` and `nomodule` scripts), `perf/unminified-js`,
 *    `perf/js-libraries`, `perf/unminified-css` (which also selects on an exact
 *    `rel="stylesheet"`, where the key matches the token), `perf/font-delivery`
 *    (also the stylesheet `media`);
 *  - the `id` and `class` of the first `<main>`, which its message names
 *    (`a11y/landmark-one-main`);
 *  - iframe and image `src`, and image `width` and `height`
 *    (`security/third-party-cookies`).
 *
 * Three things no entry captures, for every declared rule. ORDER: the signature
 * sorts the script, stylesheet and meta lists, so a rule that takes the first
 * viewport meta or lists evidence in document order can see two pages differ
 * where the key does not. `<noscript>` ANCESTRY: the `OutsideNoscript` helpers
 * skip markup inside `<noscript>`, the signature does not. PLACEMENT: a rule that
 * reads only the `<head>` (`perf/font-delivery`, `getCWVHints`) sees a stylesheet
 * or script move to the `<body>`, the key does not.
 *
 * The scan sees literal selectors and attribute names (the `@squirrelscan/utils`
 * helpers included), selector and attribute variables by name, those raw
 * channels, and every read in a helper file from this package that a rule hands
 * its document to. What a selector variable holds (`core/favicon`'s five icon
 * selectors, all inside `link[rel*="icon"]`) is reviewed by hand, and the test
 * checks that each rule with an unkeyed read is named above, not every input.
 * Deriving the key from what the rules read is squirrelscan/squirrelscan#585.
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
  /**
   * The rule is available but excluded by the default `enable = ["*"]` selection.
   * A concrete enable pattern (the exact id or its category) or
   * `[rule_options."id"] enabled = true` opts it in.
   */
  optIn?: boolean;
  // Cloud-backed rules declare the credit-gated service they read (prefetched).
  cloud?: RuleCloudSpec;
  // Context-aware rules declare when they apply; gated by the Stage-0 metadata.
  appliesWhen?: RuleApplicability;
  /**
   * The pre-crawl discovery probes whose results this rule reads (#409). The
   * crawler sends a probe only while an enabled rule declares it, so excluding
   * every reader (`--rule-exclude ax`) skips the request. A rule whose probe was
   * not sent must report "not checked", never a missing file.
   */
  discoveryProbes?: readonly DiscoveryProbe[];
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
   * Page-scope rules whose only purpose is how a page appears in search results
   * (title, description, H1) set this so the runner emits a visible `skipped`
   * check (reason "noindex") instead of running them on a page its owner keeps out
   * of the index with a robots meta or X-Robots-Tag noindex (pub#457). Applied
   * only when the site itself is known to be indexed (`SiteData.siteIndexable`):
   * a whole host out of search is a staging or preview deployment, where these
   * rules are the point of the audit. Keep the list conservative: accessibility,
   * security, performance and link rules must never set it.
   */
  skipOnNoindex?: boolean;
  /**
   * Page-scope rules that judge a page the way a searcher meets it (a thin-content floor, a
   * keyword-density verdict) list the page types they do not apply to, and the runner emits a
   * visible `skipped` check (reason "page-type", counted in `details.skippedByType`, a rule-wide
   * "does not apply" verdict like the noindex gate) instead of running them. The page body must also
   * corroborate the label (`bodyCorroboratesPageType`). Only a MODEL label at or above `PAGE_TYPE_TRUST_CONFIDENCE` counts; a rules
   * label never relaxes a verdict (pub#841). Keep the list to types where the finding is wrong
   * by nature, such as a contact or legal page being short.
   */
  skipOnPageType?: readonly string[];
  /**
   * Transport and delivery rules set this so the runner emits a visible
   * `skipped` check (reason "private-target") instead of running them when the
   * audited host is a local or private-network address: localhost, `*.local`,
   * loopback, RFC1918, link-local and the like, as `nonPublicHostLabel` in
   * `@squirrelscan/utils/non-public-host` decides from the audit URL (pub#629).
   * Such a host is not the production edge: a dev server is plain HTTP/1.1 on
   * purpose and sets no production caching or compression, so HTTPS, HSTS,
   * caching, compression and HTTP/2 findings there say nothing about the site.
   * Page and site rules alike. Keep the list to what the hosting edge decides:
   * a rule that judges the markup or the build (mixed content, form actions,
   * minification, security headers the app sets) must never set it.
   */
  skipOnPrivateTarget?: boolean;
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
   * `<link rel="alternate" hreflang>` annotations, resolved, deduplicated and
   * capped by the parser (#489). Absent on parsed records stored before the
   * field existed; readers treat that as "none declared".
   */
  hreflangAlternates?: HreflangAlternate[];

  /**
   * The page classifier's answer (model page type, and why it degraded), when it ran. Absent when
   * the classifier was off or the parse predates it; `pageType` above is the schema and URL label.
   */
  classification?: PageClassification;

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
  /** Error-shell marker captured while the DOM was live; see the parser's `ParsedPage.errorShell` (#235). */
  errorShell?: boolean;

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
   * Why a `wafBlocked` link is unverifiable (pub#821): `blocked`,
   * `unreachable`, or `awaiting-confirmation` for a first 404 the cloud link
   * checker has not confirmed yet. Absent when the checker did not say.
   */
  unverifiedReason?: "blocked" | "unreachable" | "awaiting-confirmation";
  /**
   * The target answered with rate limiting (429/430, or 503 + `Retry-After`),
   * so its status is unverified rather than broken (#1829). Link rules must
   * report these as info, never as dead links.
   */
  rateLimited?: boolean;
}

// Site-level data for site-scope rules
/** One icon a web app manifest declares, checked over the same-origin fetch (#710). */
export interface WebAppManifestIconCheck {
  /** Absolute icon URL, resolved against the manifest URL. */
  url: string;
  status: number | null;
  error: string | null;
  /** Natural pixel size from the image header; null when not read or not an image. */
  naturalWidth: number | null;
  naturalHeight: number | null;
  /** Throttled (429/430, or 503 with Retry-After): the status says nothing about the icon. */
  rateLimited?: boolean;
  /** A WAF or bot challenge answered in place of the icon. */
  wafBlocked?: boolean;
  /** Custom headers were withheld from this host: a 401 or 403 is unverified (#732). */
  headersWithheld?: boolean;
}

/** A `<meta name="theme-color">` one linking page carries. */
export interface WebAppManifestPageThemeColor {
  content: string;
  media: string | null;
}

/** One same-site web app manifest a page links, fetched once for the whole site (#710). */
export interface WebAppManifestData {
  /** Absolute manifest URL (the `href` resolved against the linking page). */
  url: string;
  status: number | null;
  error: string | null;
  contentType: string | null;
  /** Body text when fetched; null when the request failed or was skipped. */
  content: string | null;
  /** Throttled (429/430, or 503 with Retry-After): the status says nothing about the file. */
  rateLimited?: boolean;
  /** A WAF or bot challenge answered in place of the manifest. */
  wafBlocked?: boolean;
  /** Custom headers were withheld from this host: a 401 or 403 is unverified (#732). */
  headersWithheld?: boolean;
  /** Pages that link this manifest, sorted. */
  sourcePages: string[];
  /** Each linking page's theme-color metas, keyed by page URL. */
  themeColorsByPage: Record<string, WebAppManifestPageThemeColor[]>;
  icons: WebAppManifestIconCheck[];
}

/** A page the crawl fetched that `SiteData.pages` leaves out (pub#798). */
export interface FetchedTarget {
  url: string;
  status: number;
  rateLimited?: boolean;
  wafChallenge?: boolean;
}

export interface SiteData {
  baseUrl: string;
  /**
   * Where the crawl started: the URL it was given and where that URL's
   * redirects resolved (the crawl's `originalUrl` and `seedUrl`). The entry
   * page is the site's front door even when it is not `/`, as when the root
   * redirects to `/en/` or a sign-in page (#788). Absent on older callers.
   */
  entryUrls?: string[];
  pages: Array<{
    url: string;
    finalUrl?: string;
    statusCode: number;
    parsed: ParsedPage;
    headers?: Record<string, string>;
    redirectChain?: RedirectChain;
    /** Bytes of the stored HTML response, when the crawler recorded them. */
    sizeBytes?: number | null;
    /**
     * The page's HTML came from a browser render (see PageData.rendered). Read by
     * links/broken-anchors on the v1 path, where the DOM is present; the streaming
     * path takes the same judgement from ctx.collectedSignals.
     */
    rendered?: boolean;
    /**
     * The page record carries the version headers (X-Powered-By, X-AspNet-Version,
     * X-AspNetMvc-Version, X-Generator), so their absence from `headers` means
     * the server did not send them (#713). False or absent on a record stored
     * before they were recorded, where absence proves nothing.
     */
    versionHeadersRecorded?: boolean;
  }>;
  robotsTxt: RobotsTxtData | null;
  sitemaps: SitemapDiscovery | null;
  // Root requests the site refused (401/403/429, a bot wall): the crawler could
  // not observe those resources, so a rule must not report them as absent. Undefined reads as "nothing was refused".
  refusedFetches?: RefusedFetch[];
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
  /**
   * External links with their check results. Undefined when external link
   * checking did not run for this audit (`--offline`, `external_links.enabled
   * = false`, switched off for the website or run): rules must read that as "not checked",
   * never as "no external links" (repo#2729). An empty array means checking
   * ran and the pages link nowhere outside the site.
   */
  externalLinks?: ExternalLinkCheckData[];
  /**
   * True when the crawl did not follow links (Quick level, sitemap scope), so
   * internal link targets outside the seed and the sitemaps were never fetched
   * (repo#2729). Undefined reads as "links were followed".
   */
  linkDiscoveryOff?: boolean;
  /**
   * External link checking this audit (repo#2729): distinct external links
   * found, how many were checked, and the per-audit limit. Undefined when the
   * check did not run, or for callers that do not record it. `notRequested`:
   * links never requested because they look like an action or carry a token
   * (repo#2759), counted in `found` but not `checked`, with a sample.
   */
  externalLinkCheck?: {
    found: number;
    checked: number;
    cap: number;
    notRequested?: number;
    notRequestedLinks?: Array<{ href: string; sourcePages: string[]; pageCount?: number }>;
    /** pub#770: links never requested because the egress policy refuses their address. */
    refused?: number;
    /** Of those, the ones refused on the URL alone, before any were selected under the limit. */
    refusedByUrl?: number;
    refusedLinks?: Array<{ href: string; sourcePages: string[]; pageCount?: number }>;
    /** repo#2613: of the `checked` links, the ones the check ran out of time on. */
    outOfTime?: number;
  };
  /**
   * Status of internal link targets the crawl did not fetch, from the link
   * probe (repo#2729). Undefined when internal link checks were off.
   */
  linkTargetStatuses?: SitemapUrlStatusData[];
  /**
   * Pages the crawl fetched that are not in `pages`, so a link to one still has
   * a known answer (pub#798): one that did not parse as HTML (a PDF, or an
   * empty or corrupt body) and answered 2xx, or a 3xx whose redirect resolved;
   * one that answered with rate limiting (429/430); and a bot-wall challenge.
   * Absent on older callers.
   */
  fetchedTargets?: FetchedTarget[];
  /** What the internal link probe covered. Undefined when it did not run. */
  internalLinkProbe?: {
    unfetched: number;
    probed: number;
    cap: number;
    outOfScope?: number;
    /** The site's answer to a HEAD on a page it serves was 4xx/5xx, so no 4xx/5xx was trusted. */
    headUnreliable?: boolean;
  };
  resourceSizes?: {
    css: ResourceSizeData[];
    images: ResourceSizeData[];
    /** Font files pages reference directly, HEAD-sized at audit time. Absent
     * when nothing measured fonts (hand-built contexts, older callers). */
    fonts?: ResourceSizeData[];
  };
  scripts?: ScriptContentData[];
  // Same-site chunks pages preload (modulepreload, preload as=script) that no
  // <script src> names. Separate from `scripts` so the script rules' input is
  // unchanged; read by security/csp-blocks-own-resources only.
  preloadedScripts?: ScriptContentData[];
  /**
   * Third-party scripts, stylesheets and fonts the pages reference, status-checked
   * (#703). Separate from `resourceSizes` and `scripts`, so the size, compression
   * and script rules never see them. Undefined when the asset phase did not run.
   */
  externalAssets?: {
    scripts: ResourceSizeData[];
    css: ResourceSizeData[];
    fonts: ResourceSizeData[];
  };
  /**
   * Referenced URLs the asset fetch caps (`maxScripts`, `maxResources`) left
   * unfetched, per kind (#703). Absent or zero means nothing was dropped.
   */
  assetCapDropped?: {
    scripts?: number;
    css?: number;
    fonts?: number;
    externalScripts?: number;
    externalCss?: number;
    externalFonts?: number;
  };
  pdfSizes?: ResourceSizeData[];
  sitemapUrlStatuses?: SitemapUrlStatusData[];
  // Sitemap URLs on another site an own-site-only audit (`--offline`) left
  // unchecked (pub#807). Absent or zero means none were dropped.
  sitemapOffSiteSkipped?: number;
  // Web app manifests the pages link (`<link rel="manifest">`), one entry per
  // same-site manifest URL, with its icons checked (#710). Undefined when the
  // asset pass did not run (not checked); an empty array means no page links one.
  webAppManifests?: WebAppManifestData[];
  // Linked same-site manifest URLs past the per-site fetch cap, not fetched (#710).
  webAppManifestsDropped?: number;
  // Differential cloaking-probe results (#118). Undefined when the opt-in probe
  // is off; an empty array means it ran but found no suspicious paths to probe.
  cloakingProbes?: CloakingProbeData[];
  // Raw pages crawled this run vs the configured page cap (#697) — lets
  // site-scope rules tell "crawl was truncated by the coverage profile" apart
  // from "the crawler genuinely could not reach these pages". Undefined for
  // callers that haven't threaded it through (treat as not-capped).
  crawlLimits?: { pagesCrawled: number; maxPages: number };
  /**
   * In-scope URLs the crawl queued but never fetched (the frontier left when it
   * stopped). Zero or absent means the crawl ran to the end of what it knew of.
   * crawl/single-page-site reads it: a stopped crawl may just not have reached
   * the rest of the site.
   */
  unfetchedPages?: number;
  /**
   * Whether the audited site is itself being indexed (pub#457, see
   * `shared/noindex.ts` `isSiteIndexable`): its homepage, or the audit's entry
   * page when the homepage was not fetched, is indexable. Only `true` lets the
   * runner's `skipOnNoindex` gate and the site rules leave noindex pages out;
   * false (a staging or preview host) and undefined (neither page fetched, or a
   * caller that never set it) skip nothing. Part of the page-rule cache's run
   * context.
   */
  siteIndexable?: boolean;
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

  // Candidate API surface found passively in served JS and HTML, plus convention
  // paths for the detected stack (see endpoint-surface.ts). Deduped, same-origin
  // flagged, capped. Present only in a site pass whose engine ran the discovery
  // pass; undefined otherwise, which a rule must read as "no candidates known",
  // not "no endpoints". A cross-origin candidate has `probeEligible: false`.
  endpointSurface?: EndpointSurface;

  // The run's shared probing budget (see probe-budget.ts): the intensity level
  // and one wall-clock cap for ALL probing rules together. A probing rule asks
  // `ctx.probe.allows("quiet" | "loud")` before each request. Undefined must be
  // read as passive: no probe sends a request.
  probe?: ProbeBudget;

  // One TLS handshake to a host (`security/tls-certificate`). Injected only by a
  // runtime with TLS sockets that vets every address before connecting (the
  // CLI). Shared packages never open a socket themselves; undefined (cloud, an
  // embedder, tests) means the rule reports "not checked". Site rules only.
  tlsProbe?: TlsProbeFn;

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

  // The site's JSON-LD collapsed into one graph (#2091), built by audit-engine
  // BEFORE rules run for the same reason `intel` is: the entity rules stay
  // synchronous and pure, and nothing here has to parse JSON-LD again.
  //
  // It cannot come from `siteQuery`: that streams typed columns off
  // `page_features` (page type, schema types, rich-result types) and never
  // exposes raw JSON-LD, so the questions these rules ask — is this the same
  // Organization, does this `@id` resolve — are not answerable from it.
  //
  // Undefined means the map was not built for this run; the `schema/entity-*`
  // rules then skip rather than report a site with no structured data, because
  // those two look identical from here and only one of them is a finding.
  entityMap?: EntityMap;

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
export type {
  CheckItem,
  CheckResult,
  EntityMap,
  EntityMapEdge,
  EntityMapNode,
  LlmsTxtData,
  MarkdownProbeData,
  RobotsTxtData,
};
