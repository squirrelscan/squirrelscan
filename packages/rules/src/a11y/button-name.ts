// a11y/button-name - Buttons have accessible names

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { createStaticVisibility, UNCONFIRMED_LABEL } from "../shared/static-hidden";

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
      "Buttons must have accessible names. Options: 1) Add text content inside the button. 2) Use aria-label for icon buttons. 3) Use aria-labelledby to reference visible text. 4) Use title attribute (less preferred). For <input type='button'>, use the value attribute. A button hidden by the hidden attribute, an aria-hidden ancestor, a closed dialog or an inline style='display:none' or 'visibility:hidden' is out of the accessibility tree and is not reported, but it needs a name if it is shown later. squirrel does not read <style> blocks or stylesheets, so a button hidden only by a class or selector rule is still reported, and one whose inline style it cannot read exactly is reported as unconfirmed.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
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
    // Unnamed, and an inline style the check cannot read exactly may hide
    // them (pub#665): reported as candidates, not as failures.
    const unconfirmed: CheckItem[] = [];
    // Unnamed but out of the accessibility tree, where the rule does not apply
    // (W3C ACT 97a4e1). They need a name if they are shown later.
    let hiddenWithoutName = 0;
    const visibility = createStaticVisibility({ ariaHidden: true });

    /** Files an unnamed button under the finding it belongs to. */
    const classify = (el: Element, label: string): void => {
      const seen = visibility.visibility(el);
      if (seen.state === "hidden") hiddenWithoutName++;
      else if (seen.state === "unknown") {
        unconfirmed.push({ id: label, label: UNCONFIRMED_LABEL });
      } else missingNames.push(label);
    };

    for (const btn of buttons) {
      if (!hasAccessibleName(btn)) {
        const tagName = btn.tagName.toLowerCase();
        const id = btn.getAttribute("id");
        const cls = btn.getAttribute("class")?.split(" ")[0];
        classify(btn, id ? `${tagName}#${id}` : cls ? `${tagName}.${cls}` : tagName);
      }
    }

    for (const input of inputButtons) {
      if (!hasAccessibleName(input)) {
        const type = input.getAttribute("type");
        const name = input.getAttribute("name");
        classify(input, name ? `input[name="${name}"]` : `input[type="${type}"]`);
      }
    }

    const buttonsChecked = buttons.length + inputButtons.length;

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
    }

    if (unconfirmed.length > 0) {
      checks.push({
        name: "button-name-unconfirmed",
        status: "warn",
        message: `${unconfirmed.length} button(s) without accessible names may be hidden by a style (unconfirmed)`,
        items: unconfirmed.slice(0, 10),
        details:
          unconfirmed.length > 10
            ? { additional: unconfirmed.length - 10 }
            : undefined,
      });
    }

    if (missingNames.length === 0 && unconfirmed.length === 0) {
      if (buttonsChecked > 0) {
        checks.push({
          name: "button-name",
          status: "pass",
          message:
            hiddenWithoutName > 0
              ? "All buttons in the accessibility tree have accessible names"
              : "All buttons have accessible names",
          details:
            hiddenWithoutName > 0
              ? { buttonsChecked, hiddenWithoutName }
              : { buttonsChecked },
        });
      } else {
        checks.push({
          name: "button-name",
          status: "info",
          message: "No buttons found",
        });
      }
    }

    return { checks };
  },
};
