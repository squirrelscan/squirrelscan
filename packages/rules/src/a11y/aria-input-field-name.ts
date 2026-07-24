// a11y/aria-input-field-name - Input fields have accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { inputRoles } from "./aria-data";

function getAccessibleName(el: Element, doc: Document): string | null {
  // Check aria-label
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  // Check aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const labels = ids
      .map((id) => doc.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (labels.length > 0) return labels.join(" ");
  }

  // Check for associated label (for native inputs)
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }

  // Check for wrapping label
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent?.trim()) {
    // Remove the input's own text content from label text
    const labelText = parentLabel.textContent.trim();
    const inputText = el.textContent?.trim() || "";
    const cleanLabel = labelText.replace(inputText, "").trim();
    if (cleanLabel) return cleanLabel;
  }

  // Check title attribute
  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  // Check placeholder (last resort, not recommended)
  const placeholder = el.getAttribute("placeholder")?.trim();
  if (placeholder) return placeholder;

  return null;
}

export const ariaInputFieldNameRule: Rule = {
  meta: {
    id: "a11y/aria-input-field-name",
    name: "ARIA Input Field Name",
    description: "Checks that input fields have accessible names",
    solution:
      "All input fields need accessible names. Best options: 1) Use <label for='inputId'>. 2) Use aria-label or aria-labelledby. 3) Wrap input in <label>. Placeholder alone is not sufficient as it disappears when typing.",
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

    // Check elements with input roles
    for (const role of inputRoles) {
      const elements = doc.querySelectorAll(`[role="${role}"]`);
      for (const el of elements) {
        if (!getAccessibleName(el, doc)) {
          const tagName = el.tagName.toLowerCase();
          missingNames.push(`${tagName}[role="${role}"]`);
        }
      }
    }

    // Check native inputs
    const inputs = doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])'
    );
    for (const input of inputs) {
      if (input.hasAttribute("role")) continue; // Covered by role check
      if (!getAccessibleName(input, doc)) {
        const type = input.getAttribute("type") || "text";
        const name = input.getAttribute("name") || "";
        missingNames.push(
          name ? `input[name="${name}"]` : `input[type="${type}"]`
        );
      }
    }

    // Check textareas
    const textareas = doc.querySelectorAll("textarea");
    for (const textarea of textareas) {
      if (textarea.hasAttribute("role")) continue;
      if (!getAccessibleName(textarea, doc)) {
        const name = textarea.getAttribute("name") || "";
        missingNames.push(name ? `textarea[name="${name}"]` : "textarea");
      }
    }

    // Check select elements
    const selects = doc.querySelectorAll("select");
    for (const select of selects) {
      if (select.hasAttribute("role")) continue;
      if (!getAccessibleName(select, doc)) {
        const name = select.getAttribute("name") || "";
        missingNames.push(name ? `select[name="${name}"]` : "select");
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-input-field-name",
        status: "fail",
        message: `${missingNames.length} input field(s) without accessible names`,
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details:
          missingNames.length > 10
            ? { additional: missingNames.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-input-field-name",
        status: "pass",
        message: "All input fields have accessible names",
      });
    }

    return { checks };
  },
};
