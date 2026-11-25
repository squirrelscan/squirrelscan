// crawl/sitemap-lastmod-drift - Sitemap lastmod vs the page's own dateModified

import type { SitemapData } from "@squirrelscan/core-contracts";

import { normalizeUrl } from "@squirrelscan/utils";
import { datePeriod, periodGapMs } from "@squirrelscan/utils/date-period";
import { z } from "zod";

import type { DateSource } from "../shared/page-date";
import type {
  ParsedPage,
  Rule,
  RuleContext,
  RuleResult,
  CheckResult,
} from "../types";

import { pagePrimaryDate } from "../shared/page-date";
import { sitePageViews } from "../shared/site-page-view";

const MS_PER_DAY = 86_400_000;

// Findings are capped so a site whose whole sitemap is build-stamped reports a
// readable sample rather than thousands of items; `details.total` keeps the
// real count.
const MAX_ITEMS = 50;

export const optionsSchema = z.object({
  ahead_days: z
    .number()
    .int()
    .min(0)
    .default(30)
    .describe(
      "Days a sitemap lastmod may run ahead of the page's own dateModified before warning"
    ),
  behind_days: z
    .number()
    .int()
    .min(0)
    .default(7)
    .describe(
      "Days a sitemap lastmod may lag the page's own dateModified before warning"
    ),
});

/** Sitemap `lastmod` by normalized URL; first entry wins on duplicate locs. */
function collectLastmods(discovered: SitemapData[]): Map<string, string> {
  const lastmods = new Map<string, string>();
  for (const sitemap of discovered) {
    for (const url of sitemap.urls) {
      if (!url.lastmod) continue;
      try {
        const key = normalizeUrl(url.loc);
        if (!lastmods.has(key)) lastmods.set(key, url.lastmod);
      } catch {
        // Skip malformed URLs
      }
    }
  }
  return lastmods;
}

interface Drift {
  url: string;
  lastmod: string;
  pageDate: string;
  source: DateSource;
  deltaDays: number;
}

function buildCheck(
  name: string,
  drifts: Drift[],
  message: string,
  comparedPages: number
): CheckResult {
  return {
    name,
    status: "warn",
    message,
    items: drifts.slice(0, MAX_ITEMS).map((drift) => ({
      id: drift.url,
      label: `lastmod ${drift.lastmod} vs dateModified ${drift.pageDate} (${drift.deltaDays} day(s))`,
      meta: {
        lastmod: drift.lastmod,
        pageDate: drift.pageDate,
        pageDateSource: drift.source,
        deltaDays: drift.deltaDays,
      },
    })),
    details: { total: drifts.length, comparedPages },
  };
}

