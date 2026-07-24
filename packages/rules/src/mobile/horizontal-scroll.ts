// mobile/horizontal-scroll - Horizontal scroll detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const horizontalScrollRule: Rule = {
  meta: {
    id: "mobile/horizontal-scroll",
    name: "Horizontal Scroll",
    description: "Checks for elements that may cause horizontal scrolling",
    solution:
      "Horizontal scrolling on mobile is a poor user experience and fails Google's mobile-friendly test. Common causes: fixed-width elements, images without max-width, wide tables. Use max-width: 100% on images, responsive tables, and avoid fixed pixel widths. Test on mobile devices.",
    category: "mobile",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const potentialIssues: string[] = [];

    // Check for fixed width elements in inline styles
    const elements = doc.querySelectorAll("[style]");
    let fixedWidthElements = 0;

    for (const el of elements) {
      const style = el.getAttribute("style") || "";
      // Look for width values over 500px
      const widthMatch = style.match(/(?:^|;)\s*width:\s*([0-9]+)px/i);
      if (widthMatch && parseInt(widthMatch[1], 10) > 500) {
        fixedWidthElements++;
      }
    }

    if (fixedWidthElements > 0) {
      potentialIssues.push(`${fixedWidthElements} fixed-width element(s)`);
    }

    // Check for wide tables without responsive wrappers
    const tables = doc.querySelectorAll("table");
    if (tables.length > 0) {
      potentialIssues.push(`${tables.length} table(s) - ensure responsive`);
    }

    // Check for iframes without responsive containers
    const iframes = doc.querySelectorAll("iframe[width]");
    if (iframes.length > 0) {
      potentialIssues.push(`${iframes.length} iframe(s) with fixed width`);
    }

    if (potentialIssues.length > 0) {
      checks.push({
        name: "horizontal-scroll",
        status: "info",
        message: "Elements may cause horizontal scroll on mobile",
        items: potentialIssues.map((issue) => ({ id: issue })),
      });
    } else {
      checks.push({
        name: "horizontal-scroll",
        status: "pass",
        message: "No obvious horizontal scroll issues detected",
      });
    }

    return { checks };
  },
};
