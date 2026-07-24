// a11y/listitem - List items are in lists

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const listitemRule: Rule = {
  meta: {
    id: "a11y/listitem",
    name: "List Item Context",
    description: "Checks that li elements are inside ul, ol, or menu",
    solution:
      "The <li> element must be contained within a <ul>, <ol>, or <menu> element. Orphaned list items lose their semantic meaning. Wrap them in an appropriate list container.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const listItems = doc.querySelectorAll("li");
    const orphaned: string[] = [];

    for (const li of listItems) {
      const parent = li.parentElement;
      const parentTag = parent?.tagName.toLowerCase();
      const parentRole = parent?.getAttribute("role");

      // Valid parents: ul, ol, menu, or element with role="list"
      const isInList =
        parentTag === "ul" ||
        parentTag === "ol" ||
        parentTag === "menu" ||
        parentRole === "list";

      if (!isInList) {
        const text = li.textContent?.trim().slice(0, 20);
        const id = li.getAttribute("id");
        orphaned.push(
          id
            ? `li#${id}`
            : `li: "${text}${text && text.length >= 20 ? "..." : ""}"`
        );
      }
    }

    if (orphaned.length > 0) {
      checks.push({
        name: "listitem",
        status: "fail",
        message: `${orphaned.length} li element(s) not inside a list`,
        items: orphaned.slice(0, 10).map((id) => ({ id })),
        details:
          orphaned.length > 10
            ? { additional: orphaned.length - 10 }
            : undefined,
      });
    } else if (listItems.length > 0) {
      checks.push({
        name: "listitem",
        status: "pass",
        message: `${listItems.length} list item(s) are inside lists`,
      });
    } else {
      checks.push({
        name: "listitem",
        status: "info",
        message: "No li elements found",
      });
    }

    return { checks };
  },
};
