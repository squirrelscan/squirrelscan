// a11y/duplicate-id-aria - No duplicate IDs used in ARIA

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const duplicateIdAriaRule: Rule = {
  meta: {
    id: "a11y/duplicate-id-aria",
    name: "Duplicate ID ARIA",
    description: "Checks that IDs used in ARIA attributes are unique",
    solution:
      "IDs referenced by ARIA attributes (aria-labelledby, aria-describedby, aria-controls, etc.) must be unique on the page. Duplicate IDs cause assistive technology to potentially reference the wrong element. Rename duplicate IDs to be unique.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // ARIA attributes that reference IDs
    const ariaIdAttrs = [
      "aria-labelledby",
      "aria-describedby",
      "aria-controls",
      "aria-owns",
      "aria-activedescendant",
      "aria-flowto",
      "aria-details",
      "aria-errormessage",
    ];

    // Collect all IDs referenced by ARIA
    const referencedIds = new Set<string>();
    for (const attr of ariaIdAttrs) {
      const elements = doc.querySelectorAll(`[${attr}]`);
      for (const el of elements) {
        const value = el.getAttribute(attr) || "";
        const ids = value.split(/\s+/).filter(Boolean);
        for (const id of ids) {
          referencedIds.add(id);
        }
      }
    }

    // Count every id on the page in one pass. Interpolating ids into
    // attribute selectors needs CSS.escape, which doesn't exist in the
    // compiled-binary runtime ("Rule error: CSS is not defined") and breaks
    // on ids containing quotes/brackets either way.
    const idCounts = new Map<string, number>();
    for (const el of doc.querySelectorAll("[id]")) {
      const id = el.getAttribute("id");
      if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }

    // Check for duplicates among referenced IDs
    const duplicateIds: string[] = [];
    for (const id of referencedIds) {
      const count = idCounts.get(id) ?? 0;
      if (count > 1) {
        duplicateIds.push(`"${id}" (${count} occurrences)`);
      } else if (count === 0) {
        // Also flag IDs that don't exist
        duplicateIds.push(`"${id}" (not found)`);
      }
    }

    if (duplicateIds.length > 0) {
      checks.push({
        name: "duplicate-id-aria",
        status: "fail",
        message: `${duplicateIds.length} problematic ID(s) in ARIA attributes`,
        items: duplicateIds.slice(0, 10).map((id) => ({ id })),
        details:
          duplicateIds.length > 10
            ? { additional: duplicateIds.length - 10 }
            : undefined,
      });
    } else if (referencedIds.size > 0) {
      checks.push({
        name: "duplicate-id-aria",
        status: "pass",
        message: "All ARIA ID references are valid and unique",
        details: { idsChecked: referencedIds.size },
      });
    } else {
      checks.push({
        name: "duplicate-id-aria",
        status: "info",
        message: "No ARIA ID references found",
      });
    }

    return { checks };
  },
};
