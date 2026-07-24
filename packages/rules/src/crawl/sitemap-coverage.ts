// crawl/sitemap-coverage - Check for indexable pages not in sitemap

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { normalizeUrl } from "@squirrelscan/utils";

export const sitemapCoverageRule: Rule = {
  meta: {
    id: "crawl/sitemap-coverage",
    name: "Sitemap Coverage",
    description: "Checks for indexable pages that are not in the sitemap",
    solution:
      "Your sitemap should include all pages you want search engines to index. Pages that are crawlable and indexable (no noindex, not blocked by robots.txt) should generally be in your sitemap. Missing pages may not be discovered or indexed efficiently. Use a sitemap generator that automatically includes all indexable pages, or manually add important pages.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;
    const pages = ctx.site?.pages;

    if (!sitemaps || sitemaps.discovered.length === 0) {
      checks.push({
        name: "sitemap-coverage",
        status: "skipped",
        message: "No sitemap to compare",
        skipReason: "No sitemap found",
      });
      return { checks };
    }

    if (!pages || pages.length === 0) {
      checks.push({
        name: "sitemap-coverage",
        status: "skipped",
        message: "No pages to compare",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const precomputedMissing = sitemaps.missingPages ?? [];
    const precomputedOrphans = sitemaps.orphanPages ?? [];

    // Get all URLs from sitemaps (normalized) for fallback calculation
    const sitemapUrls = new Set<string>();
    for (const sitemap of sitemaps.discovered) {
      for (const url of sitemap.urls) {
        try {
          sitemapUrls.add(normalizeUrl(url.loc));
        } catch {
          // Skip malformed URLs
        }
      }
    }

    // Fallback logic explanation:
    // - precomputedMissing is populated by the sitemap processor during crawl
    // - If empty array: either no issues found OR computation not yet run
    // - Fallback computation runs when precomputedMissing is empty to handle:
    //   1. Legacy crawls without precomputed data
    //   2. Edge cases where processor didn't run
    // - This duplicates work when precomputed is truly empty (no issues) but ensures correctness
    // - Cost is acceptable since sitemap comparison is fast relative to crawl time
    const missingFromSitemap: string[] =
      precomputedMissing.length > 0 ? precomputedMissing.slice() : [];

    if (missingFromSitemap.length === 0) {
      for (const page of pages) {
        // Skip non-200 pages
        if (page.statusCode !== 200) continue;

        // Check for noindex
        const robotsMeta = page.parsed.meta.robots;
        const hasNoindex = robotsMeta
          ?.toLowerCase()
          .split(",")
          .map((d) => d.trim())
          .includes("noindex");

        if (hasNoindex) continue;

        // Check if page (or final URL) is in sitemap
        const candidates = [page.url, page.finalUrl].filter(
          (candidate): candidate is string => !!candidate,
        );
        let inSitemap = false;
        for (const candidate of candidates) {
          try {
            const normalizedPageUrl = normalizeUrl(candidate);
            if (sitemapUrls.has(normalizedPageUrl)) {
              inSitemap = true;
              break;
            }
          } catch {
            // Skip malformed URLs
          }
        }
        if (!inSitemap) {
          missingFromSitemap.push(page.url);
        }
      }
    }

    if (missingFromSitemap.length > 0) {
      const percentage = Math.round((missingFromSitemap.length / pages.length) * 100);

      checks.push({
        name: "sitemap-coverage",
        status: "warn",
        message: `${missingFromSitemap.length} indexable page(s) not in sitemap (${percentage}%)`,
        items: missingFromSitemap.map((url) => ({ id: url })),
        details: { percentage, total: missingFromSitemap.length },
      });
    } else {
      checks.push({
        name: "sitemap-coverage",
        status: "pass",
        message: "All indexable pages are in sitemap",
      });
    }

    if (precomputedOrphans.length > 0) {
      // #697: a crawl truncated by the coverage profile's page cap (e.g. the
      // "quick" profile stopping at 25 pages against a 54-URL sitemap) isn't
      // a coverage problem — it's a crawl-budget artifact that self-heals on
      // a deeper run. Only warn when the cap was NOT hit, i.e. the crawler
      // had budget left and still couldn't reach these sitemap URLs.
      // Also require the sitemap to actually exceed the cap: if the whole
      // site fits within maxPages, hitting the cap was coincidental, not the
      // reason these URLs are missing (codex review).
      const limits = ctx.site?.crawlLimits;
      const wasCapped =
        !!limits && limits.pagesCrawled >= limits.maxPages && sitemaps.totalUrls > limits.maxPages;

      checks.push({
        name: "sitemap-orphans",
        status: wasCapped ? "info" : "warn",
        message: wasCapped
          ? `${precomputedOrphans.length} sitemap URL(s) not audited this run (crawl capped at ${limits.maxPages} pages)`
          : `${precomputedOrphans.length} sitemap URL(s) were not crawled`,
        items: precomputedOrphans.map((url) => ({ id: url })),
        details: wasCapped
          ? { total: precomputedOrphans.length, cappedAt: limits.maxPages }
          : { total: precomputedOrphans.length },
      });
    }

    return { checks };
  },
};
