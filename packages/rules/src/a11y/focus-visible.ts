// a11y/focus-visible - Check for focus indicators

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const focusVisibleRule: Rule = {
  meta: {
    id: "a11y/focus-visible",
    name: "Focus Visible",
    description: "Checks for focus indicator styles",
    solution:
      "Keyboard users need visible focus indicators to know where they are on the page. Never use outline: none without providing an alternative focus style. Modern approach: use :focus-visible to show focus only for keyboard users, not mouse clicks. Ensure focus indicators have at least 3:1 contrast. Test by tabbing through your page - can you always see where focus is?",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const html = ctx.page.html;
    const checks: CheckResult[] = [];

    // Check for outline:none or outline:0 without alternative focus styles
    const outlineNonePattern = /outline\s*:\s*(none|0)/gi;
    const focusVisiblePattern = /:focus-visible/gi;
    const focusWithinPattern = /:focus-within/gi;

    const hasOutlineNone = outlineNonePattern.test(html);
    const hasFocusVisible = focusVisiblePattern.test(html);
    const hasFocusWithin = focusWithinPattern.test(html);

    // Check inline styles and style blocks for outline removal
    const dangerousOutlineRemoval = html.match(
      /\*\s*\{[^}]*outline\s*:\s*(none|0)/i
    );

    if (dangerousOutlineRemoval) {
      checks.push({
        name: "focus-outline-global",
        status: "fail",
        message: "Global outline removal detected",
        value: "* { outline: none } removes focus for all elements",
      });
    } else if (hasOutlineNone && !hasFocusVisible) {
      checks.push({
        name: "focus-outline",
        status: "warn",
        message: "outline:none found - ensure alternative focus styles exist",
        value: "Consider using :focus-visible for custom focus styles",
      });
    }

    if (hasFocusVisible || hasFocusWithin) {
      checks.push({
        name: "focus-modern",
        status: "pass",
        message: "Modern focus selectors in use",
        value: hasFocusVisible ? ":focus-visible" : ":focus-within",
      });
    }

    // If no specific issues found, add an info check
    if (checks.length === 0) {
      checks.push({
        name: "focus-visible",
        status: "info",
        message: "Focus styles not analyzed (requires CSS inspection)",
      });
    }

    return { checks };
  },
};
