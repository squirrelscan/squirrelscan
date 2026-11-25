// eeat/content-dates - Published and updated date signals

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { skipsNoindexPages } from "../shared/noindex";
import { sitePageViews } from "../shared/site-page-view";
import {
  bylineConsistencyDeviants,
  defersToBylineConsistency,
} from "./byline-consistency";

export const contentDatesRule: Rule = {
  meta: {
    id: "eeat/content-dates",
    name: "Content Dates",
    description: "Checks for published and modified dates on content",
    solution:
      "Visible dates show content freshness and help users assess relevance. Include datePublished and dateModified in Article schema. Show human-readable dates on pages. Update dateModified when making significant changes. Fresh content signals ongoing maintenance and expertise. Stale dates may hurt rankings for time-sensitive topics.",
    category: "eeat",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 4,
    // Published / modified dates matter for time-sensitive editorial content;
    // they're noise on a SaaS marketing site, ecommerce store, or landing page.
    // Gate to content-publishing types. Offline / no-metadata runs as today.
    appliesWhen: {
      siteTypes: ["blog", "news", "healthcare_provider", "education"],
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = sitePageViews(ctx);

    if (!pages || pages.length === 0) {
      checks.push({
        name: "content-dates",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Precedence (#1364): a page that breaks its page type's own date convention is
    // reported by eeat/byline-consistency, so it is not counted undated here too.
    const deferred = defersToBylineConsistency(ctx)
      ? bylineConsistencyDeviants(pages, skipsNoindexPages(ctx.site)).date
      : new Set<string>();
    let deferredPages = 0;

    let pagesWithDates = 0;
    let pagesWithModified = 0;
    let contentPages = 0;

    for (const page of pages) {
      const hasArticleSchema = page.schemaTypes.some((t) =>
        ["Article", "BlogPosting", "NewsArticle"].includes(t)
      );
      // A page with visible byline/date markup (Kadence-style entry pages) is
      // article content even without JSON-LD Article schema — otherwise we'd
      // skip the very pages this fix is meant to detect.
      const hasVisibleContentSignal =
        page.visibleDatePublished != null || page.visibleAuthor != null;

      if (!hasArticleSchema && !hasVisibleContentSignal && pages.length > 5)
        continue;
      contentPages++;

      // Check for date schema
      // The view flattens the JSON-LD graph, so a date on an @graph child counts
      // (a top-level-only check misses every date on Yoast-style sites).
      let hasDatePublished = page.schemaDatePublished;
      let hasDateModified = page.schemaDateModified;

      // Fall back to visible entry-meta `<time>` markup (`entry-date published`,
      // `[itemprop="datePublished"]`, `updated`) for themes that omit JSON-LD
      // dates. Footer/header dates are already filtered by the parser.
      if (!hasDatePublished && page.visibleDatePublished) {
        hasDatePublished = true;
      }
      if (!hasDateModified && page.visibleDateModified) {
        hasDateModified = true;
      }

      if (!hasDatePublished && deferred.has(page.url)) {
        contentPages--;
        deferredPages++;
        continue;
      }

      if (hasDatePublished) pagesWithDates++;
      if (hasDateModified) pagesWithModified++;
    }

    if (contentPages === 0) {
      checks.push({
        name: "content-dates",
        status: "info",
        message: "No article content detected for date analysis",
      });
      return { checks };
    }

    const datePercentage = Math.round((pagesWithDates / contentPages) * 100);
    const modifiedPercentage = Math.round(
      (pagesWithModified / contentPages) * 100
    );

    if (datePercentage >= 80) {
      checks.push({
        name: "date-published",
        status: "pass",
        message: `${datePercentage}% of content has datePublished`,
      });
    } else {
      checks.push({
        name: "date-published",
        status: "warn",
        message:
          pagesWithDates === 0
            ? "No content pages have datePublished"
            : `Only ${datePercentage}% of content has datePublished`,
        value: "Add dates to Article schema",
      });
    }

    if (modifiedPercentage >= 50) {
      checks.push({
        name: "date-modified",
        status: "pass",
        message: `${modifiedPercentage}% of content has dateModified`,
      });
    } else {
      checks.push({
        name: "date-modified",
        status: "info",
        message: `${modifiedPercentage}% of content has dateModified`,
        value: "Add dateModified to show freshness",
      });
    }

    if (deferredPages > 0) {
      const check = checks.find((c) => c.name === "date-published");
      if (check)
        check.details = {
          ...check.details,
          deferredToBylineConsistency: deferredPages,
        };
    }

    return { checks };
  },
};
