// a11y/aria-treeitem-name - Treeitems have accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function hasAccessibleName(el: Element, doc: Document): boolean {
  // Check aria-label
  if (el.getAttribute("aria-label")?.trim()) return true;

  // Check aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    for (const id of ids) {
      if (doc.getElementById(id)?.textContent?.trim()) return true;
    }
  }

  // Check text content (treeitems typically get name from content)
  if (el.textContent?.trim()) return true;

  // Check for nested img with alt
  const img = el.querySelector("img[alt]");
  if (img?.getAttribute("alt")?.trim()) return true;

  return false;
}

export const ariaTreeitemNameRule: Rule = {
  meta: {
    id: "a11y/aria-treeitem-name",
    name: "ARIA Treeitem Name",
    description: "Checks that treeitem elements have accessible names",
    solution:
      "Treeitem elements must have accessible names. Add text content, aria-label, or aria-labelledby. The text content within the treeitem typically serves as its name.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const treeitems = doc.querySelectorAll('[role="treeitem"]');
    const missingNames: string[] = [];

    for (const item of treeitems) {
      if (!hasAccessibleName(item, doc)) {
        const tagName = item.tagName.toLowerCase();
        const id = item.getAttribute("id") || "";
        missingNames.push(id ? `${tagName}#${id}` : tagName);
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-treeitem-name",
        status: "fail",
        message: `${missingNames.length} treeitem(s) without accessible names`,
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details:
          missingNames.length > 10
            ? { additional: missingNames.length - 10 }
            : undefined,
      });
    } else if (treeitems.length > 0) {
      checks.push({
        name: "aria-treeitem-name",
        status: "pass",
        message: `${treeitems.length} treeitem(s) have accessible names`,
      });
    } else {
      checks.push({
        name: "aria-treeitem-name",
        status: "info",
        message: "No treeitem elements found",
      });
    }

    return { checks };
  },
};
