// crawl/sitemap-lastmod-churn - Sitemap lastmod values collapsed onto one build date

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { w3cDatePeriod } from "@squirrelscan/utils/date-period";

const MIN_URLS_WITH_LASTMOD = 20;
const MAX_DISTINCT_DAYS = 2;

/**
 * The day a lastmod names, as written (#772): `2024-09-10T23:30:00-05:00` is
 * the 10th, though it is the 11th in UTC. "coarse" for a bare year or
 * year-month (#758), which names no day: reading `2024` as 2024-01-01 would
 * report a date the sitemap never wrote. Null when it is not a date.
 */
function toDay(lastmod: string): string | "coarse" | null {
  const period = w3cDatePeriod(lastmod);
  if (!period) return null;
  return period.day ?? "coarse";
}

export const sitemapLastmodChurnRule: Rule = {
  meta: {
    id: "crawl/sitemap-lastmod-churn",
    name: "Sitemap Lastmod Churn",
    description: "Checks that sitemap lastmod values aren't all stamped with the same build date",
    solution:
      "If every URL in your sitemap carries the same (or nearly the same) lastmod date, the field is being stamped at build/deploy time rather than reflecting real content changes. This makes lastmod useless as a freshness signal - search engines may learn to ignore it entirely. Update lastmod only when a page's content actually changes, driven by your CMS or version control history, not by the deploy pipeline. Google News sitemaps are excluded from this check: they hold only about 48 hours of articles by design, so their lastmod values are supposed to cluster.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const sitemaps = ctx.site?.sitemaps;

    if (!sitemaps || sitemaps.discovered.length === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-churn",
            status: "skipped",
            message: "No sitemap to validate",
            skipReason: "No sitemap found",
          },
        ],
      };
    }

    const days = new Map<string, number>();
    const sourceSitemaps = new Set<string>();
    let urlsWithLastmod = 0;
    // Counted only to explain a skip: "your lastmod values all came from a news sitemap" is a very
    // different message from "your sitemap has no lastmod at all", and the operator needs to tell them
    // apart to know whether anything is wrong.
    let newsUrlsWithLastmod = 0;
    // A year or month names no day, so it cannot show day-level stamping.
    let coarseLastmods = 0;

    for (const sitemap of sitemaps.discovered) {
      for (const sitemapUrl of sitemap.urls) {
        if (!sitemapUrl.lastmod) continue;
        const day = toDay(sitemapUrl.lastmod);
        if (!day) continue;
        // A Google News sitemap carries roughly the last 48 hours of articles by specification, so its
        // lastmod values ALWAYS collapse onto one or two days. Pooling them in accused every publisher
        // with a news sitemap of build-stamping their lastmod - observed on a live site whose regular
        // sitemap was unreachable, leaving the news sitemap as the entire sample.
        if (sitemap.isNewsSitemap) {
          newsUrlsWithLastmod++;
          continue;
        }
        if (day === "coarse") {
          coarseLastmods++;
          continue;
        }
        urlsWithLastmod++;
        sourceSitemaps.add(sitemap.url);
        days.set(day, (days.get(day) ?? 0) + 1);
      }
    }

    const checks: CheckResult[] = [];

    if (urlsWithLastmod < MIN_URLS_WITH_LASTMOD) {
      // Distinguish "too small to judge" from "everything we saw was a news sitemap". The second is not
      // a finding about the site at all, and reporting it as one sends the operator looking for a bug
      // in a sitemap that is behaving exactly as specified.
      const newsOnly = urlsWithLastmod === 0 && newsUrlsWithLastmod > 0 && coarseLastmods === 0;
      // Too coarse, not too small: counting them would have been enough.
      const coarseOnly = coarseLastmods > 0 && urlsWithLastmod + coarseLastmods >= MIN_URLS_WITH_LASTMOD;
      checks.push({
        name: "sitemap-lastmod-churn",
        status: "skipped",
        message: newsOnly
          ? `Only news-sitemap URLs carry a lastmod (${newsUrlsWithLastmod}); news sitemaps hold ~48 hours of articles by design, so their lastmod values are excluded from this check`
          : coarseOnly
            ? `${coarseLastmods} sitemap lastmod value(s) name only a year or month, which says nothing about the day a page changed; ${urlsWithLastmod} name a day, too few to judge lastmod churn`
            : // Year and month values carry a lastmod too: counting only the
              // day-level ones read "Only 0" for a sitemap of coarse values.
              `Only ${urlsWithLastmod + coarseLastmods} sitemap URL(s) carry a lastmod; sitemap is too small to judge lastmod churn`,
        skipReason: newsOnly
          ? "Only news-sitemap lastmod values"
          : coarseOnly
            ? "Lastmod values name only a year or month"
            : "Too few URLs with lastmod",
        details: { urlsWithLastmod, newsUrlsWithLastmod, coarseLastmods },
      });
      return { checks };
    }

    const distinctDays = days.size;
    // Naming the sitemaps makes the finding actionable: on a site with several, "which one stamps at
    // build time" is the first question, and a bare count cannot answer it.
    const sources = [...sourceSitemaps].sort();

    if (distinctDays <= MAX_DISTINCT_DAYS) {
      const offendingDates = [...days.keys()].sort();
      checks.push({
        name: "sitemap-lastmod-churn",
        status: "warn",
        message: `${urlsWithLastmod} sitemap URL(s) with lastmod collapse onto ${distinctDays} distinct day(s): ${offendingDates.join(", ")} (from ${sources.join(", ")})`,
        items: offendingDates.map((date) => ({ id: date, meta: { count: days.get(date) } })),
        details: {
          distinctDays,
          urlsWithLastmod,
          dates: offendingDates,
          sitemaps: sources,
          newsUrlsExcluded: newsUrlsWithLastmod,
          coarseLastmodsExcluded: coarseLastmods,
        },
      });
      return { checks };
    }

    checks.push({
      name: "sitemap-lastmod-churn",
      status: "pass",
      message: `${urlsWithLastmod} sitemap URL(s) with lastmod spread across ${distinctDays} distinct days`,
      details: {
        distinctDays,
        urlsWithLastmod,
        sitemaps: sources,
        newsUrlsExcluded: newsUrlsWithLastmod,
        coarseLastmodsExcluded: coarseLastmods,
      },
    });

    return { checks };
  },
};
