// a11y/select-name - Select elements have accessible names

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

  // Check for associated label
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return true;
  }

  // Check for wrapping label
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent?.trim()) return true;

  // Check title attribute
  if (el.getAttribute("title")?.trim()) return true;

  return false;
}

export const selectNameRule: Rule = {
  meta: {
    id: "a11y/select-name",
    name: "Select Name",
    description: "Checks that select elements have accessible names",
    solution:
      "Select elements need accessible labels. Use <label for='selectId'>Label</label>, wrap in <label>, or use aria-label/aria-labelledby.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const selects = doc.querySelectorAll("select");
    const missingNames: string[] = [];

    for (const select of selects) {
      if (!hasAccessibleName(select, doc)) {
        const name = select.getAttribute("name") || "";
        const id = select.getAttribute("id") || "";
        missingNames.push(
          name ? `select[name="${name}"]` : id ? `select#${id}` : "select"
        );
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "select-name",
        status: "fail",
        message: `${missingNames.length} select element(s) without accessible names`,
        items: missingNames.map((id) => ({ id })),
      });
    } else if (selects.length > 0) {
      checks.push({
        name: "select-name",
        status: "pass",
        message: `${selects.length} select element(s) have accessible names`,
      });
    } else {
      checks.push({
        name: "select-name",
        status: "info",
        message: "No select elements found",
      });
    }

    return { checks };
  },
};
