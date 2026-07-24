// links/external-links - Validates external links

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const externalLinksRule: Rule = {
  meta: {
    id: "links/external-links",
    name: "External Links",
    description: "Reports on external link count",
    solution:
      "External links provide additional resources for users and signal content relevance to search engines. They're normal and healthy for most content pages. This check is informational—external links aren't inherently problematic. Ensure external links go to reputable sources and open in new tabs when appropriate. Use rel=\"nofollow\" for untrusted or paid links. Avoid excessive external links that distract from your content.",
    category: "links",
    scope: "page",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const { links } = ctx.parsed;
    const checks: CheckResult[] = [];

    const externalLinks = links.filter((l) => !l.isInternal);
    const count = externalLinks.length;

    if (count === 0) {
      checks.push({
        name: "external-links",
        status: "info",
        message: "No external links on page",
        value: 0,
      });
    } else {
      // Just informational - external links are fine
      checks.push({
        name: "external-links",
        status: "pass",
        message: `${count} external link(s)`,
        value: count,
      });
    }

    return { checks };
  },
};
