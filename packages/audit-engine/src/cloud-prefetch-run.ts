// Container-side cloud-prefetch orchestration (#353). Mirrors the CLI's
// runCloudPrefetch (apps/cli/src/audit/cloud.ts) but built from package-only deps
// so runCloudAudit can charge the prefetch services at CLI-parity through the same
// paid /v1/services/* gate. Approach B (replicate, not extract) — the live CLI path
// is untouched; the single DEBIT still happens once in /v1/services/* (chargeOrReplay).
// The parity test (full charge + result set) guards against drift; unify later (#353 tech-debt).

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type {
  AuditReport,
  CloudPagePayload,
  CloudServiceId,
  DomainStats,
  EditorSummary,
  SiteMetadata,
  SiteMetadataPagePayload,
  SiteType,
} from "@squirrelscan/core-contracts";
import { computeCost } from "@squirrelscan/core-contracts/credits";
import { SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import type { Config } from "@squirrelscan/config";
import { buildEditorSummaryRequest } from "@squirrelscan/report/editor-summary";
import { filterRules, loadAllRules, type RuleCloudSpec } from "@squirrelscan/rules";
import { getHostname, getOrigin, getPathname, hasUnsafeUrlScheme } from "@squirrelscan/utils/url";

import {
  prefetchCloudData,
  type CloudPrefetchResult,
  type CloudSitePayloads,
} from "./cloud-prefetch";
import { renderedPageUrlsFrom, releaseSiteContextDocuments, type SiteContextPage } from "./adapter";

// The parsed page's linkedom Document, without adding a direct linkedom dep here.
type Document = NonNullable<NonNullable<SiteContextPage["parsed"]>["document"]>;

// Server-enforced 6KB/page excerpt; the other caps keep pathological pages from
// inflating the batch body. Mirrors apps/cli/src/audit/cloud.ts.
const MAX_EXCERPT_BYTES = 6_000;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_HEADING_CHARS = 200;

/** Truncate to a UTF-8 BYTE budget without splitting a code point (mirrors the CLI). */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const sliced = text.slice(0, maxBytes);
  const encoded = new TextEncoder().encode(sliced);
  if (encoded.length <= maxBytes) return sliced;
  const decoded = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return decoded.replace(/�+$/, "");
}

/** Cloud-gated rules that are enabled under this config (drives which services run). */
export function selectCloudRules(config: Config): Array<{ id: string; cloud: RuleCloudSpec }> {
  const all = loadAllRules();
  const enabledIds = new Set(
    filterRules(
      [...all.keys()],
      config.rules.enable,
      config.rules.disable,
      config.rule_options as Record<string, { enabled?: boolean }>,
    ),
  );
  const selected: Array<{ id: string; cloud: RuleCloudSpec }> = [];
  for (const [id, rule] of all) {
    if (rule.meta.cloud && enabledIds.has(id)) selected.push({ id, cloud: rule.meta.cloud });
  }
  return selected;
}

/** Slim per-page payloads from successfully crawled, parsed pages (mirrors the CLI). */
export function buildCloudPagePayloads(siteContext: SiteContextPage[]): CloudPagePayload[] {
  const payloads: CloudPagePayload[] = [];
  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const meta: Record<string, string> = {};
    if (parsed.meta.description)
      meta.description = parsed.meta.description.slice(0, MAX_DESCRIPTION_CHARS);
    payloads.push({
      url: page.url,
      title: parsed.meta.title?.slice(0, MAX_TITLE_CHARS) ?? undefined,
      textExcerpt: truncateUtf8Bytes(parsed.content.textContent, MAX_EXCERPT_BYTES),
      meta: Object.keys(meta).length > 0 ? meta : undefined,
      headings: parsed.headings.headings
        .slice(0, 20)
        .map((h) => h.text.slice(0, MAX_HEADING_CHARS)),
    });
  }
  return payloads;
}

// ── Stage-0 site-metadata payload (mirrors apps/cli/src/audit/cloud.ts) ──────────
const MAX_VISIBLE_LINKS_PER_PAGE = 60;
const MAX_META_TAGS_PER_PAGE = 40;

