// url/length - URL length check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const RECOMMENDED_MAX = 75;
const WARNING_THRESHOLD = 100;

export const urlLengthRule: Rule = {
  meta: {
    id: "url/length",
    name: "URL Length",
    description: "Checks URL length for optimal SEO",
    solution:
      "Shorter URLs are easier to read, share, and may rank better. Keep URLs under 75 characters when possible. URLs over 100 characters can be truncated in search results and social shares. Remove unnecessary parameters, stop words, and path segments. Use descriptive but concise slugs. Long URLs often indicate poor site architecture.",
    category: "url",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const fullLength = ctx.page.url.length;

    if (fullLength > WARNING_THRESHOLD) {
      checks.push({
        name: "url-length",
        status: "warn",
        message: `URL is ${fullLength} characters (over ${WARNING_THRESHOLD})`,
        value: ctx.page.url.substring(0, 60) + "...",
      });
    } else if (fullLength > RECOMMENDED_MAX) {
      checks.push({
        name: "url-length",
        status: "info",
        message: `URL is ${fullLength} characters (recommended: <${RECOMMENDED_MAX})`,
        value: ctx.page.url,
      });
    } else {
      checks.push({
        name: "url-length",
        status: "pass",
        message: `URL length is optimal (${fullLength} chars)`,
      });
    }

    // Check path depth
    const pathSegments = url.pathname.split("/").filter((s) => s.length > 0);
    if (pathSegments.length > 4) {
      checks.push({
        name: "url-depth",
        status: "info",
        message: `URL has ${pathSegments.length} path segments (deep nesting)`,
        value: "Consider flattening site structure",
      });
    }

    return { checks };
  },
};
