// crawl/sitemap-valid - Sitemap validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const MAX_URLS_PER_SITEMAP = 50000;

export const sitemapValidRule: Rule = {
  meta: {
    id: "crawl/sitemap-valid",
    name: "Sitemap Valid",
    description: "Validates sitemap structure and URL limits",
    solution:
      "Sitemaps must follow the sitemap protocol: use UTF-8 encoding, proper XML structure, and valid URLs. Each sitemap file can contain max 50,000 URLs and be max 50MB uncompressed. For larger sites, use a sitemap index file. All URLs should return 200 status codes. Use lastmod dates to indicate content freshness. Compress with gzip for faster loading.",
    category: "crawl",
    scope: "site",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;

    // Check for sitemaps from robots.txt that failed to fetch
    const failedFromRobots =
      sitemaps?.failed?.filter((f) => f.source === "robots.txt") ?? [];

    if (failedFromRobots.length > 0) {
      checks.push({
        name: "sitemap-fetch-failed",
        status: "fail",
        message: `${failedFromRobots.length} sitemap(s) from robots.txt failed to fetch`,
        items: failedFromRobots.map((f) => ({
          id: f.url,
          label: f.error,
        })),
      });
    }

    if (!sitemaps || sitemaps.discovered.length === 0) {
      // If we have failed robots.txt sitemaps, don't skip - return checks with failures
      if (failedFromRobots.length > 0) {
        return { checks };
      }

      checks.push({
        name: "sitemap-valid",
        status: "skipped",
        message: "No sitemap to validate",
      });
      return { checks };
    }

    let totalErrors = 0;
    const oversizedSitemaps: string[] = [];
    const sitemapsWithErrors: Array<{ url: string; errors: string[] }> = [];

    for (const sitemap of sitemaps.discovered) {
      // Check for XML errors
      if (sitemap.errors.length > 0) {
        totalErrors += sitemap.errors.length;
        sitemapsWithErrors.push({ url: sitemap.url, errors: sitemap.errors });
      }

      // Check URL count limit
      if (sitemap.urlCount > MAX_URLS_PER_SITEMAP) {
        oversizedSitemaps.push(`${sitemap.url} (${sitemap.urlCount} URLs)`);
      }
    }

    // Report XML errors with specific sitemap URLs
    if (totalErrors > 0) {
      checks.push({
        name: "sitemap-syntax",
        status: "fail",
        message: `${totalErrors} error(s) in ${sitemapsWithErrors.length} sitemap(s)`,
        items: sitemapsWithErrors.map((s) => ({
          id: s.url,
          label: s.errors[0],
          meta: { errorCount: s.errors.length, errors: s.errors },
        })),
      });
    } else {
      checks.push({
        name: "sitemap-syntax",
        status: "pass",
        message: "Sitemap XML syntax is valid",
      });
    }

    // Report oversized sitemaps
    if (oversizedSitemaps.length > 0) {
      checks.push({
        name: "sitemap-size",
        status: "warn",
        message: `${oversizedSitemaps.length} sitemap(s) exceed 50,000 URL limit`,
        items: oversizedSitemaps.map((s) => ({ id: s })),
      });
    } else {
      checks.push({
        name: "sitemap-size",
        status: "pass",
        message: "All sitemaps within URL limits",
      });
    }

    // Check for orphan pages (in sitemap but not crawled)
    if (sitemaps.orphanPages.length > 0) {
      checks.push({
        name: "sitemap-orphans",
        status: "info",
        message: `${sitemaps.orphanPages.length} URL(s) in sitemap not found during crawl`,
        items: sitemaps.orphanPages.map((url) => ({ id: url })),
      });
    }

    // Check for missing pages (crawled but not in sitemap)
    if (sitemaps.missingPages.length > 0) {
      checks.push({
        name: "sitemap-missing",
        status: "info",
        message: `${sitemaps.missingPages.length} crawled page(s) not in sitemap`,
        items: sitemaps.missingPages.map((url) => ({ id: url })),
      });
    }

    return { checks };
  },
};
