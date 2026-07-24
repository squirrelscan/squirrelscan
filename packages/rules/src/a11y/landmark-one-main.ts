// a11y/landmark-one-main - Page has one main landmark

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const landmarkOneMainRule: Rule = {
  meta: {
    id: "a11y/landmark-one-main",
    name: "One Main Landmark",
    description: "Checks that the page has exactly one main landmark",
    solution:
      "Each page should have exactly one <main> element or element with role='main'. This helps screen reader users quickly navigate to the primary content. Multiple main landmarks confuse navigation. Use <aside>, <nav>, or other landmarks for secondary content.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Find all main landmarks
    const mainElements = doc.querySelectorAll('main, [role="main"]');
    const count = mainElements.length;

    if (count === 0) {
      checks.push({
        name: "landmark-one-main",
        status: "warn",
        message: "Page has no main landmark",
        expected: "One <main> element or role='main'",
      });
    } else if (count === 1) {
      checks.push({
        name: "landmark-one-main",
        status: "pass",
        message: "Page has exactly one main landmark",
      });
    } else {
      // Multiple mains
      const mainIdentifiers: string[] = [];
      for (const main of mainElements) {
        const tagName = main.tagName.toLowerCase();
        const id = main.getAttribute("id");
        const cls = main.getAttribute("class")?.split(" ")[0];
        mainIdentifiers.push(
          id ? `${tagName}#${id}` : cls ? `${tagName}.${cls}` : tagName
        );
      }

      checks.push({
        name: "landmark-one-main",
        status: "fail",
        message: `Page has ${count} main landmarks (should be 1)`,
        items: mainIdentifiers.map((id) => ({ id })),
        details: {
          issue: "Multiple main landmarks confuse navigation",
        },
      });
    }

    return { checks };
  },
};
