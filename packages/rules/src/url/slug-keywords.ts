// url/slug-keywords - URL slug keyword analysis

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// Pagination prefixes to exclude from slug analysis
const PAGINATION_PREFIXES = ["page", "pages", "p"];

export const slugKeywordsRule: Rule = {
  meta: {
    id: "url/slug-keywords",
    name: "Slug Keywords",
    description: "Checks if URL slug contains relevant keywords",
    solution:
      "URLs should contain keywords that describe the page content. Good: /blue-running-shoes. Bad: /product-12345 or /p?id=abc. Include primary keywords in the URL path, but avoid keyword stuffing. URLs should be readable by humans and give users an idea of page content before clicking. Dynamic parameters don't provide SEO value.",
    category: "url",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const path = url.pathname;

    // Check for purely numeric or ID-based URLs
    const segments = path.split("/").filter(Boolean);
    const lastSegment = segments.pop() || "";
    const secondLastSegment =
      segments.length > 0 ? segments[segments.length - 1] : "";

    // Pagination exclusion: /page/N, /pages/N, /p/N
    const isPaginationUrl =
      PAGINATION_PREFIXES.includes(secondLastSegment.toLowerCase()) &&
      /^\d+$/.test(lastSegment);

    if (isPaginationUrl) {
      checks.push({
        name: "slug-keywords",
        status: "pass",
        message: "Pagination URL (excluded from slug analysis)",
      });
      return { checks };
    }

    // Patterns indicating non-descriptive URLs
    const isNumericId = /^\d+$/.test(lastSegment);
    const isShortId =
      /^[a-z0-9]{1,8}$/i.test(lastSegment) && !/[aeiou]{2}/i.test(lastSegment);
    const isHashId = /^[a-f0-9]{8,}$/i.test(lastSegment);
    const isGenericSlug = /^(page|post|item|product|article|node)-?\d+$/i.test(
      lastSegment
    );

    if (isNumericId || isHashId) {
      checks.push({
        name: "slug-keywords",
        status: "warn",
        message: "URL uses numeric/hash ID instead of descriptive slug",
        value: lastSegment,
      });
    } else if (isGenericSlug) {
      checks.push({
        name: "slug-keywords",
        status: "warn",
        message: "URL uses generic slug pattern",
        value: lastSegment,
      });
    } else if (isShortId && lastSegment.length < 4) {
      checks.push({
        name: "slug-keywords",
        status: "info",
        message: "URL slug is very short, may lack keywords",
        value: lastSegment,
      });
    } else if (lastSegment.length > 0) {
      // Check if slug has actual words
      const words = lastSegment.split(/[-_]/).filter((w) => w.length > 2);
      if (words.length > 0) {
        checks.push({
          name: "slug-keywords",
          status: "pass",
          message: "URL appears to contain descriptive keywords",
          value: lastSegment,
        });
      } else {
        checks.push({
          name: "slug-keywords",
          status: "info",
          message: "URL slug may not be descriptive",
          value: lastSegment,
        });
      }
    } else {
      // Homepage or root path
      checks.push({
        name: "slug-keywords",
        status: "info",
        message: "Root URL (no slug to analyze)",
      });
    }

    return { checks };
  },
};
