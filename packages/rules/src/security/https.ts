// security/https - Checks for HTTPS usage

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const httpsRule: Rule = {
  meta: {
    id: "security/https",
    name: "HTTPS",
    description: "Checks for HTTPS usage",
    solution:
      "HTTPS encrypts data between users and your server, protecting sensitive information. It's a ranking signal and required for many modern browser features. Migrate to HTTPS by obtaining an SSL certificate (free from Let's Encrypt). Update internal links to use https://. Set up 301 redirects from HTTP to HTTPS. Update your canonical URLs and sitemap. Check for mixed content warnings after migration.",
    category: "security",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    try {
      const url = new URL(ctx.page.url);

      if (url.protocol !== "https:") {
        checks.push({
          name: "https",
          status: "fail",
          message: "Page not served over HTTPS",
          value: url.protocol,
          expected: "https:",
        });
      } else {
        checks.push({
          name: "https",
          status: "pass",
          message: "Page served over HTTPS",
          value: "https:",
        });
      }
    } catch {
      checks.push({
        name: "https",
        status: "fail",
        message: "Invalid URL format",
        value: ctx.page.url,
      });
    }

    return { checks };
  },
};
