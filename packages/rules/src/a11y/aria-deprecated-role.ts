// a11y/aria-deprecated-role - No deprecated ARIA roles

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Deprecated or discouraged roles
const deprecatedRoles: Record<string, string> = {
  // Deprecated in ARIA 1.2
  directory: "Use 'list' instead",

  // Abstract roles (should never be used)
  command: "Abstract role - use specific roles like button, link, or menuitem",
  composite: "Abstract role - use specific composite widgets",
  input: "Abstract role - use specific input types",
  landmark: "Abstract role - use specific landmarks",
  range: "Abstract role - use slider, spinbutton, meter, or progressbar",
  roletype: "Abstract role - never use directly",
  section: "Abstract role - use specific section types",
  sectionhead: "Abstract role - use heading or specific section heads",
  select: "Abstract role - use listbox, menu, or other specific select widgets",
  structure: "Abstract role - use specific structural roles",
  widget: "Abstract role - use specific widget types",
  window: "Abstract role - use dialog or alertdialog",
};

export const ariaDeprecatedRoleRule: Rule = {
  meta: {
    id: "a11y/aria-deprecated-role",
    name: "Deprecated ARIA Roles",
    description: "Checks for deprecated or abstract ARIA roles",
    solution:
      "Avoid deprecated or abstract ARIA roles. Use the recommended alternatives. Abstract roles are never meant to be used directly - they're base types that other roles extend. Replace with specific, concrete roles.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const elementsWithRole = doc.querySelectorAll("[role]");
    const issues: string[] = [];

    for (const el of elementsWithRole) {
      const roleAttr = el.getAttribute("role")?.trim().toLowerCase();
      if (!roleAttr) continue;

      const roles = roleAttr.split(/\s+/);

      for (const role of roles) {
        if (deprecatedRoles[role]) {
          const tagName = el.tagName.toLowerCase();
          issues.push(`${tagName}[role="${role}"]: ${deprecatedRoles[role]}`);
        }
      }
    }

    if (issues.length > 0) {
      checks.push({
        name: "aria-deprecated-role",
        status: "fail",
        message: `${issues.length} deprecated/abstract role(s) found`,
        items: issues.slice(0, 10).map((id) => ({ id })),
        details:
          issues.length > 10 ? { additional: issues.length - 10 } : undefined,
      });
    } else if (elementsWithRole.length > 0) {
      checks.push({
        name: "aria-deprecated-role",
        status: "pass",
        message: "No deprecated ARIA roles found",
      });
    } else {
      checks.push({
        name: "aria-deprecated-role",
        status: "info",
        message: "No ARIA roles found",
      });
    }

    return { checks };
  },
};
