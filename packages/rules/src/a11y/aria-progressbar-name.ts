// a11y/aria-progressbar-name - Progressbar elements have accessible names

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

  // Check title
  if (el.getAttribute("title")?.trim()) return true;

  // Check for associated label (for native progress)
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return true;
  }

  return false;
}

export const ariaProgressbarNameRule: Rule = {
  meta: {
    id: "a11y/aria-progressbar-name",
    name: "ARIA Progressbar Name",
    description: "Checks that progressbar elements have accessible names",
    solution:
      "Progressbar elements must have accessible names to describe what process is being tracked. Add aria-label, aria-labelledby, or an associated <label>. Example: <progress aria-label='Upload progress' value='50' max='100'>50%</progress>",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const missingNames: string[] = [];

    // Check elements with progressbar role
    const progressRoles = doc.querySelectorAll('[role="progressbar"]');
    for (const el of progressRoles) {
      if (!hasAccessibleName(el, doc)) {
        const tagName = el.tagName.toLowerCase();
        missingNames.push(`${tagName}[role="progressbar"]`);
      }
    }

    // Check native progress elements
    const progressElements = doc.querySelectorAll("progress");
    for (const progress of progressElements) {
      if (progress.hasAttribute("role")) continue; // Covered by role check
      if (!hasAccessibleName(progress, doc)) {
        const id = progress.getAttribute("id") || "";
        missingNames.push(id ? `progress#${id}` : "progress");
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-progressbar-name",
        status: "fail",
        message: `${missingNames.length} progressbar element(s) without accessible names`,
        items: missingNames.map((id) => ({ id })),
      });
    } else if (progressRoles.length > 0 || progressElements.length > 0) {
      checks.push({
        name: "aria-progressbar-name",
        status: "pass",
        message: "All progressbar elements have accessible names",
      });
    } else {
      checks.push({
        name: "aria-progressbar-name",
        status: "info",
        message: "No progressbar elements found",
      });
    }

    return { checks };
  },
};
