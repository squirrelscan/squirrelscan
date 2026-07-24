// perf/lcp-hints - LCP optimization hints

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

export const lcpHintsRule: Rule = {
  meta: {
    id: "perf/lcp-hints",
    name: "LCP Optimization Hints",
    description:
      "Checks for Largest Contentful Paint optimization opportunities",
    solution:
      "LCP measures when the largest content element becomes visible. Optimize by: 1) Preload your LCP image with <link rel='preload' as='image'>. 2) Don't use loading='lazy' on above-fold images as it delays loading. 3) Minimize render-blocking CSS/JS in <head>. 4) Use modern image formats (WebP/AVIF) for faster loading. 5) Consider using fetchpriority='high' on the LCP image.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check for LCP images without preload
    if (hints.largeImagesWithoutPreload.length > 0) {
      const n = hints.largeImagesWithoutPreload.length;
      // No items → per-page count, not a cross-page image dump (squirrelscan/squirrelscan#16).
      checks.push({
        name: "lcp-preload",
        status: "warn",
        message: `${n} likely-LCP image${n === 1 ? "" : "s"} loaded without preload`,
        value: n,
      });
    } else {
      checks.push({
        name: "lcp-preload",
        status: "pass",
        message: "LCP images appear to be optimized",
      });
    }

    return { checks };
  },
};
