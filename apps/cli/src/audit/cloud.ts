// Cloud prefetch glue — builds the inputs `prefetchCloudData` needs from the
// CLI's crawl artifacts (slim page payloads, enabled cloud rules, site sample).
// All credit/spend logic lives in @squirrelscan/audit-engine; this file only
// adapts CLI shapes.

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import type {
  AuditReport,
  CloudPagePayload,
  CloudServiceId,
  DomainStats,
  EditorSummary,
  EditorSummaryRequest,
  ReportTechnologies,
  SiteMetadata,
  SiteMetadataPagePayload,
  TechDetectPagePayload,
} from "@squirrelscan/core-contracts";
import type { Document } from "linkedom";

import {
  detectReportTechnologiesMulti,
  prefetchCloudData,
  renderedPageUrlsFrom,
  type CloudPrefetchResult,
} from "@squirrelscan/audit-engine";
import { computeCost } from "@squirrelscan/core-contracts";
import { SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import { buildEditorSummaryRequest } from "@squirrelscan/report";
import {
  filterRules,
  loadAllRules,
  type RuleCloudSpec,
} from "@squirrelscan/rules";

import type { ExternalBulkChecker, SiteContextPage } from "@/audit/adapter";
import type { Config } from "@/config";

import { buildBlocklistPayload } from "@/audit/cloud-payloads-blocklist";
import { buildGapsPayloads } from "@/audit/cloud-payloads-gaps";
import { logger } from "@/utils/logger";
import { getOrigin, getPathname } from "@/utils/url";

/** Server-enforced limit is 6KB/page; cap client-side so payloads stay slim. */
const MAX_EXCERPT_BYTES = 6_000;
/** Sanity caps for the other per-page fields — the services only classify, so
 * pathological pages (rendered mega-sites) must not inflate the batch body. */
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_HEADING_CHARS = 200;
/** Per inline-script byte cap for tech-detect (signatures match in the first KB). */
const MAX_TECH_SCRIPT_BYTES = 16 * 1024;
/** Tech-detect body budget as a fraction of maxBodyBytes; slack absorbs JSON escaping + envelope. */
const TECH_DETECT_BODY_BUDGET_RATIO = 0.9;

/**
 * Truncate to a UTF-8 BYTE budget (not UTF-16 code units — `slice(0, n)` can
 * yield up to 3× the bytes on multi-byte text, blowing the per-page cap and
 * the batch body limit). Never splits a code point.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  // ≤ maxBytes chars is always enough chars to fill maxBytes bytes.
  const sliced = text.slice(0, maxBytes);
  const encoded = new TextEncoder().encode(sliced);
  if (encoded.length <= maxBytes) return sliced;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
    encoded.subarray(0, maxBytes)
  );
  // Drop the replacement char(s) a mid-sequence cut produces.
  return decoded.replace(/�+$/, "");
}

/** Bytes of the JSON-serialized value — what the API's body limit measures. */
function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Largest byte-prefix of `home.html` for which the serialized single-page array
 * stays within `budget`. Binary search on the ACTUAL serialized size, so it is
 * correct regardless of JSON-escape inflation (a `"`/`\` doubles, a control char
 * sextuples — a fixed discount factor can't be trusted). Assumes the non-html
 * fields already fit (scripts are pre-capped by the caller); if even empty html
 * is over, it returns empty html.
 */
function shrinkHomeHtmlToFit(
  home: TechDetectPagePayload,
  budget: number
): TechDetectPagePayload {
  let lo = 0;
  let hi = new TextEncoder().encode(home.html).length;
  let best: TechDetectPagePayload = { ...home, html: "" };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = { ...home, html: truncateUtf8Bytes(home.html, mid) };
    if (jsonByteLength([candidate]) <= budget) {
      lo = mid;
      best = candidate; // reuse the accepted candidate instead of re-truncating
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Pack tech-detect pages under the server body limit. The server caps each page
 * (512KB html, 60 scripts) but NOT the aggregate, so 12 large rendered pages
 * reach ~6MB and exceed `maxBodyBytes` (5MB) — a 413 that silently kills the
 * whole step (#192). Always keep the home page (it carries the scripts array
 * detectors need), trimming its HTML if it alone is over; then append each
 * sample page that still fits. Size is measured by serialization, never
 * estimated. The caller pre-caps scripts (≤60 × 16KB) so the home page's
 * non-html fields can't alone exceed the budget; only its HTML is trimmed.
 */
export function fitTechDetectPages(
  home: TechDetectPagePayload,
  rest: TechDetectPagePayload[]
): TechDetectPagePayload[] {
  const budget = Math.floor(
    SERVICE_LIMITS.maxBodyBytes * TECH_DETECT_BODY_BUDGET_RATIO
  );
  const fittedHome =
    jsonByteLength([home]) > budget ? shrinkHomeHtmlToFit(home, budget) : home;
  const pages: TechDetectPagePayload[] = [fittedHome];
  for (const page of rest) {
    // `continue`, not `break`: sample order isn't size order, so a later smaller
    // page may still fit after a large one didn't.
    if (jsonByteLength([...pages, page]) <= budget) pages.push(page);
  }
  return pages;
}

export type { CloudPrefetchResult } from "@squirrelscan/audit-engine";

/** Enabled rules carrying a cloud spec, honouring the same enable/disable patterns as the runner. */
export function selectCloudRules(
  config: Config
): Array<{ id: string; cloud: RuleCloudSpec }> {
  const all = loadAllRules();
  const enabledIds = new Set(
    filterRules(
      [...all.keys()],
      config.rules.enable,
      config.rules.disable,
      // rule_options values are Record<string, unknown>; filterRules only
      // reads the optional `enabled` key, so this narrowing is safe.
      config.rule_options as Record<string, { enabled?: boolean }>
    )
  );
  const selected: Array<{ id: string; cloud: RuleCloudSpec }> = [];
  for (const [id, rule] of all) {
    if (rule.meta.cloud && enabledIds.has(id))
      selected.push({ id, cloud: rule.meta.cloud });
  }
  return selected;
}

/** Slim per-page payloads from successfully crawled, parsed HTML pages. */
export function buildCloudPagePayloads(
  siteContext: SiteContextPage[]
): CloudPagePayload[] {
  const payloads: CloudPagePayload[] = [];
  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const meta: Record<string, string> = {};
    if (parsed.meta.description)
      meta.description = parsed.meta.description.slice(
        0,
        MAX_DESCRIPTION_CHARS
      );
    payloads.push({
      url: page.url,
      title: parsed.meta.title?.slice(0, MAX_TITLE_CHARS) ?? undefined,
      textExcerpt: truncateUtf8Bytes(
        parsed.content.textContent,
        MAX_EXCERPT_BYTES
      ),
      meta: Object.keys(meta).length > 0 ? meta : undefined,
      headings: parsed.headings.headings
        .slice(0, 20)
        .map((h) => h.text.slice(0, MAX_HEADING_CHARS)),
    });
  }
  return payloads;
}

/** Visible links sampled per page for the metadata extractor (contacts/socials source). */
const MAX_VISIBLE_LINKS_PER_PAGE = 60;
/** Per-page meta-tag keys carried to the metadata extractor (identity signals). */
const MAX_META_TAGS_PER_PAGE = 40;

/**
 * Extract raw `<script type="application/ld+json">` block contents from a parsed
 * document, trimmed and non-empty. The metadata extractor reads Organization /
 * LocalBusiness JSON-LD for identity + contacts.
 */
function extractJsonLdBlocks(doc: Document): string[] {
  const out: string[] = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    const content = (script as Element).textContent?.trim();
    if (content) out.push(content);
  }
  return out;
}

/** og:* / twitter:* / name meta tags → a flat name→content map (identity signals). */
function extractMetaNameContent(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  const metas = doc.querySelectorAll("meta");
  for (const meta of metas) {
    const el = meta as Element;
    // og: uses `property`, twitter:/name uses `name` — accept either.
    const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "")
      .trim()
      .toLowerCase();
    const content = el.getAttribute("content");
    if (!key || content == null) continue;
    if (key in out) continue;
    out[key] = content;
    if (Object.keys(out).length >= MAX_META_TAGS_PER_PAGE) break;
  }
  return out;
}

/** `<link rel="alternate" hreflang="…">` locales declared on the page. */
function extractHreflangLocales(doc: Document): string[] {
  const out = new Set<string>();
  const links = doc.querySelectorAll('link[rel="alternate"][hreflang]');
  for (const link of links) {
    const lang = (link as Element).getAttribute("hreflang")?.trim();
    if (lang) out.add(lang);
  }
  return [...out];
}

/**
 * Visible `<a href>` anchors straight from the DOM. Unlike `parsed.links`
 * (which drops `mailto:`/`tel:`), this PRESERVES them — they are the literal
 * source the server's contact-echo post-validation reads (a phone/email may
 * only be surfaced if it appears in a visible link). Skips in-page (`#`),
 * `javascript:`, and `data:` hrefs as noise. Deduped, capped per page.
 */
function extractVisibleLinks(doc: Document): { href: string; text?: string }[] {
  const out: { href: string; text?: string }[] = [];
  const seen = new Set<string>();
  const anchors = doc.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    const href = (anchor as Element).getAttribute("href")?.trim();
    if (!href) continue;
    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("data:")
    )
      continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (anchor as Element).textContent?.trim();
    out.push({ href, ...(text ? { text } : {}) });
    if (out.length >= MAX_VISIBLE_LINKS_PER_PAGE) break;
  }
  return out;
}

