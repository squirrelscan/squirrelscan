// url/lowercase - URL case check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const urlLowercaseRule: Rule = {
  meta: {
    id: "url/lowercase",
    name: "URL Lowercase",
    description: "Checks that URLs are lowercase",
    solution:
      "URLs should be lowercase to prevent duplicate content issues. Most servers treat /Page and /page as different URLs, creating duplicates. Always use lowercase URLs and redirect uppercase variants. Configure your server or CMS to auto-lowercase URLs. This also improves URL consistency and readability.",
    category: "url",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const path = url.pathname;

    const hasUppercase = /[A-Z]/.test(path);

    if (hasUppercase) {
      checks.push({
        name: "url-lowercase",
        status: "warn",
        message: "URL contains uppercase characters",
        value: path,
        expected: path.toLowerCase(),
      });
    } else {
      checks.push({
        name: "url-lowercase",
        status: "pass",
        message: "URL is lowercase",
      });
    }

    return { checks };
  },
};
