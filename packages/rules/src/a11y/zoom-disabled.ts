// a11y/zoom-disabled - Check if viewport disables zoom
// Based on WCAG 1.4.4 Resize Text (Level AA)

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// Lighthouse uses threshold of 5 for maximum-scale
// https://github.com/niceholgate/lighthouse/blob/main/lighthouse-core/audits/accessibility/meta-viewport.js
const MAX_SCALE_THRESHOLD = 5;

export const zoomDisabledRule: Rule = {
  meta: {
    id: "a11y/zoom-disabled",
    name: "Zoom Disabled",
    description: "Checks if viewport meta tag disables user zoom",
    solution:
      "Never disable user zoom - it's critical for users with low vision. Remove user-scalable=no and maximum-scale=1.0 from your viewport meta tag. Good: <meta name='viewport' content='width=device-width, initial-scale=1'>. Bad: <meta name='viewport' content='width=device-width, user-scalable=no, maximum-scale=1.0'>. Users must be able to zoom up to at least 500% (WCAG 1.4.4 requires 200%, but browsers limit to 500%).",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Use double quotes for consistency with other viewport rules
    // Handles both name="viewport" and name='viewport' attribute syntax
    const viewport =
      doc.querySelector('meta[name="viewport"]') ||
      doc.querySelector("meta[name='viewport']");

    if (!viewport) {
      checks.push({
        name: "zoom-disabled",
        status: "info",
        message: "No viewport meta tag found",
      });
      return { checks };
    }

    const content = viewport.getAttribute("content") || "";
    const issues: string[] = [];

    // Check for user-scalable=no or user-scalable=0 or user-scalable=false
    // Handle various formats: user-scalable=no, user-scalable = no, etc.
    const userScalableMatch = content.match(
      /user-scalable\s*=\s*(no|0|false)/i
    );
    if (userScalableMatch) {
      issues.push(`user-scalable=${userScalableMatch[1]}`);
    }

    // Check for maximum-scale < 5 (Lighthouse threshold)
    // Handle decimal formats: 1, 1.0, 1.00, 2.5, etc.
    const maxScaleMatch = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
    if (maxScaleMatch) {
      const maxScale = parseFloat(maxScaleMatch[1]);
      if (!Number.isNaN(maxScale) && maxScale < MAX_SCALE_THRESHOLD) {
        issues.push(`maximum-scale=${maxScaleMatch[1]}`);
      }
    }

    // Check for minimum-scale > 1 (prevents zoom-out to see more content)
    const minScaleMatch = content.match(/minimum-scale\s*=\s*([\d.]+)/i);
    if (minScaleMatch) {
      const minScale = parseFloat(minScaleMatch[1]);
      if (!Number.isNaN(minScale) && minScale > 1) {
        issues.push(`minimum-scale=${minScaleMatch[1]}`);
      }
    }

    if (issues.length > 0) {
      checks.push({
        name: "zoom-disabled",
        status: "fail",
        message: "Viewport restricts user zoom",
        items: issues.map((issue) => ({ id: issue })),
        details: {
          viewport: content,
          threshold: `maximum-scale should be ≥ ${MAX_SCALE_THRESHOLD}`,
        },
      });
    } else {
      checks.push({
        name: "zoom-disabled",
        status: "pass",
        message: "User zoom is not restricted",
      });
    }

    return { checks };
  },
};