/**
 * Build the Stage-0 metadata page payloads from crawled pages: home page first,
 * then a deterministic sample, capped at `metadataMaxPages`. Each carries the
 * raw identity signals (title, og/twitter meta, JSON-LD, visible links, lang,
 * hreflang) the server's extractor + RDAP read. The TOTAL JSON-LD payload is
 * bounded by `metadataMaxJsonLdBytes` so a schema-heavy page can't blow the body.
 */
export function buildMetadataPayload(
  siteContext: SiteContextPage[],
  baseUrl: string
): SiteMetadataPagePayload[] {
  // HTML pages with a 2xx body and a parsed document, home page first.
  const usable = siteContext.filter(
    ({ page, parsed }) =>
      parsed?.document != null && page.status >= 200 && page.status < 300
  );
  if (usable.length === 0) return [];

  // Identify the home page so it leads the sample (the extractor weights it
  // heaviest for identity). Try an exact URL match first; then, since the
  // crawler may have redirected the seed and getPages() has no stable order,
  // fall back to the page whose path IS the site root (origin or "/") before
  // defaulting to the first usable page.
  const baseOrigin = getOrigin(baseUrl);
  const isRoot = (u: string): boolean => {
    const path = getPathname(u);
    return getOrigin(u) === baseOrigin && (path === "" || path === "/");
  };
  let homeIdx = usable.findIndex(
    ({ page }) => page.finalUrl === baseUrl || page.url === baseUrl
  );
  if (homeIdx < 0) {
    homeIdx = usable.findIndex(
      ({ page }) => isRoot(page.finalUrl || page.url) || isRoot(page.url)
    );
  }
  const home = homeIdx >= 0 ? usable[homeIdx] : usable[0];
  const rest = usable
    .filter((p) => p !== home)
    .slice(0, SERVICE_LIMITS.metadataMaxPages - 1);
  const sampled = [home, ...rest];

  let jsonLdBudget = SERVICE_LIMITS.metadataMaxJsonLdBytes;
  const encoder = new TextEncoder();
  const payloads: SiteMetadataPagePayload[] = [];

  for (const { page, parsed } of sampled) {
    const doc = parsed?.document;
    if (!doc || !parsed) continue;

    // JSON-LD: include whole blocks until the shared byte budget is exhausted.
    const jsonLd: string[] = [];
    for (const block of extractJsonLdBlocks(doc)) {
      const size = encoder.encode(block).length;
      if (size > jsonLdBudget) continue;
      jsonLd.push(block);
      jsonLdBudget -= size;
    }

    const visibleLinks = extractVisibleLinks(doc);

    const lang = doc.documentElement?.getAttribute("lang")?.trim() || undefined;
    const hreflang = extractHreflangLocales(doc);

    payloads.push({
      url: page.finalUrl || page.url,
      title: parsed.meta.title ?? undefined,
      metaTags: extractMetaNameContent(doc),
      ...(jsonLd.length > 0 ? { jsonLd } : {}),
      ...(visibleLinks.length > 0 ? { visibleLinks } : {}),
      ...(lang ? { lang } : {}),
      ...(hreflang.length > 0 ? { hreflang } : {}),
    });
  }

  return payloads;
}

