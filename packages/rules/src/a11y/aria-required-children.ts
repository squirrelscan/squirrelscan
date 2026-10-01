// a11y/aria-required-children - Required children for ARIA roles

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isInsideNoscript, querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import { requiredChildrenByRole } from "./aria-data";
import { effectiveRole, explicitRole } from "./implicit-role";

/** Roles that only wrap the required items: `group` > treeitem, `rowgroup` > row. */
const WRAPPER_ROLES = new Set(["group", "rowgroup"]);

function hasRequiredRole(el: Element, required: Set<string>): boolean {
  const role = effectiveRole(el);
  if (role === null || !required.has(role)) return false;
  // A native wrapper (<fieldset>, <details>, <optgroup>, <tbody>) satisfies the
  // container only through the items inside it, which ownsRequiredChild
  // reaches anyway. An explicit role="group" still counts by itself, as it
  // always has.
  return !WRAPPER_ROLES.has(role) || explicitRole(el) === role;
}

/** The elements `el` claims through aria-owns, in id order. */
function ownedElements(el: Element, doc: Document): Element[] {
  const ids = (el.getAttribute("aria-owns") ?? "").trim().split(/\s+/).filter(Boolean);
  return ids.flatMap((id) => {
    const owned = doc.getElementById(id);
    return owned && !isInsideNoscript(owned) ? [owned] : [];
  });
}

/**
 * Whether `container` owns an element with one of the required roles: any
 * descendant at any depth, or anything an aria-owns inside it points at, and
 * so on through those elements' own descendants and aria-owns. <noscript>
 * content is inert text to a browser with scripting on, so it owns nothing
 * and is nothing (#434).
 */
function ownsRequiredChild(container: Element, doc: Document, required: Set<string>): boolean {
  const visited = new Set<Element>([container]);
  const roots: Element[] = [container];
  for (let next = roots.pop(); next; next = roots.pop()) {
    for (const el of [next, ...querySelectorAllOutsideNoscript(next, "*")]) {
      if (el !== container && hasRequiredRole(el, required)) return true;
      for (const owned of ownedElements(el, doc)) {
        if (visited.has(owned)) continue;
        visited.add(owned);
        roots.push(owned);
      }
    }
  }
  return false;
}

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
    verdictScope: "page",
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
      const required = new Set(childRoles);
      // <noscript> content is inert text to a browser with scripting on, so
      // it neither needs nor supplies children (#434).
      const elements = querySelectorAllOutsideNoscript(doc, `[role="${parentRole}"]`);

      for (const el of elements) {
        // The role is the explicit one or, failing that, the implicit role of
        // the native element, so an <input type="radio"> is a radio and a <tr>
        // a row (#435).
        const hasValidChild = ownsRequiredChild(el, doc, required);

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
