// content/heading-hierarchy - Validates heading structure

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const headingHierarchyRule: Rule = {
  meta: {
    id: "content/heading-hierarchy",
    name: "Heading Hierarchy",
    description: "Validates heading structure and hierarchy",
    solution:
      "Proper heading structure (H1 → H2 → H3) helps users and search engines understand your content organization. Skipping levels (H1 → H3) creates confusion. Use headings in sequential order without skipping levels. Each section should use the next heading level down. Think of headings as an outline—they should make sense when read alone. Avoid empty headings or using headings purely for styling.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const { headings } = ctx.parsed;
    const checks: CheckResult[] = [];

    // Check for skipped levels
    if (headings.hasSkippedLevels) {
      checks.push({
        name: "heading-hierarchy",
        status: "warn",
        message: `Skipped heading levels detected`,
        items: headings.skippedLevels.map((skip) => ({ id: skip })),
      });
    } else if (headings.headings.length > 0) {
      checks.push({
        name: "heading-hierarchy",
        status: "pass",
        message: "Heading hierarchy is valid",
      });
    }

    // Check for empty headings
    if (headings.emptyHeadings.length > 0) {
      checks.push({
        name: "empty-headings",
        status: "warn",
        message: `${headings.emptyHeadings.length} empty heading(s) found`,
        details: { count: headings.emptyHeadings.length },
      });
    }

    // Check for long headings
    if (headings.longHeadings.length > 0) {
      checks.push({
        name: "long-headings",
        status: "info",
        message: `${headings.longHeadings.length} heading(s) over 70 characters`,
        items: headings.longHeadings.map((h) => ({
          id: `H${h.level}`,
          label: h.text.substring(0, 50),
          meta: { level: h.level, length: h.text.length },
        })),
      });
    }

    // Check for duplicate headings
    if (headings.duplicateHeadings.length > 0) {
      checks.push({
        name: "duplicate-headings",
        status: "info",
        message: `${headings.duplicateHeadings.length} duplicate heading(s)`,
        items: headings.duplicateHeadings.map((text) => ({ id: text })),
      });
    }

    return { checks };
  },
};