export interface RunCloudPrefetchOptions {
  client: CloudServicesClient | null;
  cloudConfig: CloudConfig;
  config: Config;
  siteContext: SiteContextPage[];
  baseUrl: string;
  auditId: string;
  /** Stage-1 gating policy (CLI-owned) threaded into the engine's prefetch. */
  gate?: (meta: SiteMetadata, service: CloudServiceId) => boolean;
  confirm?: (estimatedCredits: number, balance: number) => Promise<boolean>;
  onProgress?: (message: string) => void;
  /**
   * Fires after every request payload has been built (synchronously) and
   * before any network wait. The payload builders are the last DOM readers
   * before the rules phase, so the controller uses this to release the parsed
   * DOMs for the duration of the cloud round trips (#858).
   */
  onPayloadsBuilt?: () => void;
  /**
   * True only when the crawl rendered EVERY page (render strategy "all") — the
   * raw-vs-rendered `render` service is then wholly self-identical, so skip it
   * (#673). NOT set for "auto" (HTTP-first hybrid): most pages stay raw HTML
   * there, so render must still run — the per-page `PageData.rendered` guard
   * skips only the individual pages the crawl upgraded. Derive from the resolved
   * render fetcher (`documentFetcher?.id === "cloud-render"`), the single source
   * of truth, not `config.cloud.rendering`.
   */
  crawlRendered?: boolean;
}

