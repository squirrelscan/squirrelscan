// security/form-https - Form actions use HTTPS

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const formHttpsRule: Rule = {
  meta: {
    id: "security/form-https",
    name: "Form HTTPS",
    description: "Checks that form actions use HTTPS",
    solution:
      "Forms should always submit to HTTPS URLs to protect user data in transit. Update form action attributes from http:// to https://. For relative URLs, ensure the page itself is on HTTPS. Be especially careful with login forms, payment forms, and any forms collecting personal data. Browsers may warn users about insecure form submissions.",
    category: "security",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const forms = doc.querySelectorAll("form[action]");
    const insecureFormActions: string[] = [];

    for (const form of forms) {
      const action = form.getAttribute("action");
      if (action && action.startsWith("http://")) {
        insecureFormActions.push(action);
      }
    }

    if (insecureFormActions.length > 0) {
      checks.push({
        name: "form-https",
        status: "warn",
        message: `${insecureFormActions.length} form(s) submit to HTTP`,
        items: insecureFormActions.map((url) => ({ id: url })),
      });
    } else if (forms.length > 0) {
      checks.push({
        name: "form-https",
        status: "pass",
        message: "All forms use secure submission",
        details: { formsChecked: forms.length },
      });
    } else {
      checks.push({
        name: "form-https",
        status: "info",
        message: "No forms detected",
      });
    }

    return { checks };
  },
};
