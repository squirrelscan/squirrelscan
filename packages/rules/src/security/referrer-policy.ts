// security/referrer-policy - Referrer-Policy header

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const SAFE_POLICIES = [
  "no-referrer",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
];

export const referrerPolicyRule: Rule = {
  meta: {
    id: "security/referrer-policy",
    name: "Referrer-Policy",
    description: "Checks for Referrer-Policy header",
    solution:
      "Referrer-Policy controls what referrer information is sent with requests. Recommended: 'strict-origin-when-cross-origin' (default in modern browsers) sends origin only cross-site. 'no-referrer' for maximum privacy, 'same-origin' to only send referrer to same origin. Avoid 'unsafe-url' which leaks full URLs including paths.",
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
        name: "referrer-policy",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const headers = firstPage.headers ?? {};
    const referrerPolicy = headers["referrer-policy"];

    if (!referrerPolicy) {
      checks.push({
        name: "referrer-policy",
        status: "info",
        message: "No Referrer-Policy header (browser default applies)",
        value: "Modern browsers default to strict-origin-when-cross-origin",
      });
      return { checks };
    }

    const policies = referrerPolicy
      .toLowerCase()
      .split(",")
      .map((p) => p.trim());

    if (policies.includes("unsafe-url")) {
      checks.push({
        name: "referrer-policy",
        status: "warn",
        message: "Referrer-Policy includes unsafe-url",
        value: "This leaks full URLs cross-origin",
      });
    } else if (policies.some((p) => SAFE_POLICIES.includes(p))) {
      checks.push({
        name: "referrer-policy",
        status: "pass",
        message: "Referrer-Policy header present",
        value: referrerPolicy,
      });
    } else {
      checks.push({
        name: "referrer-policy",
        status: "info",
        message: "Referrer-Policy header present",
        value: referrerPolicy,
      });
    }

    return { checks };
  },
};
