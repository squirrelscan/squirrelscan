// a11y/aria-required-attr - Required ARIA attributes present

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { requiredAttributesByRole } from "./aria-data";

export const ariaRequiredAttrRule: Rule = {
  meta: {
    id: "a11y/aria-required-attr",
    name: "ARIA Required Attributes",
    description:
      "Checks that elements have required ARIA attributes for their roles",
    solution:
      "Some ARIA roles require specific attributes to be present. For example, role='checkbox' requires aria-checked, role='slider' requires aria-valuenow. Add the missing required attributes with appropriate values.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const elementsWithRole = doc.querySelectorAll("[role]");
    const missingAttrs: string[] = [];

    for (const el of elementsWithRole) {
      const role = el.getAttribute("role")?.trim().toLowerCase();
      if (!role) continue;

      // Get first role (in case of fallback chain)
      const primaryRole = role.split(/\s+/)[0];
      const required = requiredAttributesByRole[primaryRole];

      if (required && required.length > 0) {
        const missing: string[] = [];

        for (const attr of required) {
          if (!el.hasAttribute(attr)) {
            missing.push(attr);
          }
        }

        if (missing.length > 0) {
          const tagName = el.tagName.toLowerCase();
          missingAttrs.push(
            `${tagName}[role="${primaryRole}"]: missing ${missing.join(", ")}`
          );
        }
      }
    }

    if (missingAttrs.length > 0) {
      checks.push({
        name: "aria-required-attr",
        status: "fail",
        message: `${missingAttrs.length} element(s) missing required ARIA attributes`,
        items: missingAttrs.slice(0, 10).map((id) => ({ id })),
        details:
          missingAttrs.length > 10
            ? { additional: missingAttrs.length - 10 }
            : undefined,
      });
    } else if (elementsWithRole.length > 0) {
      checks.push({
        name: "aria-required-attr",
        status: "pass",
        message: "All elements have required ARIA attributes",
      });
    } else {
      checks.push({
        name: "aria-required-attr",
        status: "info",
        message: "No elements with ARIA roles found",
      });
    }

    return { checks };
  },
};
