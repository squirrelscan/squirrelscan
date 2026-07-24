// mobile/viewport - Viewport meta tag check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const viewportRule: Rule = {
  meta: {
    id: "mobile/viewport",
    name: "Viewport Meta",
    description: "Checks for proper viewport meta tag",
    solution:
      "The viewport meta tag is essential for responsive design. Use: <meta name='viewport' content='width=device-width, initial-scale=1'>. This ensures proper scaling on mobile devices. Without it, mobile browsers render at desktop width and zoom out. Required for mobile-first indexing.",
    category: "mobile",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Handle both name="viewport" and name='viewport' attribute syntax
    const viewport =
      doc.querySelector('meta[name="viewport"]') ||
      doc.querySelector("meta[name='viewport']");

    if (!viewport) {
      checks.push({
        name: "viewport",
        status: "fail",
        message: "Missing viewport meta tag",
        value:
          "Add: <meta name='viewport' content='width=device-width, initial-scale=1'>",
      });
      return { checks };
    }

    const content = viewport.getAttribute("content") || "";

    // Check for required properties
    const hasWidth = content.includes("width=");
    const hasDeviceWidth = content.includes("width=device-width");
    const hasInitialScale = content.includes("initial-scale=");

    if (!hasWidth) {
      checks.push({
        name: "viewport",
        status: "warn",
        message: "Viewport missing width property",
        value: content,
      });
    } else if (!hasDeviceWidth) {
      checks.push({
        name: "viewport",
        status: "warn",
        message: "Viewport should use width=device-width",
        value: content,
      });
    } else if (!hasInitialScale) {
      checks.push({
        name: "viewport",
        status: "info",
        message: "Viewport missing initial-scale",
        value: content,
      });
    } else {
      checks.push({
        name: "viewport",
        status: "pass",
        message: "Viewport meta tag is properly configured",
      });
    }

    return { checks };
  },
};
