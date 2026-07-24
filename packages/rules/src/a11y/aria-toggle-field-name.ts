// a11y/aria-toggle-field-name - Toggle fields have accessible names

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

  // Check text content
  if (el.textContent?.trim()) return true;

  // Check for associated label
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return true;
  }

  // Check for wrapping label
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent?.trim()) return true;

  return false;
}

export const ariaToggleFieldNameRule: Rule = {
  meta: {
    id: "a11y/aria-toggle-field-name",
    name: "ARIA Toggle Field Name",
    description:
      "Checks that toggle fields (checkbox, radio, switch) have accessible names",
    solution:
      "Toggle fields need accessible names to describe what they control. Use <label for='id'>, aria-label, aria-labelledby, or wrap in <label>. Example: <label><input type='checkbox'> Subscribe to newsletter</label>",
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

    // Check elements with toggle roles
    const toggleRoles = ["checkbox", "radio", "switch"];
    for (const role of toggleRoles) {
      const elements = doc.querySelectorAll(`[role="${role}"]`);
      for (const el of elements) {
        if (!hasAccessibleName(el, doc)) {
          const tagName = el.tagName.toLowerCase();
          missingNames.push(`${tagName}[role="${role}"]`);
        }
      }
    }

    // Check native checkboxes
    const checkboxes = doc.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      if (checkbox.hasAttribute("role")) continue;
      if (!hasAccessibleName(checkbox, doc)) {
        const name = checkbox.getAttribute("name") || "";
        missingNames.push(name ? `checkbox[name="${name}"]` : "checkbox");
      }
    }

    // Check native radio buttons
    const radios = doc.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      if (radio.hasAttribute("role")) continue;
      if (!hasAccessibleName(radio, doc)) {
        const name = radio.getAttribute("name") || "";
        const value = radio.getAttribute("value") || "";
        missingNames.push(
          name
            ? `radio[name="${name}"]${value ? `[value="${value}"]` : ""}`
            : "radio"
        );
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-toggle-field-name",
        status: "fail",
        message: `${missingNames.length} toggle field(s) without accessible names`,
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details:
          missingNames.length > 10
            ? { additional: missingNames.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-toggle-field-name",
        status: "pass",
        message: "All toggle fields have accessible names",
      });
    }

    return { checks };
  },
};
