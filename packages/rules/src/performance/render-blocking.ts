// perf/render-blocking - Render-blocking resources

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

export const renderBlockingRule: Rule = {
  meta: {
    id: "perf/render-blocking",
    name: "Render-Blocking Resources",
    description: "Checks for render-blocking CSS and JavaScript",
    solution:
      "Render-blocking resources delay First Contentful Paint (FCP) and LCP. Fix by: 1) Inline critical CSS for above-fold content. 2) Load non-critical CSS with media='print' onload='this.media=all'. 3) Add async or defer to non-critical scripts. 4) Move scripts to end of body when possible. 5) Use <link rel='preload'> for critical resources. Consider tools like Critical to extract critical CSS.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check render-blocking resources
    if (hints.renderBlockingResources.length > 3) {
      checks.push({
        name: "render-blocking",
        status: "warn",
        message: `${hints.renderBlockingResources.length} render-blocking resources`,
        items: hints.renderBlockingResources.map((url) => ({ id: url })),
      });
    } else if (hints.renderBlockingResources.length > 0) {
      checks.push({
        name: "render-blocking",
        status: "info",
        message: `${hints.renderBlockingResources.length} render-blocking resource(s)`,
        items: hints.renderBlockingResources.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "render-blocking",
        status: "pass",
        message: "No significant render-blocking resources",
      });
    }

    return { checks };
  },
};
