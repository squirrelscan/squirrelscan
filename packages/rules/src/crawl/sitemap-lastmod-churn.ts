// crawl/sitemap-lastmod-churn - Sitemap lastmod values collapsed onto one build date

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const MIN_URLS_WITH_LASTMOD = 20;
const MAX_DISTINCT_DAYS = 2;

function toDay(lastmod: string): string | null {
  const date = new Date(lastmod);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export const sitemapLastmodChurnRule: Rule = {
  meta: {
    id: "crawl/sitemap-lastmod-churn",
    name: "Sitemap Lastmod Churn",
    description: "Checks that sitemap lastmod values aren't all stamped with the same build date",
    solution:
      "If every URL in your sitemap carries the same (or nearly the same) lastmod date, the field is being stamped at build/deploy time rather than reflecting real content changes. This makes lastmod useless as a freshness signal - search engines may learn to ignore it entirely. Update lastmod only when a page's content actually changes, driven by your CMS or version control history, not by the deploy pipeline.",
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
    let urlsWithLastmod = 0;

    for (const sitemap of sitemaps.discovered) {
      for (const sitemapUrl of sitemap.urls) {
        if (!sitemapUrl.lastmod) continue;
        const day = toDay(sitemapUrl.lastmod);
        if (!day) continue;
        urlsWithLastmod++;
        days.set(day, (days.get(day) ?? 0) + 1);
      }
    }

    const checks: CheckResult[] = [];

    if (urlsWithLastmod < MIN_URLS_WITH_LASTMOD) {
      checks.push({
        name: "sitemap-lastmod-churn",
        status: "skipped",
        message: `Only ${urlsWithLastmod} sitemap URL(s) carry a lastmod; sitemap is too small to judge lastmod churn`,
        skipReason: "Too few URLs with lastmod",
      });
      return { checks };
    }

    const distinctDays = days.size;

    if (distinctDays <= MAX_DISTINCT_DAYS) {
      const offendingDates = [...days.keys()].sort();
      checks.push({
        name: "sitemap-lastmod-churn",
        status: "warn",
        message: `${urlsWithLastmod} sitemap URL(s) with lastmod collapse onto ${distinctDays} distinct day(s): ${offendingDates.join(", ")}`,
        items: offendingDates.map((date) => ({ id: date, meta: { count: days.get(date) } })),
        details: { distinctDays, urlsWithLastmod, dates: offendingDates },
      });
      return { checks };
    }

    checks.push({
      name: "sitemap-lastmod-churn",
      status: "pass",
      message: `${urlsWithLastmod} sitemap URL(s) with lastmod spread across ${distinctDays} distinct days`,
      details: { distinctDays, urlsWithLastmod },
    });

    return { checks };
  },
};
