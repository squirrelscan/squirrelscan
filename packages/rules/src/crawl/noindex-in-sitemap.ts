// crawl/noindex-in-sitemap - Noindexed pages shouldn't be in sitemap

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { SitemapDiscovery, SiteQuery } from "@squirrelscan/core-contracts";

function collectSitemapUrls(sitemaps: SitemapDiscovery): Set<string> {
  const sitemapUrls = new Set<string>();
  for (const sitemap of sitemaps.discovered) {
    for (const url of sitemap.urls) {
      sitemapUrls.add(url.loc);
    }
  }
  return sitemapUrls;
}

// Shared output builder — identical CheckResult given the same collected list.
function buildCheck(noindexInSitemap: string[]): CheckResult {
  if (noindexInSitemap.length > 0) {
    return {
      name: "noindex-in-sitemap",
      status: "warn",
      message: `${noindexInSitemap.length} noindexed page(s) found in sitemap`,
      items: noindexInSitemap.map((url) => ({ id: url })),
    };
  }
  return {
    name: "noindex-in-sitemap",
    status: "pass",
    message: "No noindexed pages in sitemap",
  };
}

// Streaming path (#1022): meta-only noindex is the pre-extracted `metaNoindex`
// scalar; sitemap membership stays a run-time cross-ref against ctx.site.sitemaps.
async function runViaSiteQuery(
  siteQuery: SiteQuery,
  sitemaps: SitemapDiscovery
): Promise<RuleResult> {
  const sitemapUrls = collectSitemapUrls(sitemaps);
  const noindexInSitemap: string[] = [];
  // row.normalizedUrl is the same value the legacy path reads as page.url
  // (site.pages[].url === PageRecord.normalizedUrl), so sitemap membership matches.
  for await (const row of siteQuery.pagesMatching(() => true)) {
    if (row.metaNoindex && sitemapUrls.has(row.normalizedUrl)) {
      noindexInSitemap.push(row.normalizedUrl);
    }
  }
  return { checks: [buildCheck(noindexInSitemap)] };
}

export const noindexInSitemapRule: Rule = {
  meta: {
    id: "crawl/noindex-in-sitemap",
    name: "Noindex in Sitemap",
    description: "Checks for noindexed pages listed in sitemap",
    solution:
      "Pages with noindex meta tags should not be in your sitemap. Sitemaps tell search engines which pages to index, while noindex tells them not to. Having both sends mixed signals. Remove noindexed pages from your sitemap, or remove the noindex directive if you want them indexed. Use a sitemap generator that respects robots directives.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const sitemaps = ctx.site?.sitemaps;

    if (ctx.siteQuery) {
      if (!sitemaps || sitemaps.discovered.length === 0) {
        return {
          checks: [
            {
              name: "noindex-in-sitemap",
              status: "skipped",
              message: "Sitemap or page data not available",
            },
          ],
        };
      }
      return runViaSiteQuery(ctx.siteQuery, sitemaps);
    }

    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!sitemaps || sitemaps.discovered.length === 0 || !pages) {
      checks.push({
        name: "noindex-in-sitemap",
        status: "skipped",
        message: "Sitemap or page data not available",
      });
      return { checks };
    }

    // Get all URLs from sitemaps
    const sitemapUrls = collectSitemapUrls(sitemaps);

    // Find noindexed pages that are in sitemap
    const noindexInSitemap: string[] = [];

    for (const page of pages) {
      const robotsMeta = page.parsed.meta.robots;
      const hasNoindex = robotsMeta
        ?.toLowerCase()
        .split(",")
        .map((d) => d.trim())
        .includes("noindex");

      if (hasNoindex && sitemapUrls.has(page.url)) {
        noindexInSitemap.push(page.url);
      }
    }

    return { checks: [buildCheck(noindexInSitemap)] };
  },
};
