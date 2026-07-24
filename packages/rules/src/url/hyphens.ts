// url/hyphens - URL word separator check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const urlHyphensRule: Rule = {
  meta: {
    id: "url/hyphens",
    name: "URL Hyphens",
    description: "Checks that URLs use hyphens, not underscores",
    solution:
      "Use hyphens (-) to separate words in URLs, not underscores (_). Google treats hyphens as word separators but treats underscores as word joiners. 'blue-shoes' = 'blue' + 'shoes', but 'blue_shoes' = 'blueshoes'. This affects keyword matching and SEO. Replace underscores with hyphens and set up redirects from old URLs.",
    category: "url",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const path = url.pathname;

    const hasUnderscores = path.includes("_");
    const hasHyphens = path.includes("-");

    if (hasUnderscores) {
      const underscoreCount = (path.match(/_/g) || []).length;
      checks.push({
        name: "url-hyphens",
        status: "warn",
        message: `URL uses underscores (${underscoreCount}) instead of hyphens`,
        value: path,
      });
    } else if (hasHyphens) {
      checks.push({
        name: "url-hyphens",
        status: "pass",
        message: "URL uses hyphens for word separation",
      });
    } else {
      checks.push({
        name: "url-hyphens",
        status: "info",
        message: "URL has no word separators",
      });
    }

    return { checks };
  },
};
