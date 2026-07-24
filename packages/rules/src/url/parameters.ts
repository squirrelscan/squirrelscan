// url/parameters - URL parameter check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const EXCESSIVE_PARAMS = 3;

export const urlParametersRule: Rule = {
  meta: {
    id: "url/parameters",
    name: "URL Parameters",
    description: "Checks for excessive URL parameters",
    solution:
      "Excessive URL parameters can cause crawl budget waste and duplicate content. Each parameter combination creates a unique URL. Use parameter handling in Google Search Console to tell Google how to handle parameters. Consider using path segments instead of parameters for important content. Filter/sort parameters should be handled with canonical tags or robots meta.",
    category: "url",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const params = Array.from(url.searchParams.keys());
    const paramCount = params.length;

    if (paramCount === 0) {
      checks.push({
        name: "url-parameters",
        status: "pass",
        message: "URL has no query parameters",
      });
      return { checks };
    }

    if (paramCount > EXCESSIVE_PARAMS) {
      checks.push({
        name: "url-parameters",
        status: "warn",
        message: `URL has ${paramCount} parameters (excessive)`,
        items: params.map((param) => ({ id: param })),
      });
    } else {
      checks.push({
        name: "url-parameters",
        status: "info",
        message: `URL has ${paramCount} parameter(s)`,
        items: params.map((param) => ({ id: param })),
      });
    }

    // Check for tracking parameters that shouldn't be indexed
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ref",
      "source",
    ];
    const foundTracking = params.filter((p) =>
      trackingParams.includes(p.toLowerCase())
    );

    if (foundTracking.length > 0) {
      checks.push({
        name: "tracking-parameters",
        status: "info",
        message: "URL contains tracking parameters",
        value: `Use canonical tags to prevent duplicate content`,
      });
    }

    return { checks };
  },
};
