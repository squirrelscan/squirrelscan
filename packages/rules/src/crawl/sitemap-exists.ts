// crawl/sitemap-exists - XML sitemap existence check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const sitemapExistsRule: Rule = {
  meta: {
    id: "crawl/sitemap-exists",
    name: "Sitemap Exists",
    description: "Checks if XML sitemap exists and is referenced in robots.txt",
    solution:
      "XML sitemaps help search engines discover and index your pages. Create a sitemap.xml at your domain root listing all important pages. Reference it in robots.txt with 'Sitemap: https://yoursite.com/sitemap.xml'. Submit it to Google Search Console and Bing Webmaster Tools. Keep it under 50MB and 50,000 URLs per file; use a sitemap index for larger sites.",
    category: "crawl",
    scope: "site",
    severity: "error",
    weight: 10,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;
    const robotsTxt = ctx.site?.robotsTxt;

    if (!sitemaps) {
      checks.push({
        name: "sitemap-exists",
        status: "info",
        message: "Sitemap data not available",
      });
      return { checks };
    }

    // Check if any sitemaps were discovered
    if (sitemaps.discovered.length === 0) {
      checks.push({
        name: "sitemap-exists",
        status: "fail",
        message: "No XML sitemap found",
        value: "Checked common locations and robots.txt",
      });
      return { checks };
    }

    checks.push({
      name: "sitemap-exists",
      status: "pass",
      message: `${sitemaps.discovered.length} sitemap(s) found`,
      items: sitemaps.discovered.map((s) => ({
        id: s.url,
        meta: { urlCount: s.urlCount },
      })),
    });

    // Check if sitemap is referenced in robots.txt
    if (robotsTxt?.exists) {
      if (sitemaps.sources.robotsTxt.length > 0) {
        checks.push({
          name: "sitemap-in-robots",
          status: "pass",
          message: "Sitemap referenced in robots.txt",
          value: sitemaps.sources.robotsTxt[0],
        });
      } else {
        checks.push({
          name: "sitemap-in-robots",
          status: "info",
          message: "Sitemap not referenced in robots.txt",
          value: "Add Sitemap directive to robots.txt",
        });
      }
    }

    // Report total URLs
    checks.push({
      name: "sitemap-urls",
      status: "info",
      message: `Sitemap contains ${sitemaps.totalUrls} URL(s)`,
    });

    return { checks };
  },
};