function extractJsonLdBlocks(doc: Document): string[] {
  const out: string[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const content = (script as Element).textContent?.trim();
    if (content) out.push(content);
  }
  return out;
}

function extractMetaNameContent(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  for (const meta of doc.querySelectorAll("meta")) {
    const el = meta as Element;
    const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").trim().toLowerCase();
    const content = el.getAttribute("content");
    if (!key || content == null || key in out) continue;
    out[key] = content;
    if (Object.keys(out).length >= MAX_META_TAGS_PER_PAGE) break;
  }
  return out;
}

function extractHreflangLocales(doc: Document): string[] {
  const out = new Set<string>();
  for (const link of doc.querySelectorAll('link[rel="alternate"][hreflang]')) {
    const lang = (link as Element).getAttribute("hreflang")?.trim();
    if (lang) out.add(lang);
  }
  return [...out];
}

function extractVisibleLinks(doc: Document): { href: string; text?: string }[] {
  const out: { href: string; text?: string }[] = [];
  const seen = new Set<string>();
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const href = (anchor as Element).getAttribute("href")?.trim();
    if (!href || href.trimStart().startsWith("#") || hasUnsafeUrlScheme(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (anchor as Element).textContent?.trim();
    out.push({ href, ...(text ? { text } : {}) });
    if (out.length >= MAX_VISIBLE_LINKS_PER_PAGE) break;
  }
  return out;
}

/** Stage-0 metadata sample (home first, then a deterministic few) — mirrors the CLI. */
export function buildMetadataPayload(
  siteContext: SiteContextPage[],
  baseUrl: string,
): SiteMetadataPagePayload[] {
  const usable = siteContext.filter(
    ({ page, parsed }) => parsed?.document != null && page.status >= 200 && page.status < 300,
  );
  if (usable.length === 0) return [];

  const baseOrigin = getOrigin(baseUrl);
  const isRoot = (u: string): boolean => {
    const path = getPathname(u);
    return getOrigin(u) === baseOrigin && (path === "" || path === "/");
  };
  let homeIdx = usable.findIndex(({ page }) => page.finalUrl === baseUrl || page.url === baseUrl);
  if (homeIdx < 0) {
    homeIdx = usable.findIndex(({ page }) => isRoot(page.finalUrl || page.url) || isRoot(page.url));
  }
  const home = homeIdx >= 0 ? usable[homeIdx] : usable[0];
  const rest = usable.filter((p) => p !== home).slice(0, SERVICE_LIMITS.metadataMaxPages - 1);
  const sampled = [home, ...rest];

  let jsonLdBudget = SERVICE_LIMITS.metadataMaxJsonLdBytes;
  const encoder = new TextEncoder();
  const payloads: SiteMetadataPagePayload[] = [];

  for (const entry of sampled) {
    const parsed = entry?.parsed;
    const doc = parsed?.document;
    if (!entry || !doc || !parsed) continue;

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
      url: entry.page.finalUrl || entry.page.url,
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

// ── blocklist-check site payload (mirrors apps/cli/src/audit/cloud-payloads-blocklist.ts) ──
const BL_MAX_URLS = 1_500;
const BL_MAX_SELECTORS = 500;
const BL_MAX_SELECTOR_PAGES = 20;
const SIMPLE_TOKEN_RE = /^[A-Za-z][\w-]*$/;

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function collectBlocklistUrls(siteContext: SiteContextPage[]): string[] {
  const urls = new Set<string>();
  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const pageHost = getHostname(page.url);
    for (const link of parsed.links) {
      if (urls.size >= BL_MAX_URLS) return [...urls];
      if (!link.isInternal && isHttpUrl(link.url)) urls.add(link.url);
    }
    for (const image of parsed.images) {
      if (urls.size >= BL_MAX_URLS) return [...urls];
      if (isHttpUrl(image.src) && getHostname(image.src) !== pageHost) urls.add(image.src);
    }
    const doc = parsed.document;
    if (!doc) continue;
    for (const script of doc.querySelectorAll("script[src]")) {
      if (urls.size >= BL_MAX_URLS) return [...urls];
      const src = (script as Element).getAttribute("src");
      if (src && isHttpUrl(src) && getHostname(src) !== pageHost) urls.add(src);
    }
  }
  return [...urls];
}

function collectBlocklistSelectors(siteContext: SiteContextPage[]): string[] {
  const selectors = new Set<string>();
  let pagesScanned = 0;
  for (const { page, parsed } of siteContext) {
    if (selectors.size >= BL_MAX_SELECTORS || pagesScanned >= BL_MAX_SELECTOR_PAGES) break;
    if (!parsed?.document || page.status < 200 || page.status >= 300) continue;
    pagesScanned++;
    let elements: Iterable<Element>;
    try {
      elements = parsed.document.querySelectorAll("[class], [id]");
    } catch {
      continue;
    }
    for (const el of elements) {
      if (selectors.size >= BL_MAX_SELECTORS) break;
      const id = el.getAttribute("id");
      if (id && SIMPLE_TOKEN_RE.test(id)) selectors.add(`#${id}`);
      const classAttr = el.getAttribute("class");
      if (!classAttr) continue;
      for (const cls of classAttr.split(/\s+/)) {
        if (selectors.size >= BL_MAX_SELECTORS) break;
        if (cls && SIMPLE_TOKEN_RE.test(cls)) selectors.add(`.${cls}`);
      }
    }
  }
  return [...selectors];
}

export function buildBlocklistPayload(
  siteContext: SiteContextPage[],
): { urls: string[]; selectors: string[] } | null {
  const urls = collectBlocklistUrls(siteContext);
  const selectors = collectBlocklistSelectors(siteContext);
  if (urls.length === 0 && selectors.length === 0) return null;
  return { urls, selectors };
}

// ── keyword/content gaps payloads (mirrors apps/cli/src/audit/cloud-payloads-gaps.ts) ──
const MIN_SEED_LENGTH = 3;
const MAX_SEED_LENGTH = 80;
const TITLE_SEPARATOR_CHARS = new Set(["|", "·", "—", "–"]);

export type GapsPayloads = Pick<CloudSitePayloads, "keyword-gaps" | "content-gaps">;

interface GapsRuleOptions {
  country?: string;
  language?: string;
  competitors?: string[];
}

function apexDomain(baseUrl: string): string {
  const host = getHostname(baseUrl).toLowerCase().replace(/\.+$/, "");
  return host.startsWith("www.") ? host.slice(4) : host;
}

function gapsOptions(config: Config, ruleId: string): GapsRuleOptions {
  const raw = (config.rule_options[ruleId] ?? {}) as {
    country?: unknown;
    language?: unknown;
    competitors?: unknown;
  };
  const opts: GapsRuleOptions = {};
  if (typeof raw.country === "string" && raw.country) opts.country = raw.country;
  if (typeof raw.language === "string" && raw.language) opts.language = raw.language;
  if (Array.isArray(raw.competitors)) {
    const competitors = raw.competitors
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(0, SERVICE_LIMITS.gapsMaxCompetitors);
    if (competitors.length > 0) opts.competitors = competitors;
  }
  return opts;
}

function cleanSeed(text: string): string | null {
  let separator = text.length;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (
      TITLE_SEPARATOR_CHARS.has(char) ||
      (char === "-" &&
        i > 0 &&
        i + 1 < text.length &&
        text[i - 1].trim() === "" &&
        text[i + 1].trim() === "")
    ) {
      separator = i;
      break;
    }
  }
  const raw = text.slice(0, separator).trim();
  const parts: string[] = [];
  let inWhitespace = false;
  for (const char of raw) {
    if (char.trim() === "") {
      inWhitespace = true;
    } else {
      if (inWhitespace && parts.length > 0) parts.push(" ");
      parts.push(char);
      inWhitespace = false;
    }
  }
  const segment = parts.join("");
  if (segment.length < MIN_SEED_LENGTH || segment.length > MAX_SEED_LENGTH) return null;
  return segment;
}

function collectSeeds(siteContext: SiteContextPage[]): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const candidates = [parsed.meta.title ?? "", ...parsed.h1.texts];
    for (const candidate of candidates) {
      const seed = cleanSeed(candidate);
      if (!seed) continue;
      const key = seed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push(seed);
      if (seeds.length >= SERVICE_LIMITS.gapsMaxSeeds) return seeds;
    }
  }
  return seeds;
}

