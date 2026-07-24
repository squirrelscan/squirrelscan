// a11y/duplicate-id-active - No duplicate IDs on focusable elements

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI } from "@squirrelscan/utils";

const NATIVE_FOCUSABLE_WITH_ID_SELECTOR = [
  "a[href][id]",
  "button[id]",
  "input[id]",
  "select[id]",
  "textarea[id]",
].join(", ");

export const duplicateIdActiveRule: Rule = {
  meta: {
    id: "a11y/duplicate-id-active",
    name: "Duplicate ID Active",
    description: "Checks that active, focusable elements have unique IDs",
    solution:
      "Duplicate IDs on focusable elements (links, buttons, inputs) break keyboard navigation and label associations. Browsers only recognize the first element with a given ID, so labels, focus management, and ARIA references will target the wrong element. Ensure every focusable element with an id attribute has a unique value.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Native focusable with IDs + elements with tabindex (case-insensitive) and IDs
    const nativeFocusable = Array.from(
      doc.querySelectorAll(NATIVE_FOCUSABLE_WITH_ID_SELECTOR)
    );
    const allWithId = doc.querySelectorAll("[id]");
    const tabindexFocusable: Element[] = [];
    for (const el of allWithId) {
      const tabindex = getAttrCI(el, "tabindex");
      if (
        tabindex !== null &&
        tabindex !== "-1" &&
        !nativeFocusable.includes(el)
      ) {
        tabindexFocusable.push(el);
      }
    }
    const focusable = [...nativeFocusable, ...tabindexFocusable];

    if (focusable.length === 0) {
      checks.push({
        name: "duplicate-id-active",
        status: "info",
        message: "No focusable elements with IDs found",
      });
      return { checks };
    }

    // Build id → count map
    const idCounts = new Map<string, number>();
    for (const el of focusable) {
      const id = el.getAttribute("id");
      if (!id) continue;
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }

    const duplicates: string[] = [];
    for (const [id, count] of idCounts) {
      if (count > 1) {
        duplicates.push(`"${id}" (${count} occurrences)`);
      }
    }

    if (duplicates.length > 0) {
      checks.push({
        name: "duplicate-id-active",
        status: "fail",
        message: `${duplicates.length} duplicate ID(s) on focusable elements`,
        items: duplicates.slice(0, 10).map((id) => ({ id })),
        details:
          duplicates.length > 10
            ? { additional: duplicates.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "duplicate-id-active",
        status: "pass",
        message: "All focusable elements have unique IDs",
        details: { idsChecked: idCounts.size },
      });
    }

    return { checks };
  },
};
