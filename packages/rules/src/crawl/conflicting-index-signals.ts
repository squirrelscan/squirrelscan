// crawl/conflicting-index-signals - one finding per page that says "index me" and "do not index me" at once (#1771)

import type { Rule, RuleContext, RuleResult, CheckResult, CheckItem } from "../types";
import type { RobotsTxtData, SiteQuery, SitemapDiscovery } from "@squirrelscan/core-contracts";

import { isPageIndexable, isRobotsTxtDisallowed } from "@squirrelscan/utils";

const CHECK_NAME = "conflicting-index-signals";
const MAX_ITEMS = 50;
const MIN_PAGES_FOR_SITE_WIDE = 3;
// Share of crawled pages already kept out of the index (noindex or robots.txt) above which the whole site is
// treated as deliberately closed (staging, pre-launch): reported once, never per page.
const SITE_WIDE_SHARE = 0.8;

/** The existing rules that report one symptom of this problem alone; the finding names them so a consumer can group. */
export const RELATED_RULE_IDS = [
  "crawl/noindex-in-sitemap",
  "core/canonical",
  "social/og-url-match",
  "schema/coverage-outlier",
  "crawl/robots-meta-conflict",
] as const;

/** What one page needs for the verdict: every field is already stored by the crawl. */
export interface IndexSignalPage {
  url: string;
  status: number;
  /** The raw canonical href the page declares (meta or header), or null. */
  canonical: string | null;
  /** `isPageIndexable(parsed, headers).reasons`: the meta and header noindex reasons only. */
  reasons: readonly string[];
}

export interface PageSignals {
  url: string;
  /** "do not index" signals found. */
  against: string[];
  /** "index me" signals found. */
  for: string[];
  canonicalTarget: string | null;
}

export type IndexSignalVerdict =
  | { kind: "none" }
  | { kind: "site-wide"; closedPages: number; totalPages: number }
  | { kind: "conflicts"; pages: PageSignals[] };

/** `href` resolved against the page and stripped of its fragment and trailing slash, or null when unusable. */
function comparableUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch {
    return null;
  }
}

/** The absolute URL a page's canonical points at when it differs from the page itself, else null. */
export function canonicalElsewhere(canonical: string | null, pageUrl: string): string | null {
  if (!canonical) return null;
  const target = comparableUrl(canonical, pageUrl);
  const self = comparableUrl(pageUrl, pageUrl);
  if (!target || !self || target === self) return null;
  return target;
}

export function sitemapUrlSet(sitemaps: SitemapDiscovery | undefined): Set<string> {
  const set = new Set<string>();
  for (const sitemap of sitemaps?.discovered ?? []) {
    for (const entry of sitemap.urls) set.add(entry.loc);
  }
  return set;
}

/**
 * The threshold, in one place. A page is reported only when it is listed in a sitemap (the one explicit
 * "index me" signal in the crawl) AND at least TWO "do not index" signals apply (noindex, a canonical to another
 * URL, a robots.txt disallow). Noindex plus sitemap alone is crawl/noindex-in-sitemap's finding, and a canonical
 * elsewhere alone is core/canonical's, so a single mismatch is never reported twice. Self-canonicals and
 * dofollow internal links are not counted: nearly every page has them, so they would turn every single mismatch
 * into a "conflict". hreflang is not counted either (it needs cross-page data the page rows do not carry).
 */
export function evaluateIndexSignals(
  pages: readonly IndexSignalPage[],
  sitemapUrls: ReadonlySet<string>,
  robotsTxt: RobotsTxtData | null | undefined,
): IndexSignalVerdict {
  const conflicts: PageSignals[] = [];
  let closed = 0;
  let total = 0;
  for (const page of pages) {
    if (page.status < 200 || page.status >= 300) continue;
    total++;
    const against: string[] = [];
    const meta = page.reasons.includes("meta:noindex");
    const header = page.reasons.includes("header:noindex");
    if (meta) against.push("noindex in the robots meta tag");
    if (header) against.push("noindex in the X-Robots-Tag header");
    const target = canonicalElsewhere(page.canonical, page.url);
    if (target) against.push(`canonical points to a different URL (${target})`);
    const disallowed = !!robotsTxt && isRobotsTxtDisallowed(page.url, robotsTxt);
    if (disallowed) against.push("blocked by robots.txt");
    if (meta || header || disallowed) closed++;
    if (against.length >= 2 && sitemapUrls.has(page.url)) {
      conflicts.push({
        url: page.url,
        against,
        for: ["listed in the sitemap"],
        canonicalTarget: target,
      });
    }
  }
  if (total >= MIN_PAGES_FOR_SITE_WIDE && closed / total >= SITE_WIDE_SHARE) {
    return { kind: "site-wide", closedPages: closed, totalPages: total };
  }
  if (conflicts.length === 0) return { kind: "none" };
  conflicts.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { kind: "conflicts", pages: conflicts };
}

