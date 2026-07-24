// a11y/button-name - Buttons have accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function hasAccessibleName(el: Element): boolean {
  // Check aria-label
  if (el.getAttribute("aria-label")?.trim()) return true;

  // Check aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = el.ownerDocument;
    const ids = labelledBy.split(/\s+/);
    for (const id of ids) {
      const labelEl = doc?.getElementById(id);
      if (labelEl?.textContent?.trim()) return true;
    }
  }

  // Check title attribute
  if (el.getAttribute("title")?.trim()) return true;

  // Check text content
  if (el.textContent?.trim()) return true;

  // Check value attribute (for input[type=button])
  if (el.getAttribute("value")?.trim()) return true;

  // Check for nested img with alt
  const img = el.querySelector("img[alt]");
  if (img?.getAttribute("alt")?.trim()) return true;

  // Check for nested svg with title
  const svgTitle = el.querySelector("svg title");
  if (svgTitle?.textContent?.trim()) return true;

  // Check for nested aria-label in child
  const childWithLabel = el.querySelector("[aria-label]");
  if (childWithLabel?.getAttribute("aria-label")?.trim()) return true;

  return false;
}

export const buttonNameRule: Rule = {
  meta: {
    id: "a11y/button-name",
    name: "Button Name",
    description: "Checks that all buttons have accessible names",
    solution:
      "Buttons must have accessible names. Options: 1) Add text content inside the button. 2) Use aria-label for icon buttons. 3) Use aria-labelledby to reference visible text. 4) Use title attribute (less preferred). For <input type='button'>, use the value attribute.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const buttons = doc.querySelectorAll("button, [role='button']");
    const inputButtons = doc.querySelectorAll(
      'input[type="button"], input[type="submit"], input[type="reset"]'
    );

    const missingNames: string[] = [];

    for (const btn of buttons) {
      if (!hasAccessibleName(btn)) {
        const tagName = btn.tagName.toLowerCase();
        const id = btn.getAttribute("id");
        const cls = btn.getAttribute("class")?.split(" ")[0];
        missingNames.push(
          id ? `${tagName}#${id}` : cls ? `${tagName}.${cls}` : tagName
        );
      }
    }

    for (const input of inputButtons) {
      if (!hasAccessibleName(input)) {
        const type = input.getAttribute("type");
        const name = input.getAttribute("name");
        missingNames.push(
          name ? `input[name="${name}"]` : `input[type="${type}"]`
        );
      }
    }

    if (missingNames.length > 0) {
      checks.push({
        name: "button-name",
        status: "fail",
        message: "Buttons without accessible names",
        items: missingNames.slice(0, 10).map((id) => ({ id })),
        details:
          missingNames.length > 10
            ? { additional: missingNames.length - 10 }
            : undefined,
      });
    } else if (buttons.length + inputButtons.length > 0) {
      checks.push({
        name: "button-name",
        status: "pass",
        message: "All buttons have accessible names",
        details: { buttonsChecked: buttons.length + inputButtons.length },
      });
    } else {
      checks.push({
        name: "button-name",
        status: "info",
        message: "No buttons found",
      });
    }

    return { checks };
  },
};
