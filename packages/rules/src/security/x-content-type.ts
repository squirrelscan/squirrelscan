// security/x-content-type - X-Content-Type-Options header

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const xContentTypeRule: Rule = {
  meta: {
    id: "security/x-content-type",
    name: "X-Content-Type-Options",
    description: "Checks for MIME type sniffing protection",
    solution:
      "X-Content-Type-Options: nosniff prevents browsers from MIME-sniffing responses, which could lead to security vulnerabilities. This is especially important for sites that allow file uploads or serve user-generated content. Simply add the header: X-Content-Type-Options: nosniff. This has no downside and improves security.",
    category: "security",
    scope: "site",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const firstPage = ctx.site?.pages[0];

    if (!firstPage) {
      checks.push({
        name: "x-content-type",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const headers = firstPage.headers ?? {};
    const xContentTypeOptions = headers["x-content-type-options"];

    if (xContentTypeOptions?.toLowerCase() === "nosniff") {
      checks.push({
        name: "x-content-type",
        status: "pass",
        message: "X-Content-Type-Options: nosniff is set",
      });
    } else if (xContentTypeOptions) {
      checks.push({
        name: "x-content-type",
        status: "warn",
        message: "X-Content-Type-Options has unexpected value",
        value: xContentTypeOptions,
        expected: "nosniff",
      });
    } else {
      checks.push({
        name: "x-content-type",
        status: "info",
        message: "Missing X-Content-Type-Options header",
        value: "Add: X-Content-Type-Options: nosniff",
      });
    }

    return { checks };
  },
};