export function buildGapsPayloads(
  siteContext: SiteContextPage[],
  baseUrl: string,
  config: Config,
): GapsPayloads {
  const domain = apexDomain(baseUrl);
  const seeds = collectSeeds(siteContext);
  if (!domain || seeds.length === 0) return {};
  const keywordOpts = gapsOptions(config, "gaps/keywords");
  const contentOpts = gapsOptions(config, "gaps/content");
  return {
    "keyword-gaps": {
      domain,
      country: keywordOpts.country,
      language: keywordOpts.language,
      competitors: keywordOpts.competitors,
      seedKeywords: seeds,
    },
    "content-gaps": {
      domain,
      country: contentOpts.country,
      language: contentOpts.language,
      competitors: contentOpts.competitors,
      coveredTopics: seeds,
    },
  };
}

// ── Stage-1 gating policy (mirrors apps/cli/src/audit/cloud-gating.ts) ──
const GAP_SKIP_SITE_TYPES: ReadonlySet<SiteType> = new Set(["personal", "portfolio"]);
const AUTHORITY_SITE_TYPES: ReadonlySet<SiteType> = new Set([
  "blog",
  "news",
  "healthcare_provider",
]);

export const gateStage1 = (meta: SiteMetadata, service: CloudServiceId): boolean => {
  switch (service) {
    case "keyword-gaps":
    case "content-gaps":
      return !GAP_SKIP_SITE_TYPES.has(meta.siteType);
    case "authority-signals":
      return meta.isYMYL || AUTHORITY_SITE_TYPES.has(meta.siteType);
    default:
      return true;
  }
};

