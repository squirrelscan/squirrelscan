// perf/cls-hints - CLS optimization hints

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

export const clsHintsRule: Rule = {
  meta: {
    id: "perf/cls-hints",
    name: "CLS Optimization Hints",
    description: "Checks for Cumulative Layout Shift prevention",
    solution:
      "CLS measures visual stability - how much content shifts during load. Prevent layout shifts by: 1) Always set width and height attributes on images and iframes. 2) Reserve space for ads and embeds with CSS min-height. 3) Use CSS aspect-ratio for responsive media. 4) Avoid inserting content above existing content. 5) Use transform animations instead of properties that trigger layout.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check images without dimensions
    if (hints.imagesWithoutDimensions.length > 0) {
      const severity =
        hints.imagesWithoutDimensions.length > 5 ? "fail" : "warn";
      checks.push({
        name: "cls-images",
        status: severity,
        message: `${hints.imagesWithoutDimensions.length} image(s) without width/height (CLS risk)`,
        items: hints.imagesWithoutDimensions.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "cls-images",
        status: "pass",
        message: "All images have dimensions",
      });
    }

    // Check iframes without dimensions
    if (hints.iframesWithoutDimensions.length > 0) {
      checks.push({
        name: "cls-iframes",
        status: "warn",
        message: `${hints.iframesWithoutDimensions.length} iframe(s) without dimensions`,
        items: hints.iframesWithoutDimensions.map((url) => ({ id: url })),
      });
    }

    return { checks };
  },
};
