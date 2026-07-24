// core/canonical - Validates canonical URL presence and format

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const canonicalRule: Rule = {
  meta: {
    id: "core/canonical",
    name: "Canonical URL",
    description: "Validates canonical URL presence and format",
    solution:
      'Canonical URLs tell search engines which version of a page is the "master" copy, preventing duplicate content issues. Every page should specify a canonical URL, typically pointing to itself. Add a <link rel="canonical" href="..."> tag in the head section. Use absolute URLs and ensure consistency (with or without trailing slash, www vs non-www). For paginated content, point to the main page or use rel="prev/next".',
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const { canonical } = ctx.parsed.meta;
    const checks: CheckResult[] = [];

    if (!canonical) {
      checks.push({
        name: "canonical",
        status: "warn",
        message: "Missing canonical URL",
        value: null,
      });
      return { checks };
    }

    if (!canonical.startsWith("http")) {
      checks.push({
        name: "canonical",
        status: "fail",
        message: "Canonical URL should be absolute",
        value: canonical,
        expected: "Absolute URL starting with https://",
      });
      return { checks };
    }

    // Check if canonical matches current URL (self-referential)
    try {
      const canonicalUrl = new URL(canonical);
      const pageUrl = new URL(ctx.page.url);

      if (canonicalUrl.href !== pageUrl.href) {
        checks.push({
          name: "canonical",
          status: "info",
          message: "Canonical points to different URL",
          value: canonical,
        });
      } else {
        checks.push({
          name: "canonical",
          status: "pass",
          message: "Self-referential canonical present",
          value: canonical,
        });
      }
    } catch {
      checks.push({
        name: "canonical",
        status: "fail",
        message: "Invalid canonical URL format",
        value: canonical,
      });
    }

    return { checks };
  },
};