export const sitemapLastmodDriftRule: Rule = {
  meta: {
    id: "crawl/sitemap-lastmod-drift",
    name: "Sitemap Lastmod Drift",
    description:
      "Checks that sitemap lastmod matches the page's own dateModified",
    solution:
      "A sitemap lastmod that disagrees with the page's own dateModified points at the sitemap generator, not the content. Lastmod OLDER than the page's dateModified tells crawlers not to bother with a page that has in fact changed - usually a stale cached sitemap, or a generator resolving `publishedAt ?? updatedAt` while the page renders `updatedAt ?? publishedAt` (a precedence inversion; both fields are present, so presence checks pass). Lastmod NEWER than the page's dateModified usually means lastmod is stamped at build/deploy time. Drive both values from the same content-modification timestamp.",
    category: "crawl",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
    // Check names by outcome class (#1741, #2218).
    checks: [
      { name: "sitemap-lastmod-behind-page", outcome: "problem" },
      { name: "sitemap-lastmod-ahead-of-page", outcome: "problem" },
      {
        name: "sitemap-lastmod-drift",
        outcome: "clean",
        clears: [
          "sitemap-lastmod-behind-page",
          "sitemap-lastmod-ahead-of-page",
        ],
      },
      { name: "sitemap-lastmod-drift", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const sitemaps = ctx.site?.sitemaps;
    const pages = sitePageViews(ctx);

    if (!sitemaps || sitemaps.discovered.length === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-drift",
            status: "skipped",
            message: "No sitemap to compare",
            skipReason: "No sitemap found",
          },
        ],
      };
    }

    if (!pages || pages.length === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-drift",
            status: "skipped",
            message: "No pages to compare",
            skipReason: "No pages crawled",
          },
        ],
      };
    }

    const lastmods = collectLastmods(sitemaps.discovered);
    const behind: Drift[] = [];
    const ahead: Drift[] = [];
    let comparedPages = 0;

    for (const page of pages) {
      let lastmod: string | undefined;
      try {
        lastmod = lastmods.get(normalizeUrl(page.url));
      } catch {
        continue; // Malformed page URL — nothing to match against.
      }
      if (!lastmod) continue;

      // #758, #772: `2024`, `2024-09` and `2024-09-10` name a whole year,
      // month or day, and so may the page's date: two periods that overlap
      // agree, and two that do not are measured between their nearer ends.
      const period = datePeriod(lastmod);
      if (period === null) continue; // Not a date at all: nothing to compare.

      // No page-side date at all is content/freshness territory, not drift.
      const resolved = page.pageDate;
      const pageDate = resolved
        ? { ...resolved, period: datePeriod(resolved.value) }
        : null;
      if (!pageDate || pageDate.period === null) continue;

      comparedPages++;

      // Magnitude only — direction is read off the comparison below. Truncated,
      // not rounded: rounding moved the real thresholds half a day past the
      // documented ones (a 7.5-day gap warned, and was quoted back to the user
      // as "8 day(s)" under a message reading "more than 7 day(s)").
      const deltaDays = Math.floor(
        periodGapMs(pageDate.period, period) / MS_PER_DAY
      );
      const drift: Drift = {
        url: page.url,
        lastmod,
        pageDate: pageDate.value,
        source: pageDate.source,
        deltaDays,
      };

      if (pageDate.period.start > period.end && deltaDays > opts.behind_days)
        behind.push(drift);
      else if (
        pageDate.period.end < period.start &&
        deltaDays > opts.ahead_days
      )
        ahead.push(drift);
    }

    if (comparedPages === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-drift",
            status: "skipped",
            message:
              "No sitemap URL carries both a lastmod and a page-side date signal",
            skipReason: "No comparable dates",
          },
        ],
      };
    }

    // Worst drift first, URL as the tie-break — deterministic regardless of the
    // order pages were crawled in.
    const byDelta = (a: Drift, b: Drift) =>
      b.deltaDays - a.deltaDays || a.url.localeCompare(b.url);
    behind.sort(byDelta);
    ahead.sort(byDelta);

    const checks: CheckResult[] = [];

    // Reported separately from the ahead case: they point at different code.
    // Behind = stale sitemap or inverted date precedence, and it is the more
    // clearly wrong of the two (crawlers skip a page that really did change).
    if (behind.length > 0) {
      checks.push(
        buildCheck(
          "sitemap-lastmod-behind-page",
          behind,
          `${behind.length} page(s) have a sitemap lastmod older than the page's own dateModified by more than ${opts.behind_days} day(s)`,
          comparedPages
        )
      );
    }

    // Ahead = lastmod stamped at build/deploy time rather than on content change.
    if (ahead.length > 0) {
      checks.push(
        buildCheck(
          "sitemap-lastmod-ahead-of-page",
          ahead,
          `${ahead.length} page(s) have a sitemap lastmod newer than the page's own dateModified by more than ${opts.ahead_days} day(s)`,
          comparedPages
        )
      );
    }

    if (checks.length === 0) {
      checks.push({
        name: "sitemap-lastmod-drift",
        status: "pass",
        message: `${comparedPages} sitemap URL(s) carry a lastmod consistent with the page's own dateModified`,
        details: { comparedPages },
      });
    }

    return { checks };
  },
};
