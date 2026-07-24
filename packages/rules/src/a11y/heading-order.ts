// a11y/heading-order - Heading levels don't skip

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const headingOrderRule: Rule = {
  meta: {
    id: "a11y/heading-order",
    name: "Heading Order",
    description: "Checks that heading levels don't skip",
    solution:
      "Headings should follow a logical hierarchy without skipping levels. Screen reader users navigate by headings, so skipping from H1 to H3 is confusing. Correct order: H1 -> H2 -> H3 (not H1 -> H3). You can have multiple headings at the same level, and you can go back up (H3 -> H2 is fine). Think of headings as an outline - they should make sense when read alone.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");

    if (headings.length === 0) {
      checks.push({
        name: "heading-order",
        status: "info",
        message: "No headings found",
      });
      return { checks };
    }

    const skippedLevels: string[] = [];
    let previousLevel = 0;

    for (const heading of headings) {
      const tagName = heading.tagName.toLowerCase();
      const currentLevel = parseInt(tagName.charAt(1), 10);

      // First heading doesn't need to be H1 (could be in a section)
      // But we should check for skips
      if (previousLevel > 0 && currentLevel > previousLevel + 1) {
        const skip = `${tagName.toUpperCase()} after H${previousLevel}`;
        skippedLevels.push(skip);
      }

      previousLevel = currentLevel;
    }

    if (skippedLevels.length > 0) {
      checks.push({
        name: "heading-order",
        status: "warn",
        message: `${skippedLevels.length} heading level skip(s) detected`,
        items: skippedLevels.map((id) => ({ id })),
      });
    } else {
      checks.push({
        name: "heading-order",
        status: "pass",
        message: "Heading levels follow correct order",
        details: { headingsChecked: headings.length },
      });
    }

    return { checks };
  },
};