/** One-call wrapper the audit controller uses for step 2.4. Never throws. */
export async function runCloudPrefetch(
  opts: RunCloudPrefetchOptions
): Promise<CloudPrefetchResult> {
  const rules = selectCloudRules(opts.config);
  const pages = buildCloudPagePayloads(opts.siteContext);

  // Site-unit payloads for blocklists + gaps. Absent payload (nothing to
  // check / no seeds) → that service skips `not-prefetched` without charging.
  const blocklist = buildBlocklistPayload(opts.siteContext);
  const sitePayloads = {
    ...(blocklist ? { "blocklist-check": blocklist } : {}),
    ...buildGapsPayloads(opts.siteContext, opts.baseUrl, opts.config),
    // Archive Indexing (#789) — the payload is just the site URL; the server
    // resolves the domain and runs the Wayback + Common Crawl lookups.
    "archive-indexing": { url: opts.baseUrl },
  };

  // Stage-0 metadata sample (home + a few pages) — drives gating + the profile.
  const metadataPages = buildMetadataPayload(opts.siteContext, opts.baseUrl);

  // Per-page render provenance (#673/#964): pages the crawl already rendered are skipped by the render
  // service (self-identical) so an "auto" hybrid crawl doesn't pay to re-render its upgraded pages.
  const renderedPageUrls = renderedPageUrlsFrom(opts.siteContext);

  opts.onPayloadsBuilt?.();

  return prefetchCloudData({
    client: opts.client,
    config: opts.cloudConfig,
    rules,
    pages,
    siteUrl: opts.baseUrl,
    sitePayloads,
    metadataPages,
    gate: opts.gate,
    auditId: opts.auditId,
    confirm: opts.confirm,
    onProgress: opts.onProgress,
    // Skip the raw-vs-rendered `render` service only when the crawl rendered EVERY page (#673). "auto" is
    // HTTP-first (most pages raw) → render must run there, so this is false for auto — the caller derives it
    // from the resolved render fetcher, not config.cloud.rendering (which can't tell "all" from "auto").
    crawlRendered: opts.crawlRendered ?? false,
    // Per-page skip for the pages an "auto" crawl already rendered (charge-free, rule-discarded otherwise).
    renderedPageUrls,
  });
}

/**
 * Build the cloud dead-links bulk checker for the external-links phase, or
 * null when cloud is off / logged out / the `links/dead-links` rule is not
 * enabled (its meta.cloud is the enable gate). Each call submits ≤200 urls;
 * the server charges `dead_links` per 100 urls. Throwing (402/auth/network)
 * is safe — the adapter falls back to local per-link checks.
 */
function buildDeadLinksBulkChecker(
  client: CloudServicesClient,
  auditId: string,
  onSpend?: (units: number, credits: number) => void
): ExternalBulkChecker {
  return async (urls) => {
    const res = await client.deadLinks({ auditId, urls });
    // Only successful calls are charged client-side: the server debits per
    // call (ceil(urls/100) credits) and refunds on total provider failure —
    // a failure throws above and is never counted here.
    onSpend?.(urls.length, computeCost("dead_links", urls.length));
    return new Map(
      res.results.map((r) => [
        r.url,
        {
          href: r.url,
          status: r.status,
          error: r.error ?? null,
          redirectTarget: r.redirectUrl ?? null,
          fromCache: r.fromCache,
        },
      ])
    );
  };
}

/**
 * Count distinct external link URLs across the crawled, parsed pages. Reads
 * the crawl-time extraction (`parsed.links`) instead of re-walking each DOM —
 * this feeds only the dead-links spend estimate, and it must not force DOMs
 * to stay resident (#858).
 */
function countExternalLinks(siteContext: SiteContextPage[]): number {
  const seen = new Set<string>();
  for (const { parsed } of siteContext) {
    if (!parsed) continue;
    for (const link of parsed.links) {
      // Crawl-time extraction keeps unparseable hrefs as error entries (with
      // isInternal=false); the DOM re-walk this replaced skipped those, so
      // filter them to keep the estimate equivalent.
      if (!link.isInternal && link.url && !link.error) seen.add(link.url);
    }
  }
  return seen.size;
}

