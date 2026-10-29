// a11y/aria-toggle-field-name - Toggle fields have accessible names

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { elementsWithAttribute, labelsFor } from "../shared/attribute-lookup";

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
    const label = labelsFor(doc, id)[0] ?? null;
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
      "Toggle fields need accessible names to describe what they control. Use <label for='id'>, aria-label, aria-labelledby, or wrap in <label>. Example: <label><input type='checkbox'> Subscribe to newsletter</label> An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. A toggle field carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // pub#993: out of the accessibility tree is skipped, a style that may hide
    // it is unconfirmed, like button-name.
    const unnamed = sortUnnamedControls<string>();

    // Check elements with toggle roles
    const toggleRoles = ["checkbox", "radio", "switch"];
    for (const role of toggleRoles) {
      const elements = elementsWithAttribute(doc, "role", role);
      for (const el of elements) {
        if (!hasAccessibleName(el, doc)) {
          const tagName = el.tagName.toLowerCase();
          unnamed.add(el, `${tagName}[role="${role}"]`);
        }
      }
    }

    // Check native checkboxes
    const checkboxes = doc.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      if (checkbox.hasAttribute("role")) continue;
      if (!hasAccessibleName(checkbox, doc)) {
        const name = checkbox.getAttribute("name") || "";
        unnamed.add(checkbox, name ? `checkbox[name="${name}"]` : "checkbox");
      }
    }

    // Check native radio buttons
    const radios = doc.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      if (radio.hasAttribute("role")) continue;
      if (!hasAccessibleName(radio, doc)) {
        const name = radio.getAttribute("name") || "";
        const value = radio.getAttribute("value") || "";
        unnamed.add(
          radio,
          name
            ? `radio[name="${name}"]${value ? `[value="${value}"]` : ""}`
            : "radio"
        );
      }
    }

    const missingNames = unnamed.failures;

    if (missingNames.length > 0) {
      checks.push({
        name: "aria-toggle-field-name",
        status: "fail",
        message: `${missingNames.length} toggle field(s) without accessible names`,
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details: missingNames.length > 10 ? { additional: missingNames.length - 10 } : undefined,
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow("aria-toggle-field-name", "toggle field(s) without accessible names", unnamed.unconfirmed),
      );
    }
    if (missingNames.length === 0 && unnamed.unconfirmed.length === 0) {
      checks.push({
        name: "aria-toggle-field-name",
        status: "pass",
        message:
          unnamed.hidden > 0
            ? "All toggle fields in the accessibility tree have accessible names"
            : "All toggle fields have accessible names",
        ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
      });
    }

    return { checks };
  },
};
