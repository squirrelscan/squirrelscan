// a11y/aria-meter-name - Meter elements have accessible names

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

  // Check for associated label (for native meter)
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return true;
  }

  return false;
}

export const ariaMeterNameRule: Rule = {
  meta: {
    id: "a11y/aria-meter-name",
    name: "ARIA Meter Name",
    description: "Checks that meter elements have accessible names",
    solution:
      "Meter elements must have accessible names to describe what they're measuring. Add aria-label, aria-labelledby, or an associated <label>. Example: <meter aria-label='Battery level' value='0.8'>80%</meter>",
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

    // Check elements with meter role
    const meterRoles = doc.querySelectorAll('[role="meter"]');
    for (const el of meterRoles) {
      if (!hasAccessibleName(el, doc)) {
        const tagName = el.tagName.toLowerCase();
        missingNames.push(`${tagName}[role="meter"]`);
      }
    }

    // Check native meter elements
    const meters = doc.querySelectorAll("meter");
    for (const meter of meters) {
      if (meter.hasAttribute("role")) continue; // Covered by role check
      if (!hasAccessibleName(meter, doc)) {
        const id = meter.getAttribute("id") || "";
        missingNames.push(id ? `meter#${id}` : "meter");
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-meter-name",
        status: "fail",
        message: `${missingNames.length} meter element(s) without accessible names`,
        items: missingNames.map((id) => ({ id })),
      });
    } else if (meterRoles.length > 0 || meters.length > 0) {
      checks.push({
        name: "aria-meter-name",
        status: "pass",
        message: "All meter elements have accessible names",
      });
    } else {
      checks.push({
        name: "aria-meter-name",
        status: "info",
        message: "No meter elements found",
      });
    }

    return { checks };
  },
};