/**
 * Resolve the cloud dead-links bulk checker for the external-links phase,
 * applying the SAME spend-confirmation gate as the STEP 2.4 cloud prefetch so
 * the user is never surprise-charged for `dead_links`.
 *
 * The dead-links charge happens in STEP 1.5, which runs BEFORE the prefetch
 * confirm in STEP 2.4 and lives outside its estimate + max_credits_per_audit
 * cap. Rather than reordering the external-links phase (its results feed rules
 * and storage), we gate the checker here: estimate `dead_links` credits from
 * the external link count, and when a TTY confirm callback exists and the
 * estimate exceeds `confirm_threshold`, prompt BEFORE the phase. A decline (or
 * cloud off / logged out / rule not enabled) returns null → the adapter falls
 * back to plain local per-link checks, preserving the never-fail invariant.
 */
export async function resolveDeadLinksBulkChecker(opts: {
  client: CloudServicesClient | null;
  config: Config;
  auditId: string;
  siteContext: SiteContextPage[];
  /** Preflight balance for the confirm prompt; absent → no balance shown. */
  getBalance?: () => Promise<number>;
  confirm?: (estimatedCredits: number, balance: number) => Promise<boolean>;
  /**
   * Called after every SUCCESSFUL bulk call with the urls submitted and the
   * credits the server debited for it. Lets the audit controller account
   * dead-links spend into `report.cloudSpend`.
   */
  onSpend?: (units: number, credits: number) => void;
}): Promise<ExternalBulkChecker | null> {
  const { client, config, auditId, siteContext, confirm } = opts;
  if (!client || !config.cloud.enabled) return null;
  const enabled = selectCloudRules(config).some(
    (r) => r.id === "links/dead-links"
  );
  if (!enabled) return null;

  const linkCount = countExternalLinks(siteContext);
  if (linkCount === 0) return null;

  const estimate = computeCost("dead_links", linkCount);

  // Mirror the prefetch confirm gate: only prompt above the threshold, and only
  // when a confirm callback is available (TTY). Non-TTY/--yes proceeds silently,
  // bounded by the server-side per-url charge.
  if (confirm && estimate > config.cloud.confirm_threshold) {
    let balance = 0;
    try {
      balance = (await opts.getBalance?.()) ?? 0;
    } catch (error) {
      // Balance read failed; fall back to local checking rather than charge
      // without a clear estimate to show the user.
      logger.debug(
        "dead-links balance preflight failed; using local checks",
        (error as Error).message
      );
      return null;
    }
    const proceed = await confirm(estimate, balance);
    if (!proceed) return null;
  }

  return buildDeadLinksBulkChecker(client, auditId, opts.onSpend);
}

// ── Cloud technology detection (credited, report-only) ─────────────

/** Extract `<script src>` values from raw HTML (substring patterns match either). */
function extractScriptSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Extract `<meta name=… content=…>` tags from HTML into a name→content map.
 * The crawler's curated MetaData drops `generator` (the key CMS signal), so we
 * parse it back out here to feed the `meta` detectors precisely. The `html`
 * detectors are the backstop for any tag this misses (e.g. content-first order).
 */
function extractMetaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Parse each <meta> tag and read its name/content attrs INDEPENDENTLY so
  // either attribute order works — some CMSes (Joomla, Drupal) emit
  // `<meta content="…" name="generator">`, and `generator` is the key CMS signal.
  const tagRe = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const t = tag[0];
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(t)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(t)?.[1];
    if (name && content !== undefined) {
      const key = name.toLowerCase();
      if (!(key in out)) out[key] = content;
    }
  }
  return out;
}

/** Map the crawler's curated response/security headers to a lowercase header map. */
function buildHeaderMap(page: SiteContextPage["page"]): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | null | undefined) => {
    if (v) out[k] = v;
  };
  const h = page.headers;
  put("content-type", h.contentType);
  put("server", h.server);
  put("x-cache", h.xCache);
  put("cf-cache-status", h.cfCacheStatus);
  put("x-vercel-cache", h.xVercelCache);
  put("cache-control", h.cacheControl);
  put("vary", h.vary);
  put("link", h.link);
  put("server-timing", h.serverTiming);
  put("alt-svc", h.altSvc);
  put("content-encoding", h.contentEncoding);
  // CSP often allowlists vendor script origins (stripe, sentry, …) — a useful
  // detection signal carried in the curated security headers.
  put("content-security-policy", page.securityHeaders.csp);
  return out;
}

