// security/permissions-policy - Permissions-Policy header

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const permissionsPolicyRule: Rule = {
  meta: {
    id: "security/permissions-policy",
    name: "Permissions-Policy",
    description: "Checks for Permissions-Policy (Feature-Policy) header",
    solution:
      "Permissions-Policy controls which browser features your site can use (camera, microphone, geolocation, etc.). This limits what embedded iframes can access. Example: Permissions-Policy: camera=(), microphone=(), geolocation=(). Empty parentheses disable the feature entirely. This is especially important if you embed third-party content.",
    category: "security",
    scope: "site",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const firstPage = ctx.site?.pages[0];

    if (!firstPage) {
      checks.push({
        name: "permissions-policy",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const headers = firstPage.headers ?? {};
    const permissionsPolicy = headers["permissions-policy"];
    const featurePolicy = headers["feature-policy"]; // Legacy name

    if (permissionsPolicy) {
      checks.push({
        name: "permissions-policy",
        status: "pass",
        message: "Permissions-Policy header present",
        value:
          permissionsPolicy.substring(0, 100) +
          (permissionsPolicy.length > 100 ? "..." : ""),
      });
    } else if (featurePolicy) {
      checks.push({
        name: "permissions-policy",
        status: "info",
        message: "Using deprecated Feature-Policy header",
        value: "Migrate to Permissions-Policy",
      });
    } else {
      checks.push({
        name: "permissions-policy",
        status: "info",
        message: "No Permissions-Policy header",
        value: "Consider restricting browser features",
      });
    }

    return { checks };
  },
};
