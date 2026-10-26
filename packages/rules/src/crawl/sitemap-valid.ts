// crawl/sitemap-valid - Sitemap validation

import type { CheckItem } from "@squirrelscan/core-contracts";
import {
  SITEMAP_NOT_CHECKED_ERROR,
  SITEMAP_OFF_SITE_SKIPPED_ERROR,
} from "@squirrelscan/core-contracts/storage";
import { w3cDatePeriod } from "@squirrelscan/utils/date-period";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { sampleUrlItems } from "../shared/sample-items";

const MAX_URLS_PER_SITEMAP = 50000;
// The protocol limit for an index file counts CHILD SITEMAPS, not URLs.
const MAX_CHILDREN_PER_INDEX = 50000;

/**
 * The W3C Datetime forms the sitemap protocol allows for `<lastmod>`: a year, a
 * month, a day, or a datetime with a `T` and a zone (`Z` or `+hh:mm`).
 */
const W3C_DATETIME = /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/;
/** A W3C datetime with the zone left off, which the protocol does not allow. */
const W3C_DATETIME_NO_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * How a `<lastmod>` falls short of the protocol (#781), or null when it does
 * not. A real date in the right shape is fine; a datetime with no zone is
 * named as that, since it reads as a date, just not one in a known zone;
 * anything else (`2024/09/10`, `2024-9`, `2024-09-31`, an RFC 1123 date) is not
 * W3C Datetime, and a search engine may ignore it.
 */
function lastmodProblem(value: string): "no-zone" | "not-w3c" | null {
  const text = value.trim();
  const readable = w3cDatePeriod(text) !== null;
  if (readable && W3C_DATETIME.test(text)) return null;
  if (readable && W3C_DATETIME_NO_ZONE.test(text)) return "no-zone";
  return "not-w3c";
}

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

    // Check for sitemaps from robots.txt that failed to fetch. A sitemap the
    // walk never REQUESTED is not a fetch failure — it is a gap in what was
    // checked, and reporting it as "failed to fetch" would invent a defect out
    // of work the audit skipped (squirrelscan/repo#1733).
    const failedFromRobots =
      sitemaps?.failed?.filter(
        (f) =>
          f.source === "robots.txt" &&
          f.error !== SITEMAP_NOT_CHECKED_ERROR &&
          f.error !== SITEMAP_OFF_SITE_SKIPPED_ERROR,
      ) ?? [];

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

      // "No sitemap to validate" reads as a finished check that found nothing.
      // When the walk stopped early it is neither: candidates were left
      // unvisited, so say the check did not complete (squirrelscan/repo#1733).
      if (sitemaps?.truncated) {
        checks.push({
          name: "sitemap-valid",
          status: "info",
          message: "Sitemap discovery did not complete, so no sitemap was validated",
          value: "Not all candidate locations were reached",
        });
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

      // Size limits. The crawler stores the AGGREGATED child URL total as
      // urlCount on a top-level index (coverage math needs it), so an index
      // must never be held to the per-file URL limit — a healthy sharded site
      // with >50k total URLs would fail on its index file (#1651). Indexes
      // have their own protocol limit: 50,000 child sitemaps.
      if (sitemap.type === "index") {
        if (sitemap.childSitemaps.length > MAX_CHILDREN_PER_INDEX) {
          oversizedSitemaps.push(`${sitemap.url} (${sitemap.childSitemaps.length} child sitemaps)`);
        }
      } else if (sitemap.urlCount > MAX_URLS_PER_SITEMAP) {
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
        message: `${oversizedSitemaps.length} sitemap(s) exceed the 50,000-entry protocol limit`,
        items: oversizedSitemaps.map((s) => ({ id: s })),
      });
    } else {
      checks.push({
        name: "sitemap-size",
        status: "pass",
        message: "All sitemaps within URL limits",
      });
    }

    // `<lastmod>` values outside W3C Datetime (#781). Count plus sample, as a
    // generator that writes one bad format writes it on every URL. No pass
    // check: one would add a passed check to every audit's score for this rule.
    const notW3c: CheckItem[] = [];
    const noZone: CheckItem[] = [];
    for (const sitemap of sitemaps.discovered) {
      for (const entry of sitemap.urls) {
        if (entry.lastmod === undefined) continue;
        const problem = lastmodProblem(entry.lastmod);
        if (!problem) continue;
        const item = { id: entry.loc, label: `lastmod "${entry.lastmod}"` };
        (problem === "no-zone" ? noZone : notW3c).push(item);
      }
    }
    if (notW3c.length > 0) {
      const { items, truncation } = sampleUrlItems(notW3c);
      checks.push({
        name: "sitemap-lastmod-format",
        status: "warn",
        message: `${notW3c.length} sitemap lastmod value(s) are not in W3C Datetime format`,
        items,
        details: { ...truncation, total: notW3c.length },
      });
    }
    if (noZone.length > 0) {
      const { items, truncation } = sampleUrlItems(noZone);
      checks.push({
        name: "sitemap-lastmod-zone",
        status: "warn",
        message: `${noZone.length} sitemap lastmod datetime(s) have no time zone`,
        items,
        details: { ...truncation, total: noZone.length },
      });
    }

    // Check for orphan pages (in sitemap but not crawled). Count plus sample,
    // with the exact count from before the engine's array cap (repo#2320).
    if (sitemaps.orphanPages.length > 0) {
      const total = Math.max(sitemaps.orphanPagesTotal ?? 0, sitemaps.orphanPages.length);
      const { items, truncation } = sampleUrlItems(
        sitemaps.orphanPages.map((url) => ({ id: url })),
        total
      );
      checks.push({
        name: "sitemap-orphans",
        status: "info",
        message: `${total} URL(s) in sitemap not found during crawl`,
        items,
        details: { ...truncation, total },
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
