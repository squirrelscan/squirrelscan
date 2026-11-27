// a11y/duplicate-id-aria - No duplicate IDs used in ARIA

import { wcag } from "@squirrelscan/core-contracts/wcag";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const duplicateIdAriaRule: Rule = {
  meta: {
    id: "a11y/duplicate-id-aria",
    name: "Duplicate ID ARIA",
    description: "Checks that IDs used in ARIA attributes are unique",
    solution:
      'IDs referenced by ARIA attributes (aria-labelledby, aria-describedby, aria-controls, etc.) must be unique on the page. Duplicate IDs cause assistive technology to potentially reference the wrong element. Rename duplicate IDs to be unique. A reference to an id that does not exist is reported separately; aria-controls/aria-owns on a collapsed disclosure (aria-expanded="false") or an aria-haspopup trigger is ignored, since its panel may not be mounted yet.',
    category: "a11y",
    wcag: [wcag("4.1.2")],
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 8,
    // Check names by outcome class (#1741, #2218).
    checks: [
      { name: "duplicate-id-aria", outcome: "problem" },
      { name: "aria-missing-name-id", outcome: "problem" },
      { name: "aria-missing-id-ref", outcome: "problem" },
      {
        name: "duplicate-id-aria",
        outcome: "clean",
        clears: [
          "duplicate-id-aria",
          "aria-missing-name-id",
          "aria-missing-id-ref",
        ],
      },
    ],
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

    // aria-controls/aria-owns on a collapsed disclosure (aria-expanded="false")
    // or a popup trigger (aria-haspopup) point at a panel that is often not
    // mounted until it opens. axe's aria-valid-attr-value tolerates that, so
    // a missing target there is not a finding (#2224).
    const TOGGLE_ATTRS = new Set(["aria-controls", "aria-owns"]);
    // Missing targets of these break the accessible name or description, so
    // they stay errors. Other missing references are a lesser finding.
    const NAME_ATTRS = new Set(["aria-labelledby", "aria-describedby"]);

    const referencedIds = new Set<string>();
    const strictRefs = new Set<string>(); // id referenced where a missing target is an error
    const softRefs = new Set<string>(); // id referenced where a missing target is a warning
    for (const attr of ariaIdAttrs) {
      const elements = doc.querySelectorAll(`[${attr}]`);
      for (const el of elements) {
        const value = el.getAttribute(attr) || "";
        const ids = value.split(/\s+/).filter(Boolean);
        const tolerated =
          TOGGLE_ATTRS.has(attr) &&
          (el.getAttribute("aria-expanded")?.trim().toLowerCase() === "false" ||
            el.hasAttribute("aria-haspopup"));
        for (const id of ids) {
          referencedIds.add(id);
          if (tolerated) continue;
          (NAME_ATTRS.has(attr) ? strictRefs : softRefs).add(id);
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

    const duplicateIds: string[] = [];
    const missingNameIds: string[] = [];
    const missingOtherIds: string[] = [];
    for (const id of referencedIds) {
      const count = idCounts.get(id) ?? 0;
      if (count > 1) duplicateIds.push(`"${id}" (${count} occurrences)`);
      else if (count === 0) {
        if (strictRefs.has(id)) missingNameIds.push(`"${id}"`);
        else if (softRefs.has(id)) missingOtherIds.push(`"${id}"`);
      }
    }

    const emit = (
      name: string,
      status: "fail" | "warn",
      message: string,
      list: string[]
    ) => {
      checks.push({
        name,
        status,
        message,
        items: list.slice(0, 10).map((id) => ({ id })),
        details:
          list.length > 10 ? { additional: list.length - 10 } : undefined,
      });
    };

    if (duplicateIds.length > 0) {
      emit(
        "duplicate-id-aria",
        "fail",
        `${duplicateIds.length} duplicated ID(s) referenced by ARIA attributes`,
        duplicateIds
      );
    }
    if (missingNameIds.length > 0) {
      emit(
        "aria-missing-name-id",
        "fail",
        `ARIA reference to a missing id: ${missingNameIds.length} aria-labelledby/aria-describedby target(s) not found`,
        missingNameIds
      );
    }
    if (missingOtherIds.length > 0) {
      emit(
        "aria-missing-id-ref",
        "warn",
        `ARIA reference to a missing id: ${missingOtherIds.length} target(s) not found`,
        missingOtherIds
      );
    }
    if (checks.length === 0) {
      if (referencedIds.size > 0) {
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
    }

    return { checks };
  },
};
