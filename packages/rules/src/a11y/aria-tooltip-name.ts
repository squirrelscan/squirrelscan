// a11y/aria-tooltip-name - Tooltips have accessible names

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

  // Check text content (tooltips typically have text content as their name)
  if (el.textContent?.trim()) return true;

  return false;
}

export const ariaTooltipNameRule: Rule = {
  meta: {
    id: "a11y/aria-tooltip-name",
    name: "ARIA Tooltip Name",
    description: "Checks that tooltip elements have accessible names",
    solution:
      "Tooltip elements with role='tooltip' must have accessible content. The tooltip content serves as its accessible name. Ensure tooltips have text content or use aria-label for icon-based tooltips.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const tooltips = doc.querySelectorAll('[role="tooltip"]');
    const missingNames: string[] = [];

    for (const tooltip of tooltips) {
      if (!hasAccessibleName(tooltip, doc)) {
        const tagName = tooltip.tagName.toLowerCase();
        const id = tooltip.getAttribute("id") || "";
        missingNames.push(id ? `${tagName}#${id}` : tagName);
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-tooltip-name",
        status: "fail",
        message: `${missingNames.length} tooltip(s) without accessible content`,
        items: missingNames.map((id) => ({ id })),
      });
    } else if (tooltips.length > 0) {
      checks.push({
        name: "aria-tooltip-name",
        status: "pass",
        message: `${tooltips.length} tooltip(s) have accessible names`,
      });
    } else {
      checks.push({
        name: "aria-tooltip-name",
        status: "info",
        message: "No tooltip elements found",
      });
    }

    return { checks };
  },
};
