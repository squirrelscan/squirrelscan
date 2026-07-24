// mobile/tap-targets - Touch target size check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const tapTargetsRule: Rule = {
  meta: {
    id: "mobile/tap-targets",
    name: "Tap Targets",
    description: "Checks for properly sized touch targets",
    solution:
      "Touch targets (buttons, links) should be at least 44x44 CSS pixels with 8px spacing between them. This ensures users can tap accurately on mobile. Google's mobile-friendly test checks this. Use padding to increase tap area without changing visual size. Pay special attention to navigation links and form inputs.",
    category: "mobile",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Count interactive elements
    const buttons = doc.querySelectorAll("button, [role='button']");
    const links = doc.querySelectorAll("a[href]");
    const inputs = doc.querySelectorAll("input, select, textarea");

    const totalInteractive = buttons.length + links.length + inputs.length;

    // We can't actually measure CSS sizes in static analysis
    // But we can check for inline styles that might indicate small targets
    let potentiallySmall = 0;

    const smallPatterns = [
      /font-size:\s*([0-9]+)px/,
      /height:\s*([0-9]+)px/,
      /width:\s*([0-9]+)px/,
    ];

    for (const el of [...buttons, ...links]) {
      const style = el.getAttribute("style") || "";
      for (const pattern of smallPatterns) {
        const match = style.match(pattern);
        if (match && parseInt(match[1], 10) < 30) {
          potentiallySmall++;
          break;
        }
      }
    }

    if (totalInteractive > 0) {
      checks.push({
        name: "tap-targets",
        status: "info",
        message: `${totalInteractive} interactive element(s) found`,
        value: "Ensure tap targets are at least 44x44px",
      });

      if (potentiallySmall > 0) {
        checks.push({
          name: "small-tap-targets",
          status: "warn",
          message: `${potentiallySmall} element(s) may have small tap targets`,
          value: "Check inline styles for small dimensions",
        });
      }
    }

    return { checks };
  },
};
