// crawl/sitemap-exists - XML sitemap existence check

import { SITEMAP_OFF_SITE_SKIPPED_ERROR } from "@squirrelscan/core-contracts/storage";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { refusedCheck, refusedFor } from "../refused";

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

    // The site refused the sitemap requests (a bot wall, auth, throttling), so
    // it never said whether a sitemap exists. "No XML sitemap found" would be a
    // false statement about the site.
    const refused = refusedFor(ctx.site, "sitemap");
    if (sitemaps.discovered.length === 0 && refused.length > 0) {
      checks.push(refusedCheck("sitemap-exists", "XML sitemap", refused));
      return { checks };
    }

    // Discovery stopped before visiting every candidate location, so nothing
    // was established about whether a sitemap exists. Reporting a definite
    // "No XML sitemap found" here would turn a check we never finished into a
    // weight-10 defect on a site that may well have one (squirrelscan/repo#1733).
    if (sitemaps.discovered.length === 0 && sitemaps.truncated) {
      checks.push({
        name: "sitemap-exists",
        status: "info",
        message: "Sitemap discovery did not complete, so no sitemap check was made",
        value: "Not all candidate locations were reached",
      });
      return { checks };
    }

    // An offline audit never requests a sitemap on another site, whether
    // robots.txt names it or a sitemap on the site redirects there (#819), so with nothing found on the site itself it did not look:
    // "No XML sitemap found" would be a false statement about a site that
    // points at a sitemap it keeps elsewhere.
    const offSite = (sitemaps.failed ?? []).filter((f) => f.error === SITEMAP_OFF_SITE_SKIPPED_ERROR);
    if (sitemaps.discovered.length === 0 && offSite.length > 0) {
      checks.push({
        name: "sitemap-exists",
        status: "info",
        message: `${offSite.length} sitemap(s) on another site were not requested`,
        value: "An offline audit only requests the audited site",
        items: offSite.map((f) => ({ id: f.url, label: f.error })),
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
