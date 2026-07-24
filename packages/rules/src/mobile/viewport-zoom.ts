// mobile/viewport-zoom - Viewport zoom check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const viewportZoomRule: Rule = {
  meta: {
    id: "mobile/viewport-zoom",
    name: "Viewport Zoom",
    description: "Checks that viewport doesn't disable user zoom",
    solution:
      "Never disable user zoom with maximum-scale=1, user-scalable=no, or user-scalable=0. Users with visual impairments need to zoom. This is an accessibility violation (WCAG 1.4.4). It also harms usability for all users. Remove these properties from your viewport meta tag.",
    category: "mobile",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const viewport = doc.querySelector('meta[name="viewport"]');

    if (!viewport) {
      checks.push({
        name: "viewport-zoom",
        status: "skipped",
        message: "No viewport meta tag to check",
      });
      return { checks };
    }

    const content = viewport.getAttribute("content") || "";

    // Check for zoom-disabling properties
    const hasUserScalableNo =
      /user-scalable\s*=\s*no/i.test(content) ||
      /user-scalable\s*=\s*0/i.test(content);

    const hasMaxScale = /maximum-scale\s*=\s*1(\.0)?(?![0-9])/i.test(content);

    const issues: string[] = [];

    if (hasUserScalableNo) {
      issues.push("user-scalable=no");
    }
    if (hasMaxScale) {
      issues.push("maximum-scale=1");
    }

    if (issues.length > 0) {
      checks.push({
        name: "viewport-zoom",
        status: "fail",
        message: "Viewport disables user zoom (accessibility issue)",
        items: issues.map((issue) => ({ id: issue })),
      });
    } else {
      checks.push({
        name: "viewport-zoom",
        status: "pass",
        message: "Viewport allows user zoom",
      });
    }

    return { checks };
  },
};
