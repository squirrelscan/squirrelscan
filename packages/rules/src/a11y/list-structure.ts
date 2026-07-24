// a11y/list-structure - Lists contain only allowed elements

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const listStructureRule: Rule = {
  meta: {
    id: "a11y/list-structure",
    name: "List Structure",
    description: "Checks that ul and ol elements contain only li elements",
    solution:
      "Lists (<ul> and <ol>) should only contain <li> elements as direct children. For custom components, you can also use elements with role='listitem'. Move other content inside <li> elements.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const lists = doc.querySelectorAll("ul, ol");
    const invalidLists: string[] = [];

    for (const list of lists) {
      const children = list.children;
      let hasInvalidChild = false;

      for (const child of Array.from(children)) {
        const tagName = child.tagName.toLowerCase();
        const role = child.getAttribute("role");

        // Valid children: li or element with role="listitem"
        // Also allow script and template elements (for frameworks)
        if (
          tagName !== "li" &&
          role !== "listitem" &&
          tagName !== "script" &&
          tagName !== "template"
        ) {
          hasInvalidChild = true;
          break;
        }
      }

      if (hasInvalidChild) {
        const tagName = list.tagName.toLowerCase();
        const id = list.getAttribute("id");
        const cls = list.getAttribute("class")?.split(" ")[0];
        invalidLists.push(
          id ? `${tagName}#${id}` : cls ? `${tagName}.${cls}` : tagName
        );
      }
    }

    if (invalidLists.length > 0) {
      checks.push({
        name: "list-structure",
        status: "fail",
        message: `${invalidLists.length} list(s) with invalid child elements`,
        items: invalidLists.slice(0, 10).map((id) => ({ id })),
        details:
          invalidLists.length > 10
            ? { additional: invalidLists.length - 10 }
            : undefined,
      });
    } else if (lists.length > 0) {
      checks.push({
        name: "list-structure",
        status: "pass",
        message: `${lists.length} list(s) are properly structured`,
      });
    } else {
      checks.push({
        name: "list-structure",
        status: "info",
        message: "No ul/ol lists found",
      });
    }

    return { checks };
  },
};
