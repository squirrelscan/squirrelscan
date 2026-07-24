// a11y/aria-hidden-body - Ensure body is not aria-hidden

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const ariaHiddenBodyRule: Rule = {
  meta: {
    id: "a11y/aria-hidden-body",
    name: "ARIA Hidden Body",
    description: "Ensures document body is not set to aria-hidden",
    solution:
      "Never set aria-hidden='true' on the <body> element. This makes the entire page invisible to assistive technology. If you need to hide content when a modal is open, add aria-hidden to sibling elements of the modal, not to body.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 10,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const body = doc.body;
    const html = doc.documentElement;

    let bodyHidden = false;
    let htmlHidden = false;

    if (body?.getAttribute("aria-hidden") === "true") {
      bodyHidden = true;
    }

    if (html?.getAttribute("aria-hidden") === "true") {
      htmlHidden = true;
    }

    if (bodyHidden || htmlHidden) {
      checks.push({
        name: "aria-hidden-body",
        status: "fail",
        message: htmlHidden
          ? "Document <html> element is aria-hidden"
          : "Document <body> is aria-hidden",
        details: {
          issue: "Page content is inaccessible to assistive technology",
          fix: "Remove aria-hidden from body/html element",
        },
      });
    } else {
      checks.push({
        name: "aria-hidden-body",
        status: "pass",
        message: "Document body is not hidden from assistive technology",
      });
    }

    return { checks };
  },
};
