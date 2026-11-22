// crawl/sitemap-domain - Cross-domain URL detection in sitemaps

import { getHostname } from "@squirrelscan/utils";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { URL_ITEM_SAMPLE, sampleUrlItems } from "../shared/sample-items";

function normalizeSitemapUrl(url: string): string {
  return url.trim();
}

export const sitemapDomainRule: Rule = {
  meta: {
    id: "crawl/sitemap-domain",
    name: "Sitemap Domain",
    description: "Checks that all sitemap URLs belong to the expected domain",
    solution:
      "All URLs in your sitemap should point to pages on your own domain. Cross-domain URLs in sitemaps are a configuration error - search engines will ignore URLs that don't match the sitemap's domain. Remove external URLs from your sitemap or fix the domain in URLs if they're incorrectly formatted.",
    category: "crawl",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;

    if (!sitemaps || sitemaps.discovered.length === 0) {
      checks.push({
        name: "sitemap-domain",
        status: "skipped",
        message: "No sitemap to validate",
        skipReason: "No sitemap found",
      });
      return { checks };
    }

    const expectedHost = getHostname(ctx.site?.baseUrl ?? "").toLowerCase();
    if (!expectedHost) {
      checks.push({
        name: "sitemap-domain",
        status: "skipped",
        message: "Could not determine expected domain",
        skipReason: "Invalid base URL",
      });
      return { checks };
    }

    // Sitemaps declared in robots.txt may live on any host (sitemaps.org
    // allows a cross-host sitemap when robots.txt declares it), and so may
    // the children of a declared index. Their URL sets are not flagged.
    const declared = new Set<string>(
      [
        ...(sitemaps.sources?.robotsTxt ?? []),
        ...(ctx.site?.robotsTxt?.sitemaps ?? []),
      ].map(normalizeSitemapUrl)
    );
    const byUrl = new Map(
      sitemaps.discovered.map((s) => [normalizeSitemapUrl(s.url), s])
    );
    const queue = [...declared];
    while (queue.length > 0) {
      const entry = byUrl.get(queue.pop() as string);
      for (const child of entry?.childSitemaps ?? []) {
        const key = normalizeSitemapUrl(child);
        if (!declared.has(key)) {
          declared.add(key);
          queue.push(key);
        }
      }
    }

    const crossDomainUrls: { url: string; host: string }[] = [];
    let robotsDeclaredSkipped = 0;

    for (const sitemap of sitemaps.discovered) {
      if (declared.has(normalizeSitemapUrl(sitemap.url))) {
        const sitemapHost = getHostname(sitemap.url).toLowerCase();
        if (sitemapHost && sitemapHost !== expectedHost) {
          robotsDeclaredSkipped += sitemap.urls.length;
        }
        continue;
      }
      for (const sitemapUrl of sitemap.urls) {
        const urlHost = getHostname(sitemapUrl.loc).toLowerCase();
        if (!urlHost) continue;

        // Check if domain matches (including www variant)
        const isMatch =
          urlHost === expectedHost ||
          urlHost === `www.${expectedHost}` ||
          `www.${urlHost}` === expectedHost;

        if (!isMatch) {
          crossDomainUrls.push({
            url: sitemapUrl.loc,
            host: urlHost,
          });
        }
      }
    }

    if (crossDomainUrls.length > 0) {
      const uniqueHosts = [...new Set(crossDomainUrls.map((u) => u.host))];
      // Count plus sample: a sitemap of a quarter of a million off-domain URLs
      // made this one check most of an 80 MB report (repo#2320). The message
      // and `details.total` keep the exact count.
      const { items, truncation } = sampleUrlItems(
        crossDomainUrls.slice(0, URL_ITEM_SAMPLE).map((u) => ({
          id: u.url,
          meta: { host: u.host },
        })),
        crossDomainUrls.length,
        new Set(crossDomainUrls.map((u) => u.url)).size
      );
      checks.push({
        name: "sitemap-domain",
        status: "fail",
        message: `${crossDomainUrls.length} URL(s) point to different domain(s) in sitemap(s) not declared in robots.txt`,
        items,
        details: {
          ...truncation,
          total: crossDomainUrls.length,
          robotsDeclared: false,
          expectedHost,
          foundHosts: uniqueHosts.slice(0, URL_ITEM_SAMPLE),
          ...(uniqueHosts.length > URL_ITEM_SAMPLE
            ? { hostCount: uniqueHosts.length }
            : {}),
        },
      });
    } else {
      checks.push({
        name: "sitemap-domain",
        status: "pass",
        message:
          robotsDeclaredSkipped > 0
            ? `All sitemap URLs match site domain (${robotsDeclaredSkipped} URL(s) in cross-host sitemap(s) declared in robots.txt were not flagged)`
            : "All sitemap URLs match site domain",
        details: {
          host: expectedHost,
          ...(robotsDeclaredSkipped > 0
            ? { robotsDeclared: true, robotsDeclaredSkipped }
            : {}),
        },
      });
    }

    return { checks };
  },
};