export interface ContainerPrefetchInput {
  client: CloudServicesClient;
  /** Full config — drives rule selection (config.rules) + prefetch (config.cloud). */
  config: Config;
  siteContext: SiteContextPage[];
  siteUrl: string;
  auditId: string;
  /** Credits left after render + tech-detect; bounds prefetch spend. */
  remainingBudget: number;
  /**
   * True only when the crawl rendered EVERY page (renderMode "all") — the
   * raw-vs-rendered `render` service is then wholly self-identical, so skip it
   * (#673). "auto" is HTTP-first (most pages raw) → false, so render still runs.
   * The caller MUST derive this from the container's actual render decision
   * (`renderMode`), NOT `config.cloud.rendering` (unset on the container path).
   */
  crawlRendered: boolean;
}

/**
 * Run the cloud-prefetch services for a container audit, capped to the remaining
 * budget. Returns null when there's nothing to prefetch (no cloud rules, or the
 * budget is exhausted). The prefetch engine debits each service through
 * /v1/services/* (chargeOrReplay) and stops at the cap / on a 402.
 */
export async function runContainerCloudPrefetch(
  input: ContainerPrefetchInput,
): Promise<CloudPrefetchResult | null> {
  if (input.remainingBudget <= 0) return null;
  const rules = selectCloudRules(input.config);
  if (rules.length === 0) return null;

  const pages = buildCloudPagePayloads(input.siteContext);
  const metadataPages = buildMetadataPayload(input.siteContext, input.siteUrl);
  const blocklist = buildBlocklistPayload(input.siteContext);
  const sitePayloads: CloudSitePayloads = {
    ...(blocklist ? { "blocklist-check": blocklist } : {}),
    ...buildGapsPayloads(input.siteContext, input.siteUrl, input.config),
    // Archive Indexing (#789) — payload is just the site URL.
    "archive-indexing": { url: input.siteUrl },
  };
  // 0 = unlimited in the cloud config; we always have a finite cap from /cloud,
  // so pass the remaining budget as the per-audit ceiling.
  const cap = Number.isFinite(input.remainingBudget)
    ? Math.max(0, Math.floor(input.remainingBudget))
    : 0;

  // Per-page render provenance (#673/#964): the render service skips pages the crawl already rendered, so an
  // "auto" hybrid crawl doesn't pay to re-render its upgraded pages. Built before the document release below.
  const renderedPageUrls = renderedPageUrlsFrom(input.siteContext);

  // Payloads built — nothing reads the DOMs again until the rules phase
  // (runRulesOnStorage re-materializes idempotently), so drop them for the
  // network waits. Mirrors the CLI's onPayloadsBuilt release; matters more
  // here since the container runs under a fixed memory ceiling (#858).
  releaseSiteContextDocuments(input.siteContext);

  return prefetchCloudData({
    client: input.client,
    config: { ...input.config.cloud, max_credits_per_audit: cap },
    rules,
    pages,
    metadataPages,
    sitePayloads,
    gate: gateStage1,
    siteUrl: input.siteUrl,
    auditId: input.auditId,
    // A browser-rendered crawl makes the raw-vs-rendered `render` service self-identical → skip it (#673).
    // Sourced from the container's actual render decision (see ContainerPrefetchInput.crawlRendered) —
    // config.cloud.rendering is unset on this path, so reading it here would leave render charged+discarded.
    crawlRendered: input.crawlRendered,
    // Per-page skip for the pages an "auto" crawl already rendered (charge-free, rule-discarded otherwise).
    renderedPageUrls,
    // No `confirm` — the dashboard spendAck already consented; the cap bounds spend.
  });
}

