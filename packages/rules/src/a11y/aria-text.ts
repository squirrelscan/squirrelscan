// a11y/aria-text - Elements with role="text" have no focusable descendants

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI } from "@squirrelscan/utils";

const NATIVE_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
].join(", ");

function isFocusable(el: Element): boolean {
  if (el.matches(NATIVE_FOCUSABLE_SELECTOR)) return true;
  const tabindex = getAttrCI(el, "tabindex");
  return tabindex !== null && tabindex !== "-1";
}

export const ariaTextRule: Rule = {
  meta: {
    id: "a11y/aria-text",
    name: "ARIA Text",
    description:
      "Checks that elements with role='text' have no focusable descendants",
    solution:
      "Elements with role='text' tell screen readers to treat the content as a single text string. If focusable elements (links, buttons, inputs) are nested inside, screen reader users cannot interact with them properly. Remove role='text' from the parent, or restructure so focusable elements are outside the role='text' container.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const textElements = doc.querySelectorAll('[role="text"]');

    if (textElements.length === 0) {
      checks.push({
        name: "aria-text",
        status: "info",
        message: 'No elements with role="text" found',
      });
      return { checks };
    }

    const violations: string[] = [];

    for (const el of textElements) {
      const focusable = Array.from(el.querySelectorAll("*")).filter(
        isFocusable
      );
      if (focusable.length > 0) {
        const id = el.getAttribute("id");
        const tag = el.tagName.toLowerCase();
        violations.push(
          id
            ? `${tag}#${id} (${focusable.length} focusable)`
            : `${tag} (${focusable.length} focusable)`
        );
      }
    }

    if (violations.length > 0) {
      checks.push({
        name: "aria-text",
        status: "warn",
        message: `${violations.length} role="text" element(s) with focusable descendants`,
        items: violations.slice(0, 10).map((id) => ({ id })),
        details:
          violations.length > 10
            ? { additional: violations.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-text",
        status: "pass",
        message: `All ${textElements.length} role="text" element(s) have no focusable descendants`,
        details: { elementsChecked: textElements.length },
      });
    }

    return { checks };
  },
};
