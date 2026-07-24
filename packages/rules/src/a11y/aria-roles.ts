// a11y/aria-roles - Valid ARIA role values

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { validAriaRoles } from "./aria-data";

export const ariaRolesRule: Rule = {
  meta: {
    id: "a11y/aria-roles",
    name: "ARIA Valid Roles",
    description: "Checks for valid ARIA role values",
    solution:
      "Use only valid ARIA role values as defined in the WAI-ARIA specification. Common mistakes include using made-up roles or misspelling valid roles. Roles are case-sensitive and must be lowercase. Multiple roles can be specified, separated by spaces, but the first valid role is used.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const elementsWithRole = doc.querySelectorAll("[role]");
    const invalidRoles: string[] = [];

    for (const el of elementsWithRole) {
      const roleAttr = el.getAttribute("role") || "";
      // Role can contain multiple values (fallback chain)
      const roles = roleAttr.trim().split(/\s+/);

      for (const role of roles) {
        if (role && !validAriaRoles.has(role.toLowerCase())) {
          const tagName = el.tagName.toLowerCase();
          invalidRoles.push(`${tagName}: role="${role}"`);
        }
      }
    }

    if (invalidRoles.length > 0) {
      checks.push({
        name: "aria-roles",
        status: "fail",
        message: `${invalidRoles.length} invalid ARIA role(s) found`,
        items: invalidRoles.slice(0, 10).map((id) => ({ id })),
        details:
          invalidRoles.length > 10
            ? { additional: invalidRoles.length - 10 }
            : undefined,
      });
    } else if (elementsWithRole.length > 0) {
      checks.push({
        name: "aria-roles",
        status: "pass",
        message: `${elementsWithRole.length} element(s) with valid ARIA roles`,
      });
    } else {
      checks.push({
        name: "aria-roles",
        status: "info",
        message: "No ARIA roles found",
      });
    }

    return { checks };
  },
};