function relatedFor(p: PageSignals): string[] {
  const out: string[] = [];
  if (p.against.some((s) => s.startsWith("noindex in the robots meta")))
    out.push("crawl/noindex-in-sitemap");
  if (p.canonicalTarget) out.push("core/canonical", "social/og-url-match");
  if (p.against.includes("blocked by robots.txt") && p.against.length > 1)
    out.push("crawl/robots-meta-conflict");
  return out;
}

function buildChecks(verdict: IndexSignalVerdict): CheckResult[] {
  if (verdict.kind === "site-wide") {
    return [
      {
        name: "site-wide-noindex",
        status: "info",
        message: `${verdict.closedPages} of ${verdict.totalPages} crawled pages are kept out of the index (noindex or robots.txt): this looks like a site-wide block (a staging site or a pre-launch site), so per-page conflicts are not reported. See crawl/all-noindex-pages`,
        value: verdict.closedPages,
        details: { closedPages: verdict.closedPages, totalPages: verdict.totalPages },
      },
    ];
  }
  if (verdict.kind === "none") {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: "No page sends contradictory indexing signals",
      },
    ];
  }
  const items: CheckItem[] = verdict.pages.slice(0, MAX_ITEMS).map((p) => ({
    id: p.url,
    label: `${[...p.for, ...p.against].join("; ")}`,
    meta: { signalsIndex: p.for, signalsNoIndex: p.against, relatedRules: relatedFor(p) },
  }));
  return [
    {
      name: CHECK_NAME,
      status: "warn",
      message: `${verdict.pages.length} page(s) say both "index me" and "do not index me". Decide whether each page should be indexed. To keep it out of search: remove it from the sitemap, keep noindex, and drop the canonical to another URL (or leave it). To put it in search: remove noindex and any robots.txt block, point the canonical at the page itself, and keep it in the sitemap`,
      value: verdict.pages.length,
      items,
      pages: verdict.pages.map((p) => p.url),
      details: {
        relatedRules: [...RELATED_RULE_IDS],
        decision: "should this page be indexed?",
        total: verdict.pages.length,
        itemsShown: items.length,
      },
    },
  ];
}

async function runViaSiteQuery(
  siteQuery: SiteQuery,
  sitemapUrls: ReadonlySet<string>,
  robotsTxt: RobotsTxtData | null | undefined,
): Promise<RuleResult> {
  const pages: IndexSignalPage[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    pages.push({
      url: row.normalizedUrl,
      status: row.status,
      canonical: row.canonical,
      reasons: row.indexableReasons,
    });
  }
  return { checks: buildChecks(evaluateIndexSignals(pages, sitemapUrls, robotsTxt)) };
}

export const conflictingIndexSignalsRule: Rule = {
  meta: {
    id: "crawl/conflicting-index-signals",
    name: "Conflicting Index Signals",
    description:
      "Finds pages that are listed in the sitemap but also carry two or more signals that keep them out of the index",
    solution:
      'These pages say "index me" (the sitemap) and "do not index me" (noindex, a canonical to another URL, a robots.txt block) at the same time, so the fixes the individual rules suggest pull in different directions. First decide whether each page should be in search. If not: remove it from the sitemap, keep noindex and drop any canonical to another URL. If yes: remove noindex and the robots.txt block, point the canonical at the page itself, keep it in the sitemap and add the structured data its siblings carry. A page with only one of these mismatches is left to crawl/noindex-in-sitemap or core/canonical.',
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 4,
    // Check names by outcome class (#1741).
    checks: [
      { name: "conflicting-index-signals", outcome: "problem" },
      { name: "site-wide-noindex", outcome: "problem" },
      { name: "conflicting-index-signals", outcome: "clean", clears: ["conflicting-index-signals", "site-wide-noindex"] },
      { name: "conflicting-index-signals", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const sitemaps = ctx.site?.sitemaps;
    const robotsTxt = ctx.site?.robotsTxt;
    const skip = (message: string): RuleResult => ({
      checks: [{ name: CHECK_NAME, status: "skipped", message }],
    });
    if (!sitemaps || sitemaps.discovered.length === 0) {
      return skip("No sitemap discovered, so no page can be listed in one");
    }
    const sitemapUrls = sitemapUrlSet(sitemaps);

    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery, sitemapUrls, robotsTxt);
    }
    const pages = ctx.site?.pages;
    if (!pages) return skip("Page data not available");
    const rows: IndexSignalPage[] = pages.map((page) => ({
      url: page.url,
      status: page.statusCode ?? 200,
      canonical: page.parsed.meta.canonical ?? null,
      reasons: isPageIndexable(page.parsed, page.headers).reasons,
    }));
    return { checks: buildChecks(evaluateIndexSignals(rows, sitemapUrls, robotsTxt)) };
  },
};
