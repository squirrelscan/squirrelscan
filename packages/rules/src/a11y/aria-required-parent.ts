// a11y/aria-required-parent - Required parent for ARIA roles
// Based on WAI-ARIA 1.2 specification for required parent roles

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { requiredParentByRole } from "./aria-data";

/**
 * Get implicit ARIA role from HTML element
 * Based on WAI-ARIA 1.2 HTML mappings
 */
function getImplicitRole(tagName: string, element: Element): string | null {
  const implicitRoles: Record<string, string> = {
    // Structure
    article: "article",
    aside: "complementary",
    footer: "contentinfo",
    header: "banner",
    main: "main",
    nav: "navigation",
    section: "region",
    // Lists
    ul: "list",
    ol: "list",
    li: "listitem",
    dl: "list",
    dt: "term",
    dd: "definition",
    // Tables
    table: "table",
    tr: "row",
    thead: "rowgroup",
    tbody: "rowgroup",
    tfoot: "rowgroup",
    th: "columnheader",
    td: "cell",
    // Forms
    form: "form",
    select: "listbox",
    option: "option",
    optgroup: "group",
    datalist: "listbox",
    // Interactive
    button: "button",
    a: "link",
    details: "group",
    summary: "button",
    dialog: "dialog",
    menu: "menu",
    // Text
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    hr: "separator",
    img: "img",
    figure: "figure",
    figcaption: "caption",
    // Output
    output: "status",
    progress: "progressbar",
    meter: "meter",
  };

  // Check for <a> with href (link role) vs without (generic)
  if (tagName === "a") {
    return element.hasAttribute("href") ? "link" : null;
  }

  // Check for <input> type variations
  if (tagName === "input") {
    const type = element.getAttribute("type")?.toLowerCase() || "text";
    const inputRoles: Record<string, string> = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      button: "button",
      submit: "button",
      reset: "button",
      image: "button",
      search: "searchbox",
      email: "textbox",
      tel: "textbox",
      text: "textbox",
      url: "textbox",
      number: "spinbutton",
    };
    return inputRoles[type] || "textbox";
  }

  // Check for <select> with multiple
  if (tagName === "select") {
    return "listbox";
  }

  return implicitRoles[tagName] || null;
}

/**
 * Get the effective role of an element (explicit role or implicit from tag)
 */
function getEffectiveRole(element: Element): string | null {
  // Explicit role takes precedence
  const explicitRole = element.getAttribute("role")?.toLowerCase();
  if (explicitRole) {
    return explicitRole;
  }

  // Fall back to implicit role
  const tagName = element.tagName.toLowerCase();
  return getImplicitRole(tagName, element);
}

/**
 * Check if a parent has one of the required roles
 */
function hasRequiredParent(element: Element, requiredRoles: string[]): boolean {
  let parent = element.parentElement;

  while (parent) {
    const parentRole = getEffectiveRole(parent);

    if (parentRole && requiredRoles.includes(parentRole)) {
      return true;
    }

    parent = parent.parentElement;
  }

  return false;
}

export const ariaRequiredParentRule: Rule = {
  meta: {
    id: "a11y/aria-required-parent",
    name: "ARIA Required Parent",
    description:
      "Checks that elements with certain roles have required parent roles",
    solution:
      "Some ARIA roles must be contained within specific parent roles. For example, role='listitem' must be within role='list', role='option' must be within role='listbox'. Restructure your markup to ensure proper parent-child relationships.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const missingParent: string[] = [];

    // Check elements with explicit roles
    for (const [childRole, parentRoles] of Object.entries(
      requiredParentByRole
    )) {
      const elements = doc.querySelectorAll(`[role="${childRole}"]`);

      for (const el of elements) {
        if (!hasRequiredParent(el, parentRoles)) {
          const tagName = el.tagName.toLowerCase();
          missingParent.push(
            `${tagName}[role="${childRole}"]: needs parent with role=${parentRoles.join("|")}`
          );
        }
      }
    }

    // Also check elements with implicit roles that require parents
    // For example, <li> elements outside of <ul>/<ol>
    const implicitRoleChecks: Array<{
      selector: string;
      role: string;
      parentRoles: string[];
    }> = [
      { selector: "li", role: "listitem", parentRoles: ["list", "group"] },
      {
        selector: "option",
        role: "option",
        parentRoles: ["listbox", "group"],
      },
      {
        selector: "tr",
        role: "row",
        parentRoles: ["grid", "rowgroup", "table", "treegrid"],
      },
      { selector: "td", role: "cell", parentRoles: ["row"] },
      { selector: "th", role: "columnheader", parentRoles: ["row"] },
      {
        selector: "thead, tbody, tfoot",
        role: "rowgroup",
        parentRoles: ["grid", "table", "treegrid"],
      },
    ];

    for (const check of implicitRoleChecks) {
      const elements = doc.querySelectorAll(check.selector);

      for (const el of elements) {
        // Skip if element has an explicit role (already checked above)
        if (el.hasAttribute("role")) continue;

        if (!hasRequiredParent(el, check.parentRoles)) {
          const tagName = el.tagName.toLowerCase();
          // This is typically valid HTML but invalid ARIA semantics
          // Only flag if it seems like an actual misuse
          // e.g., <article role="listitem"> would be caught, but plain <li> outside list is a different issue
          missingParent.push(
            `${tagName} (implicit role="${check.role}"): needs parent with role=${check.parentRoles.join("|")}`
          );
        }
      }
    }

    if (missingParent.length > 0) {
      checks.push({
        name: "aria-required-parent",
        status: "fail",
        message: `${missingParent.length} element(s) missing required parent role`,
        items: missingParent.slice(0, 10).map((id) => ({ id })),
        details:
          missingParent.length > 10
            ? { additional: missingParent.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-required-parent",
        status: "pass",
        message: "All elements have required parent roles",
      });
    }

    return { checks };
  },
};
