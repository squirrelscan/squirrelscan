// a11y/touch-targets - Minimum touch target size

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const touchTargetsRule: Rule = {
  meta: {
    id: "a11y/touch-targets",
    name: "Touch Targets",
    description: "Checks for minimum touch target sizing hints",
    solution:
      "Touch targets (buttons, links) should be at least 44x44 pixels for accessibility (WCAG 2.5.5) and usability. Increase size with padding rather than just increasing font size. Ensure at least 8px spacing between adjacent targets. For inline links in text, provide sufficient line-height. This helps users with motor impairments and improves mobile usability for everyone.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check for very small explicit sizes on interactive elements
    const interactiveElements = doc.querySelectorAll(
      "button, a, input[type='submit'], input[type='button'], [role='button']"
    );

    let smallTargetHints = 0;

    for (const el of interactiveElements) {
      const style = el.getAttribute("style") || "";

      // Check for explicit small dimensions in inline styles
      const widthMatch = style.match(/width\s*:\s*(\d+)(px|rem|em)/i);
      const heightMatch = style.match(/height\s*:\s*(\d+)(px|rem|em)/i);

      if (widthMatch) {
        const width = parseInt(widthMatch[1], 10);
        const unit = widthMatch[2];
        // Convert rem/em to approximate px (assuming 16px base)
        const widthPx = unit === "px" ? width : width * 16;
        if (widthPx < 44) {
          smallTargetHints++;
        }
      }

      if (heightMatch) {
        const height = parseInt(heightMatch[1], 10);
        const unit = heightMatch[2];
        const heightPx = unit === "px" ? height : height * 16;
        if (heightPx < 44) {
          smallTargetHints++;
        }
      }
    }

    if (smallTargetHints > 0) {
      checks.push({
        name: "touch-targets",
        status: "warn",
        message: `${smallTargetHints} element(s) with potentially small touch targets`,
        value: "Ensure minimum 44x44px touch targets",
      });
    } else {
      checks.push({
        name: "touch-targets",
        status: "info",
        message: "Touch target sizes require CSS analysis",
        value: "Verify buttons/links are at least 44x44px",
      });
    }

    return { checks };
  },
};