/**
 * Editor's-summary (8cr, credit-only since #684) for a container audit, run AFTER
 * the report is built. Uses the SHARED buildEditorSummaryRequest (no replica — same
 * request as the CLI). Server charges credits (out of credits → 402 → null).
 * Returns the report-ready summary + credits, or null (off / empty / over budget /
 * any error) — never throws, never fails the audit.
 */
export async function runContainerEditorSummary(input: {
  client: CloudServicesClient;
  config: Config;
  auditId: string;
  report: AuditReport;
  remainingBudget: number;
}): Promise<{ editorSummary: EditorSummary; credits: number } | null> {
  const { client, config, auditId, report } = input;
  if (!config.cloud.enabled || !config.cloud.editor_summary) return null;
  if (report.totalPages === 0) return null;
  const credits = computeCost("editor_summary", 1);
  if (input.remainingBudget < credits) return null;
  try {
    const res = await client.editorSummary(buildEditorSummaryRequest(report, { auditId }));
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
  } catch {
    return null;
  }
}

/**
 * Domain stats (5cr, credit-only since #684) for a container audit (#111). Mirrors
 * the CLI's runCloudDomainStats — ONE DataForSEO whois/overview lookup. Server
 * charges credits (out of credits → 402 → null) and serves the 30-day cache (a hit
 * is free → 0 credits). A domain with no SEO footprint gets
 * 404 → null. Returns the report-ready stats + credits, or null (off / over budget
 * / any error) — never throws, never fails the audit.
 */
export async function runContainerDomainStats(input: {
  client: CloudServicesClient;
  config: Config;
  auditId: string;
  siteUrl: string;
  remainingBudget: number;
}): Promise<{ domainStats: DomainStats; credits: number } | null> {
  const { client, config, auditId, siteUrl } = input;
  if (!config.cloud.enabled || !config.cloud.domain_stats) return null;
  const cost = computeCost("domain_stats", 1);
  if (input.remainingBudget < cost) return null;
  try {
    const res = await client.domainStats({ auditId, url: siteUrl });
    return {
      domainStats: { domain: res.domain, metrics: res.metrics, capturedAt: res.capturedAt },
      // A 30-day cache hit is served free — don't bill it against the budget.
      credits: res.cached ? 0 : cost,
    };
  } catch {
    return null;
  }
}
