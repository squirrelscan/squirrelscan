// perf/cls-hints - CLS optimization hints

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

function absoluteUrl(src: string, base: string): string {
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

export const clsHintsRule: Rule = {
  meta: {
    id: "perf/cls-hints",
    name: "CLS Optimization Hints",
    description: "Checks for Cumulative Layout Shift prevention",
    solution:
      "CLS measures visual stability - how much content shifts during load. Prevent layout shifts by: 1) Always set width and height attributes on images and iframes. 2) Reserve space for ads and embeds with CSS min-height. 3) Use CSS aspect-ratio for responsive media. 4) Avoid inserting content above existing content. 5) Use transform animations instead of properties that trigger layout.",
    category: "perf",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Images without dimensions are owned by images/dimensions (#1768): it flags a
    // superset of what this rule would (it also flags an image with only one
    // attribute or sized by inline style), so warning here counted the same image
    // twice. This check stays as an info row pointing there, keyed by the same
    // absolute URL, and never affects the score.
    if (hints.imagesWithoutDimensions.length > 0) {
      const urls = [...new Set(hints.imagesWithoutDimensions.map((src) => absoluteUrl(src, ctx.page.url)))];
      checks.push({
        name: "cls-images",
        status: "info",
        message: `${urls.length} image(s) without width/height: reported by images/dimensions`,
        items: urls.map((url) => ({ id: url })),
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
