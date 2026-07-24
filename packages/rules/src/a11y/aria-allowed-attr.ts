// a11y/aria-allowed-attr - Check for allowed ARIA attributes on elements

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { globalAriaAttributes, validAriaAttributes } from "./aria-data";

// Map of roles to disallowed attributes
const disallowedAttrsByRole: Record<string, string[]> = {
  presentation: [
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    // presentation/none should not have semantic ARIA
  ],
  none: ["aria-label", "aria-labelledby", "aria-describedby"],
};

// Elements where certain ARIA attributes conflict with native semantics
const conflictingAttrs: Record<string, string[]> = {
  // Images with empty alt should not have aria-label (contradicts decorative intent)
  img_decorative: ["aria-label", "aria-labelledby"],
};

export const ariaAllowedAttrRule: Rule = {
  meta: {
    id: "a11y/aria-allowed-attr",
    name: "ARIA Allowed Attributes",
    description: "Checks that ARIA attributes are allowed on their elements",
    solution:
      "Some ARIA attributes are not appropriate for certain roles or elements. For example, role='presentation' should not have aria-label since it removes semantic meaning. Remove conflicting attributes or reconsider the element's role.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const issues: string[] = [];

    // Check all elements with ARIA attributes
    const allElements = doc.querySelectorAll("*");

    for (const el of allElements) {
      const attrs = el.attributes;
      if (!attrs) continue;

      const role = el.getAttribute("role")?.toLowerCase();
      const tagName = el.tagName.toLowerCase();

      // Collect ARIA attributes on this element
      const ariaAttrs: string[] = [];
      for (const attr of Array.from(attrs)) {
        if (attr.name.startsWith("aria-")) {
          ariaAttrs.push(attr.name.toLowerCase());
        }
      }

      if (ariaAttrs.length === 0) continue;

      // Check role-specific disallowed attributes
      if (role && disallowedAttrsByRole[role]) {
        const disallowed = disallowedAttrsByRole[role];
        for (const attr of ariaAttrs) {
          if (disallowed.includes(attr)) {
            issues.push(`${tagName}[role="${role}"]: ${attr} not allowed`);
          }
        }
      }

      // Check decorative images (empty alt)
      if (tagName === "img") {
        const alt = el.getAttribute("alt");
        if (alt === "") {
          // Decorative image
          for (const attr of ariaAttrs) {
            if (conflictingAttrs.img_decorative.includes(attr)) {
              issues.push(
                `img[alt=""]: ${attr} conflicts with decorative intent`
              );
            }
          }
        }
      }

      // Check for aria attributes not in the valid set (covered by aria-valid-attr but included for completeness)
      for (const attr of ariaAttrs) {
        if (!validAriaAttributes.has(attr) && !globalAriaAttributes.has(attr)) {
          // Skip - this is caught by aria-valid-attr rule
        }
      }
    }

    if (issues.length > 0) {
      checks.push({
        name: "aria-allowed-attr",
        status: "warn",
        message: `${issues.length} element(s) with inappropriate ARIA attributes`,
        items: issues.slice(0, 10).map((id) => ({ id })),
        details:
          issues.length > 10 ? { additional: issues.length - 10 } : undefined,
      });
    } else {
      checks.push({
        name: "aria-allowed-attr",
        status: "pass",
        message: "All ARIA attributes are appropriate for their elements",
      });
    }

    return { checks };
  },
};
