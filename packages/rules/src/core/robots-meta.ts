// core/robots-meta - Checks robots meta tag for noindex/nofollow

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const robotsMetaRule: Rule = {
  meta: {
    id: "core/robots-meta",
    name: "Robots Meta",
    description: "Checks robots meta tag for indexing directives",
    solution:
      'The robots meta tag controls how search engines index and follow links on a page. Common directives include noindex, nofollow, noarchive, and nosnippet. If your page has noindex, it won\'t appear in search results. Review whether this is intentional. For pages that should be indexed, remove the noindex directive or change to "index, follow". Be careful with nofollow as it prevents link equity from flowing to linked pages.',
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const { robots } = ctx.parsed.meta;
    const checks: CheckResult[] = [];

    if (!robots) {
      // No robots meta tag is fine - defaults to index, follow
      checks.push({
        name: "robots-meta",
        status: "pass",
        message: "No robots meta tag (defaults to index, follow)",
        value: null,
      });
      return { checks };
    }

    const robotsLower = robots.toLowerCase();
    const isNoIndex = robotsLower.includes("noindex");
    const isNoFollow = robotsLower.includes("nofollow");

    if (isNoIndex && isNoFollow) {
      checks.push({
        name: "robots-meta",
        status: "warn",
        message: "Page is set to noindex and nofollow",
        value: robots,
      });
    } else if (isNoIndex) {
      checks.push({
        name: "robots-meta",
        status: "warn",
        message: "Page is set to noindex",
        value: robots,
      });
    } else if (isNoFollow) {
      checks.push({
        name: "robots-meta",
        status: "info",
        message: "Page is set to nofollow (links won't pass equity)",
        value: robots,
      });
    } else {
      checks.push({
        name: "robots-meta",
        status: "pass",
        message: "Robots meta tag allows indexing",
        value: robots,
      });
    }

    return { checks };
  },
};