/** Scripts the resource-fetch phase pulled (url always; content when fetched). */
export interface FetchedScript {
  url: string;
  content?: string | null;
}

export interface RunCloudTechDetectOptions {
  client: CloudServicesClient | null;
  config: Config;
  auditId: string;
  baseUrl: string;
  siteContext: SiteContextPage[];
  /** Fetched scripts from the resource-assets phase (carries inline content). */
  scripts: FetchedScript[];
  /** Preflight balance for the confirm prompt; absent → no balance shown. */
  getBalance?: () => Promise<number>;
  confirm?: (estimatedCredits: number, balance: number) => Promise<boolean>;
  onProgress?: (message: string) => void;
  /** Called once after a SUCCESSFUL charged call with the credits debited. */
  onSpend?: (credits: number) => void;
}

export interface CloudTechDetectResult {
  technologies: ReportTechnologies;
  credits: number;
  balanceAfter: number | null;
}

/**
 * Run the credited cloud `tech-detect` service and return the report-ready
 * technologies section, or null when it's off / logged out / nothing to scan.
 *
 * Auto-runs for logged-in users when `cloud.enabled` AND `cloud.technologies`.
 * Never throws (every failure → null), preserving the never-fail-the-audit
 * invariant. Applies the SAME confirm gate as the prefetch: only prompts when a
 * TTY confirm exists and the (flat 5-credit) estimate exceeds `confirm_threshold`.
 */
export async function runCloudTechDetect(
  opts: RunCloudTechDetectOptions
): Promise<CloudTechDetectResult | null> {
  const { client, config, auditId, baseUrl, siteContext, confirm } = opts;
  if (!client || !config.cloud.enabled || !config.cloud.technologies)
    return null;

  // Everything below is wrapped so the never-fail-the-audit invariant holds even
  // if payload construction, the confirm callback, or the network call throws.
  try {
    // HTML pages with a 2xx body, home page first.
    const htmlPages = siteContext.filter(
      (p) => p.page.html && p.page.status >= 200 && p.page.status < 300
    );
    if (htmlPages.length === 0) return null;

    const homeIdx = htmlPages.findIndex(
      (p) => p.page.finalUrl === baseUrl || p.page.url === baseUrl
    );
    const home = homeIdx >= 0 ? htmlPages[homeIdx] : htmlPages[0];
    const rest = htmlPages
      .filter((p) => p !== home)
      .slice(0, SERVICE_LIMITS.techDetectMaxPages - 1);

    const cap = SERVICE_LIMITS.techDetectMaxHtmlBytes;

    // Home page carries a COMPLETE scripts array: every <script src> in the HTML
    // (so script-url detectors see all origins) merged with fetched inline
    // content (so script-content detectors work). detect.ts only scans the array
    // when present, so a partial array would regress url detection — hence the union.
    const contentByUrl = new Map<string, string>();
    for (const s of opts.scripts)
      if (s.content) contentByUrl.set(s.url, s.content);
    const homeHtml = home.page.html ?? "";
    const homeScriptUrls = new Set<string>(extractScriptSrcs(homeHtml));
    for (const s of opts.scripts) homeScriptUrls.add(s.url);
    const homeScripts = [...homeScriptUrls]
      .slice(0, SERVICE_LIMITS.techDetectMaxScriptsPerPage)
      .map((url) => {
        const content = contentByUrl.get(url);
        return {
          url,
          content:
            content === undefined
              ? undefined
              : truncateUtf8Bytes(content, MAX_TECH_SCRIPT_BYTES),
        };
      });

    const homePayload: TechDetectPagePayload = {
      url: home.page.finalUrl || home.page.url,
      headers: buildHeaderMap(home.page),
      html: truncateUtf8Bytes(homeHtml, cap),
      meta: extractMetaTags(homeHtml),
      scripts: homeScripts,
    };
    // Other sampled pages: no scripts array → script-url detectors fall back to
    // scanning the page HTML (which still contains the <script src> tags).
    const restPayloads: TechDetectPagePayload[] = rest.map((p) => {
      const html = truncateUtf8Bytes(p.page.html ?? "", cap);
      return {
        url: p.page.finalUrl || p.page.url,
        headers: buildHeaderMap(p.page),
        html,
        meta: extractMetaTags(html),
      };
    });

    // Bound the AGGREGATE body so a rendered multi-page sample never 413s (#192).
    const pages = fitTechDetectPages(homePayload, restPayloads);

    const estimate = computeCost("tech_detect", 1);
    if (confirm && estimate > config.cloud.confirm_threshold) {
      const balance = (await opts.getBalance?.()) ?? 0;
      const proceed = await confirm(estimate, balance);
      if (!proceed) return null;
    }

    opts.onProgress?.("cloud: technologies");
    const res = await client.detectTechnologies({
      auditId,
      url: baseUrl,
      pages,
    });
    const credits = estimate;
    opts.onSpend?.(credits);
    return {
      technologies: {
        items: res.technologies,
        added: res.added,
        removed: res.removed,
        firstScan: res.firstScan,
        ...(res.advisories && res.advisories.length > 0
          ? { advisories: res.advisories }
          : {}),
      },
      credits,
      balanceAfter: null,
    };
  } catch (error) {
    // Any failure (payload build / confirm / 402 / auth / network / 5xx) →
    // degrade silently (no technologies section). Never fails the audit, but
    // surface a concise reason inline (parity with ai-parse) so it's diagnosable
    // instead of a bare "failed".
    const detail = error instanceof Error ? error.message : String(error);
    opts.onProgress?.(
      `cloud: technologies failed (${detail.length > 120 ? `${detail.slice(0, 117)}...` : detail})`
    );
    logger.debug("tech-detect skipped", detail);
    return null;
  }
}

