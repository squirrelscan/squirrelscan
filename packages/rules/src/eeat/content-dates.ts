// eeat/content-dates - Published and updated date signals

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes } from "@squirrelscan/utils";

export const contentDatesRule: Rule = {
  meta: {
    id: "eeat/content-dates",
    name: "Content Dates",
    description: "Checks for published and modified dates on content",
    solution:
      "Visible dates show content freshness and help users assess relevance. Include datePublished and dateModified in Article schema. Show human-readable dates on pages. Update dateModified when making significant changes. Fresh content signals ongoing maintenance and expertise. Stale dates may hurt rankings for time-sensitive topics.",
    category: "eeat",
    scope: "site",
    severity: "warning",
    weight: 4,
    // Published / modified dates matter for time-sensitive editorial content;
    // they're noise on a SaaS marketing site, ecommerce store, or landing page.
    // Gate to content-publishing types. Offline / no-metadata runs as today.
    appliesWhen: { siteTypes: ["blog", "news", "healthcare_provider", "education"] },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "content-dates",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    let pagesWithDates = 0;
    let pagesWithModified = 0;
    let contentPages = 0;

    for (const page of pages) {
      const hasArticleSchema = page.parsed.schema.types.some((t) =>
        ["Article", "BlogPosting", "NewsArticle"].includes(t)
      );
      // A page with visible byline/date markup (Kadence-style entry pages) is
      // article content even without JSON-LD Article schema — otherwise we'd
      // skip the very pages this fix is meant to detect.
      const hasVisibleContentSignal =
        page.parsed.visibleDatePublished != null ||
        page.parsed.visibleAuthor != null;

      if (!hasArticleSchema && !hasVisibleContentSignal && pages.length > 5)
        continue;
      contentPages++;

      // Check for date schema
      let hasDatePublished = false;
      let hasDateModified = false;

      if (page.parsed.schema.raw) {
        // Flattened nodes include @graph children — top-level-only checks
        // miss every date on Yoast-style sites.
        const nodes = flattenJsonLdNodes(page.parsed.schema.raw);
        hasDatePublished = nodes.some((s) => s["datePublished"]);
        hasDateModified = nodes.some((s) => s["dateModified"]);
      }

      // Fall back to visible entry-meta `<time>` markup (`entry-date published`,
      // `[itemprop="datePublished"]`, `updated`) for themes that omit JSON-LD
      // dates. Footer/header dates are already filtered by the parser.
      if (!hasDatePublished && page.parsed.visibleDatePublished) {
        hasDatePublished = true;
      }
      if (!hasDateModified && page.parsed.visibleDateModified) {
        hasDateModified = true;
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

    return { checks };
  },
};
