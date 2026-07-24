// a11y/aria-required-children - Required children for ARIA roles

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { requiredChildrenByRole } from "./aria-data";

export const ariaRequiredChildrenRule: Rule = {
  meta: {
    id: "a11y/aria-required-children",
    name: "ARIA Required Children",
    description:
      "Checks that elements with certain roles have required child roles",
    solution:
      "Some ARIA roles require specific child roles. For example, role='list' must contain role='listitem', role='menu' must contain menu items. Add the required child elements with appropriate roles.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const missingChildren: string[] = [];

    for (const [parentRole, childRoles] of Object.entries(
      requiredChildrenByRole
    )) {
      const elements = doc.querySelectorAll(`[role="${parentRole}"]`);

      for (const el of elements) {
        // Check if any child (at any depth) has one of the required roles
        let hasValidChild = false;

        // Check explicit roles
        for (const childRole of childRoles) {
          if (el.querySelector(`[role="${childRole}"]`)) {
            hasValidChild = true;
            break;
          }
        }

        // Check implicit roles from elements if not found
        if (!hasValidChild) {
          const tagName = el.tagName.toLowerCase();

          // Native semantic elements satisfy role requirements
          if (
            (childRoles.includes("listitem") && el.querySelector("li")) ||
            (childRoles.includes("row") && el.querySelector("tr")) ||
            (childRoles.includes("cell") && el.querySelector("td, th")) ||
            (childRoles.includes("option") && el.querySelector("option")) ||
            (childRoles.includes("article") && el.querySelector("article"))
          ) {
            hasValidChild = true;
          }

          // Check if the element itself is the implicit role
          // (e.g., ul has implicit role=list and li children have implicit role=listitem)
          if (
            (parentRole === "list" &&
              (tagName === "ul" || tagName === "ol") &&
              el.querySelector("li")) ||
            (parentRole === "table" &&
              tagName === "table" &&
              el.querySelector("tr")) ||
            (parentRole === "listbox" &&
              tagName === "select" &&
              el.querySelector("option"))
          ) {
            hasValidChild = true;
          }
        }

        // Skip if element is empty (might be dynamically populated)
        const hasContent = el.children.length > 0 || el.textContent?.trim();
        if (!hasValidChild && hasContent) {
          const tagName = el.tagName.toLowerCase();
          missingChildren.push(
            `${tagName}[role="${parentRole}"]: needs child with role=${childRoles.join("|")}`
          );
        }
      }
    }

    if (missingChildren.length > 0) {
      checks.push({
        name: "aria-required-children",
        status: "fail",
        message: `${missingChildren.length} element(s) missing required child roles`,
        items: missingChildren.slice(0, 10).map((id) => ({ id })),
        details:
          missingChildren.length > 10
            ? { additional: missingChildren.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-required-children",
        status: "pass",
        message: "All elements have required child roles",
      });
    }

    return { checks };
  },
};