export interface LocalTechDetectOptions {
  baseUrl: string;
  siteContext: SiteContextPage[];
  /** Fetched scripts from the resource-assets phase (carries inline content). */
  scripts: FetchedScript[];
}

/**
 * Free, no-HTTP (sync) base tech scan over the crawled pages so every audit
 * surfaces the stack when the credited cloud tech-detect is skipped (quick /
 * logged-out) (#407). Home page first (carries the fetched scripts array), capped;
 * null when nothing is detected so a weak local guess never clears synced tech.
 */
export function detectLocalTechnologies(
  opts: LocalTechDetectOptions
): ReportTechnologies | null {
  try {
    const htmlPages = opts.siteContext.filter(
      (p) => p.page.html && p.page.status >= 200 && p.page.status < 300
    );
    if (htmlPages.length === 0) return null;
    const home =
      htmlPages.find(
        (p) => p.page.finalUrl === opts.baseUrl || p.page.url === opts.baseUrl
      ) ?? htmlPages[0];
    const ordered = [home, ...htmlPages.filter((p) => p !== home)].slice(
      0,
      SERVICE_LIMITS.techDetectMaxPages
    );
    const homeScripts = opts.scripts.map((s) => ({
      url: s.url,
      content: s.content ?? undefined,
    }));
    const section = detectReportTechnologiesMulti(
      ordered.map((p) => ({
        url: p.page.finalUrl || p.page.url,
        headers: buildHeaderMap(p.page),
        html: p.page.html ?? "",
        scripts: p === home ? homeScripts : [],
      }))
    );
    return section.items.length > 0 ? section : null;
  } catch (error) {
    logger.debug(
      "local tech-detect skipped",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

// ── Cloud editor's summary (credited, report-only) ───────

export interface RunCloudEditorSummaryOptions {
  client: CloudServicesClient | null;
  config: Config;
  auditId: string;
  /** Completed audit report — the digest is built from its scores + issues. */
  report: AuditReport;
  /** Deltas vs the previous audit, when the caller has a prior run. */
  delta?: EditorSummaryRequest["delta"];
  /** Preflight balance for the confirm prompt; absent → no balance shown. */
  getBalance?: () => Promise<number>;
  confirm?: (estimatedCredits: number, balance: number) => Promise<boolean>;
  onProgress?: (message: string) => void;
  /** Called once after a SUCCESSFUL charged call with the credits debited. */
  onSpend?: (credits: number) => void;
}

export interface CloudEditorSummaryResult {
  editorSummary: EditorSummary;
  credits: number;
}

/**
 * Run the credited cloud `editor-summary` service and return the report-ready
 * editor's summary, or null when it's off / logged out / out of credits / nothing
 * to summarize.
 *
 * Auto-runs for logged-in users when `cloud.enabled` AND `cloud.editor_summary`.
 * Runs on any signed-in plan (#684); the server enforces only the credit charge
 * (out of credits → 402) — the CLI is a thin wrapper. Never throws (every failure →
 * null), preserving the never-fail-the-audit invariant. Applies the SAME confirm
 * gate as the prefetch: only prompts when a TTY confirm exists and the (flat)
 * estimate exceeds `confirm_threshold`.
 */
export async function runCloudEditorSummary(
  opts: RunCloudEditorSummaryOptions
): Promise<CloudEditorSummaryResult | null> {
  const { client, config, auditId, report, confirm } = opts;
  if (!client || !config.cloud.enabled || !config.cloud.editor_summary)
    return null;

  // Nothing to summarize on an empty crawl (no pages / no findings).
  if (report.totalPages === 0) return null;

  try {
    const request = buildEditorSummaryRequest(report, {
      auditId,
      delta: opts.delta,
    });

    const estimate = computeCost("editor_summary", 1);
    if (confirm && estimate > config.cloud.confirm_threshold) {
      const balance = (await opts.getBalance?.()) ?? 0;
      const proceed = await confirm(estimate, balance);
      if (!proceed) return null;
    }

    opts.onProgress?.("cloud: editor's summary");
    const res = await client.editorSummary(request);
    // A digest-cache hit (#1012) is served free — never bill it or report it
    // as spend (same contract as the domain-stats 30-day cache below).
    const credits = res.cached ? 0 : estimate;
    if (credits > 0) opts.onSpend?.(credits);
    return {
      editorSummary: {
        prose: res.prose,
        bigTicket: res.bigTicket,
        verdict: res.verdict,
        model: res.model,
        generatedAt: res.generatedAt,
      },
      credits,
    };
  } catch (error) {
    // Any failure (402 out of credits / auth / network / 5xx / build) →
    // degrade silently (no editor-summary section). Never fails the audit.
    opts.onProgress?.("cloud: editor's summary skipped");
    logger.debug("editor-summary skipped", (error as Error).message);
    return null;
  }
}

// ── Cloud domain stats (credited, report-only) ───────────

export interface RunCloudDomainStatsOptions {
  client: CloudServicesClient | null;
  config: Config;
  auditId: string;
  baseUrl: string;
  /** Registered website id, when this audit is tied to a tracked site. */
  websiteId?: string;
  /** Preflight balance for the confirm prompt; absent → no balance shown. */
  getBalance?: () => Promise<number>;
  confirm?: (estimatedCredits: number, balance: number) => Promise<boolean>;
  onProgress?: (message: string) => void;
  /** Called once after a SUCCESSFUL charged call with the credits debited. */
  onSpend?: (credits: number) => void;
}

export interface CloudDomainStatsResult {
  domainStats: DomainStats;
  credits: number;
}

/**
 * Run the credited cloud `domain-stats` service and return the report-ready
 * domain stats, or null when it's off / logged out / out of credits / no data.
 *
 * Auto-runs for logged-in users when `cloud.enabled` AND `cloud.domain_stats`.
 * Runs on any signed-in plan (#684); the server enforces the 30-day cache and the
 * credit charge (out of credits → 402) — the CLI is a thin wrapper. A 30-day cache
 * HIT is served at 0 credits (`cached: true`) — never reported as spend. A domain
 * with no SEO footprint gets 404 `no_data` (uncharged) and degrades to null.
 * Never throws (every failure → null), preserving the never-fail invariant.
 * Applies the SAME confirm gate as the prefetch.
 */
export async function runCloudDomainStats(
  opts: RunCloudDomainStatsOptions
): Promise<CloudDomainStatsResult | null> {
  const { client, config, auditId, baseUrl, confirm } = opts;
  if (!client || !config.cloud.enabled || !config.cloud.domain_stats)
    return null;

  try {
    const estimate = computeCost("domain_stats", 1);
    if (confirm && estimate > config.cloud.confirm_threshold) {
      const balance = (await opts.getBalance?.()) ?? 0;
      const proceed = await confirm(estimate, balance);
      if (!proceed) return null;
    }

    opts.onProgress?.("cloud: domain stats");
    const res = await client.domainStats({
      auditId,
      url: baseUrl,
      ...(opts.websiteId ? { websiteId: opts.websiteId } : {}),
    });
    // A 30-day cache hit is served free — never bill it or report it as spend.
    const credits = res.cached ? 0 : estimate;
    if (credits > 0) opts.onSpend?.(credits);
    return {
      domainStats: {
        domain: res.domain,
        metrics: res.metrics,
        capturedAt: res.capturedAt,
      },
      credits,
    };
  } catch (error) {
    // Any failure (no_data 404 / 402 out of credits / auth / network / 5xx) →
    // degrade silently (no domain-stats section). Never fails the audit.
    opts.onProgress?.("cloud: domain stats skipped");
    logger.debug("domain-stats skipped", (error as Error).message);
    return null;
  }
}
