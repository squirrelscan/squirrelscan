// a11y/definition-list - Definition lists are properly structured

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const definitionListRule: Rule = {
  meta: {
    id: "a11y/definition-list",
    name: "Definition List Structure",
    description: "Checks that definition lists contain only dt and dd elements",
    solution:
      "Definition lists (<dl>) should only contain <dt> (term) and <dd> (description) elements as direct children. Optionally, they can be wrapped in <div> for styling. Do not put other elements like <p>, <span>, or <li> directly inside <dl>.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const dlElements = doc.querySelectorAll("dl");
    const invalidDls: string[] = [];

    for (const dl of dlElements) {
      const children = dl.children;
      let hasInvalidChild = false;

      for (const child of Array.from(children)) {
        const tagName = child.tagName.toLowerCase();

        // Valid children: dt, dd, or div (as a wrapper)
        if (tagName !== "dt" && tagName !== "dd" && tagName !== "div") {
          hasInvalidChild = true;
          break;
        }

        // If it's a div, check its children
        if (tagName === "div") {
          for (const grandchild of Array.from(child.children)) {
            const gcTagName = grandchild.tagName.toLowerCase();
            if (gcTagName !== "dt" && gcTagName !== "dd") {
              hasInvalidChild = true;
              break;
            }
          }
        }

        if (hasInvalidChild) break;
      }

      if (hasInvalidChild) {
        const id = dl.getAttribute("id");
        const cls = dl.getAttribute("class")?.split(" ")[0];
        invalidDls.push(id ? `dl#${id}` : cls ? `dl.${cls}` : "dl");
      }
    }

    if (invalidDls.length > 0) {
      checks.push({
        name: "definition-list",
        status: "fail",
        message: `${invalidDls.length} definition list(s) with invalid structure`,
        items: invalidDls.map((id) => ({ id })),
      });
    } else if (dlElements.length > 0) {
      checks.push({
        name: "definition-list",
        status: "pass",
        message: `${dlElements.length} definition list(s) are properly structured`,
      });
    } else {
      checks.push({
        name: "definition-list",
        status: "info",
        message: "No definition lists found",
      });
    }

    return { checks };
  },
};
