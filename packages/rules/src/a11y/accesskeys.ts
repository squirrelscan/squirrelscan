// a11y/accesskeys - Access keys are unique

import { wcag } from "@squirrelscan/core-contracts/wcag";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI, querySelectorAllByAttrCI } from "@squirrelscan/utils";

export const accesskeysRule: Rule = {
  meta: {
    id: "a11y/accesskeys",
    name: "Access Keys",
    description: "Checks that accesskey values are unique",
    solution:
      "Access keys provide keyboard shortcuts for elements. Duplicate access keys cause only one to work, confusing users. Ensure each accesskey value is unique. Consider whether access keys are necessary at all, as they can conflict with browser/OS shortcuts.",
    category: "a11y",
    wcagNone:
      "It flags two elements that share an accesskey value, which no WCAG success criterion forbids; 2.1.4 Character Key Shortcuts covers single-key shortcuts with no modifier, and an access key always has one.",
    wcagRelated: [wcag("2.1.1"), wcag("2.1.4")],
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const elementsWithAccesskey = querySelectorAllByAttrCI(
      doc,
      "*",
      "accesskey"
    );
    const accesskeyMap = new Map<string, string[]>();

    for (const el of elementsWithAccesskey) {
      const key = getAttrCI(el, "accesskey")?.toLowerCase();
      if (!key) continue;

      const tagName = el.tagName.toLowerCase();
      const id = el.getAttribute("id");
      const identifier = id ? `${tagName}#${id}` : tagName;

      if (!accesskeyMap.has(key)) {
        accesskeyMap.set(key, []);
      }
      accesskeyMap.get(key)?.push(identifier);
    }

    const duplicates: string[] = [];
    for (const [key, elements] of accesskeyMap) {
      if (elements.length > 1) {
        duplicates.push(`accesskey="${key}" used by: ${elements.join(", ")}`);
      }
    }

    if (duplicates.length > 0) {
      checks.push({
        name: "accesskeys-unique",
        status: "warn",
        message: `${duplicates.length} duplicate access key(s) found`,
        items: duplicates.map((id) => ({ id })),
      });
    } else if (elementsWithAccesskey.length > 0) {
      checks.push({
        name: "accesskeys",
        status: "pass",
        message: `${elementsWithAccesskey.length} access key(s) are unique`,
      });
    } else {
      checks.push({
        name: "accesskeys",
        status: "info",
        message: "No access keys defined",
      });
    }

    return { checks };
  },
};
