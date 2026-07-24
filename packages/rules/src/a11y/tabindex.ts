// a11y/tabindex - Tabindex values are appropriate

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI, querySelectorAllByAttrCI } from "@squirrelscan/utils";

export const tabindexRule: Rule = {
  meta: {
    id: "a11y/tabindex",
    name: "Tabindex Values",
    description: "Checks for appropriate tabindex values",
    solution:
      "Avoid positive tabindex values (1, 2, 3...) as they override natural tab order and confuse keyboard users. Use tabindex='0' to add elements to tab order, tabindex='-1' to make elements focusable via JavaScript only. Rely on natural document order for tab sequence.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const elementsWithTabindex = querySelectorAllByAttrCI(doc, "*", "tabindex");
    const positiveTabindex: string[] = [];
    const veryHighTabindex: string[] = [];

    for (const el of elementsWithTabindex) {
      const tabindex = getAttrCI(el, "tabindex");
      if (!tabindex) continue;

      const value = Number.parseInt(tabindex, 10);

      // Skip 0 and -1 which are valid uses
      if (value === 0 || value === -1) continue;

      // Flag positive values
      if (value > 0) {
        const tagName = el.tagName.toLowerCase();
        const id = el.getAttribute("id");
        const cls = el.getAttribute("class")?.split(" ")[0];

        const identifier = id
          ? `${tagName}#${id}`
          : cls
            ? `${tagName}.${cls}`
            : tagName;

        if (value > 100) {
          veryHighTabindex.push(`${identifier} (tabindex=${value})`);
        } else {
          positiveTabindex.push(`${identifier} (tabindex=${value})`);
        }
      }
    }

    if (veryHighTabindex.length > 0) {
      checks.push({
        name: "tabindex-very-high",
        status: "fail",
        message: `${veryHighTabindex.length} element(s) with very high tabindex values`,
        items: veryHighTabindex.slice(0, 10).map((id) => ({ id })),
        details: {
          issue: "Very high tabindex values indicate misuse",
        },
      });
    }

    if (positiveTabindex.length > 0) {
      checks.push({
        name: "tabindex-positive",
        status: "warn",
        message: `${positiveTabindex.length} element(s) with positive tabindex`,
        items: positiveTabindex.slice(0, 10).map((id) => ({ id })),
        details: {
          suggestion: "Use natural document order instead",
        },
      });
    }

    if (positiveTabindex.length === 0 && veryHighTabindex.length === 0) {
      if (elementsWithTabindex.length > 0) {
        checks.push({
          name: "tabindex",
          status: "pass",
          message: "Tabindex values are appropriate (0 or -1)",
          details: { elementsWithTabindex: elementsWithTabindex.length },
        });
      } else {
        checks.push({
          name: "tabindex",
          status: "info",
          message: "No tabindex attributes found",
        });
      }
    }

    return { checks };
  },
};
