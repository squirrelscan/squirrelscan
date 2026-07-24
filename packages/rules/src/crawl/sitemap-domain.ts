// crawl/sitemap-domain - Cross-domain URL detection in sitemaps

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getHostname } from "@squirrelscan/utils";

export const sitemapDomainRule: Rule = {
  meta: {
    id: "crawl/sitemap-domain",
    name: "Sitemap Domain",
    description: "Checks that all sitemap URLs belong to the expected domain",
    solution:
      "All URLs in your sitemap should point to pages on your own domain. Cross-domain URLs in sitemaps are a configuration error - search engines will ignore URLs that don't match the sitemap's domain. Remove external URLs from your sitemap or fix the domain in URLs if they're incorrectly formatted.",
    category: "crawl",
    scope: "site",
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

    const crossDomainUrls: { url: string; host: string }[] = [];

    for (const sitemap of sitemaps.discovered) {
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
      checks.push({
        name: "sitemap-domain",
        status: "fail",
        message: `${crossDomainUrls.length} URL(s) point to different domain(s)`,
        items: crossDomainUrls.map((u) => ({
          id: u.url,
          meta: { host: u.host },
        })),
        details: { expectedHost, foundHosts: uniqueHosts },
      });
    } else {
      checks.push({
        name: "sitemap-domain",
        status: "pass",
        message: "All sitemap URLs match site domain",
        details: { host: expectedHost },
      });
    }

    return { checks };
  },
};
