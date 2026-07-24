// content/freshness - Content freshness signals

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const freshnessRule: Rule = {
  meta: {
    id: "content/freshness",
    name: "Content Freshness",
    description: "Checks for last-modified and published date signals",
    solution:
      "Date signals help search engines understand content freshness. Use Article schema with datePublished and dateModified. Show visible publication dates on content. Update dates when making significant changes. For evergreen content, periodic updates with new dateModified signal relevance. The Last-Modified HTTP header also helps crawlers.",
    category: "content",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check HTTP Last-Modified header
    const lastModified = ctx.page.headers["last-modified"];
    if (lastModified) {
      checks.push({
        name: "http-last-modified",
        status: "pass",
        message: "Last-Modified header present",
        value: lastModified,
      });
    }

    // Check for schema.org dates
    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let hasSchemaDate = false;

    for (const script of schemaScripts) {
      const content = script.textContent || "";
      if (
        content.includes("datePublished") ||
        content.includes("dateModified")
      ) {
        hasSchemaDate = true;
        break;
      }
    }

    if (hasSchemaDate) {
      checks.push({
        name: "schema-dates",
        status: "pass",
        message: "Date schema markup present",
      });
    }

    // Check time elements
    const timeElements = doc.querySelectorAll("time[datetime]");
    if (timeElements.length > 0) {
      checks.push({
        name: "time-elements",
        status: "pass",
        message: `${timeElements.length} <time> element(s) found`,
        value:
          (timeElements[0] as Element).getAttribute("datetime") || undefined,
      });
    }

    // Check meta article dates
    const articlePublished = doc.querySelector(
      'meta[property="article:published_time"]'
    );
    const articleModified = doc.querySelector(
      'meta[property="article:modified_time"]'
    );

    if (articlePublished || articleModified) {
      checks.push({
        name: "og-article-dates",
        status: "pass",
        message: "Open Graph article dates present",
        value:
          articlePublished?.getAttribute("content") ||
          articleModified?.getAttribute("content") ||
          undefined,
      });
    }

    // Summary
    const hasAnySig =
      lastModified ||
      hasSchemaDate ||
      timeElements.length > 0 ||
      articlePublished;

    if (!hasAnySig) {
      checks.push({
        name: "freshness",
        status: "info",
        message: "No freshness signals detected",
        value: "Consider adding date schema or Last-Modified header",
      });
    }

    return { checks };
  },
};
