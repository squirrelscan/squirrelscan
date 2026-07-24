// a11y/aria-valid-attr - Valid ARIA attribute names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { validAriaAttributes } from "./aria-data";

export const ariaValidAttrRule: Rule = {
  meta: {
    id: "a11y/aria-valid-attr",
    name: "ARIA Valid Attributes",
    description: "Checks for valid ARIA attribute names",
    solution:
      "Use only valid ARIA attribute names as defined in the WAI-ARIA specification. Common typos include 'aria-labeledby' (should be 'aria-labelledby'), 'aria-role' (should be 'role'), and 'aria-description' vs 'aria-describedby'. Consult MDN or the WAI-ARIA spec for the complete list of valid attributes.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Find all elements with aria-* attributes
    const allElements = doc.querySelectorAll("*");
    const invalidAttrs: string[] = [];

    for (const el of allElements) {
      const attrs = el.attributes;
      if (!attrs) continue;

      for (const attr of Array.from(attrs)) {
        const name = attr.name.toLowerCase();

        // Check only aria-* attributes
        if (name.startsWith("aria-")) {
          if (!validAriaAttributes.has(name)) {
            const tagName = el.tagName.toLowerCase();
            invalidAttrs.push(`${tagName}: ${name}`);
          }
        }
      }
    }

    if (invalidAttrs.length > 0) {
      checks.push({
        name: "aria-valid-attr",
        status: "fail",
        message: `${invalidAttrs.length} invalid ARIA attribute(s) found`,
        items: invalidAttrs.slice(0, 10).map((id) => ({ id })),
        details:
          invalidAttrs.length > 10
            ? { additional: invalidAttrs.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-valid-attr",
        status: "pass",
        message: "All ARIA attributes are valid",
      });
    }

    return { checks };
  },
};
