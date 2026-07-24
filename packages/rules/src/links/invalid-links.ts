// links/invalid-links - Reports invalid link formats

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const invalidLinksRule: Rule = {
  meta: {
    id: "links/invalid-links",
    name: "Invalid Links",
    description: "Detects invalid link formats on the page",
    solution:
      "Invalid links (malformed URLs, javascript: links, or broken references) harm user experience and can indicate code issues. Fix or remove invalid links. Replace javascript:void(0) with proper href values or button elements. Ensure all links have valid URL formats. Check for typos in URLs and verify links work correctly. Remove empty href attributes.",
    category: "links",
    scope: "page",
    severity: "warning",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const invalidLinks = ctx.parsed.links.filter((link) => Boolean(link.error));
    const checks: CheckResult[] = [];

    if (invalidLinks.length === 0) {
      checks.push({
        name: "invalid-links",
        status: "pass",
        message: "No invalid link formats found",
      });
    } else {
      checks.push({
        name: "invalid-links",
        status: "warn",
        message: `Found ${invalidLinks.length} invalid link(s)`,
        items: invalidLinks.map((link) => ({
          id: link.url,
          label: link.error ?? "Invalid format",
          meta: { text: link.text, error: link.error },
        })),
      });
    }

    return { checks };
  },
};
