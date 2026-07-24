// mobile/font-size - Mobile font size check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const fontSizeRule: Rule = {
  meta: {
    id: "mobile/font-size",
    name: "Font Size",
    description: "Checks for readable font sizes on mobile",
    solution:
      "Body text should be at least 16px for readability without zooming. Smaller fonts strain eyes on mobile. Use relative units (rem, em) for scalability. Test on actual devices. Google's mobile-friendly test flags font sizes under 12px. Line height should be at least 1.5 for readability.",
    category: "mobile",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check inline styles for very small fonts
    let smallFontElements = 0;
    const elements = doc.querySelectorAll("[style]");

    for (const el of elements) {
      const style = el.getAttribute("style") || "";
      const fontSizeMatch = style.match(/font-size:\s*([0-9]+)(px|pt)/i);
      if (fontSizeMatch) {
        const size = parseInt(fontSizeMatch[1], 10);
        const unit = fontSizeMatch[2].toLowerCase();
        const pxSize = unit === "pt" ? size * 1.33 : size;

        if (pxSize < 12) {
          smallFontElements++;
        }
      }
    }

    if (smallFontElements > 0) {
      checks.push({
        name: "font-size",
        status: "warn",
        message: `${smallFontElements} element(s) with font-size under 12px`,
        value: "Ensure text is readable without zooming",
      });
    } else {
      checks.push({
        name: "font-size",
        status: "info",
        message: "No extremely small inline font sizes detected",
        value: "Verify body text is at least 16px",
      });
    }

    return { checks };
  },
};
