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

/**
 * The focusable descendants of each role="text" element, counted in one walk
 * of each outermost one's subtree (squirrelscan/repo#3066). A count is the
 * focusables seen between entering the element and leaving it, so a nested
 * role="text" is counted for itself and for every outer one without its
 * subtree being scanned again: a page that nested thousands of them made the
 * per-element `querySelectorAll("*")` quadratic (35 s at 5,000 levels).
 * An element's own focusability counts for its ancestors only, as
 * `querySelectorAll("*")` (descendants only) did.
 */
function focusableDescendantCounts(textElements: Iterable<Element>): Map<Element, number> {
  const isText = new Set(textElements);
  const counts = new Map<Element, number>();
  let focusables = 0;
  for (const root of isText) {
    // Already counted inside an outer role="text" element.
    if (counts.has(root)) continue;
    const entered = new Map<Element, number>();
    const stack: Array<{ el: Element; leaving: boolean }> = [{ el: root, leaving: false }];
    while (stack.length > 0) {
      const { el, leaving } = stack.pop()!;
      if (leaving) {
        counts.set(el, focusables - entered.get(el)!);
        continue;
      }
      if (isFocusable(el)) focusables++;
      // querySelectorAll never enters a template, so an outer element does
      // not count its content; a role="text" template counts its own.
      if (el.localName === "template") {
        if (isText.has(el)) {
          counts.set(el, Array.from(el.querySelectorAll("*")).filter(isFocusable).length);
        }
        continue;
      }
      if (isText.has(el)) {
        entered.set(el, focusables);
        stack.push({ el, leaving: true });
      }
      const children = el.children;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ el: children[i] as Element, leaving: false });
      }
    }
  }
  return counts;
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
    verdictScope: "page",
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
    const focusableCounts = focusableDescendantCounts(textElements);

    for (const el of textElements) {
      const focusable = focusableCounts.get(el) ?? 0;
      if (focusable > 0) {
        const id = el.getAttribute("id");
        const tag = el.tagName.toLowerCase();
        violations.push(
          id
            ? `${tag}#${id} (${focusable} focusable)`
            : `${tag} (${focusable} focusable)`
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
