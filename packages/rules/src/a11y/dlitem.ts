// a11y/dlitem - dt/dd elements are in definition lists

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const dlitemRule: Rule = {
  meta: {
    id: "a11y/dlitem",
    name: "Definition List Item",
    description: "Checks that dt and dd elements are inside a dl",
    solution:
      "The <dt> and <dd> elements must be contained within a <dl> (definition list). Move orphaned dt/dd elements inside a <dl> container.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const dtElements = doc.querySelectorAll("dt");
    const ddElements = doc.querySelectorAll("dd");
    const orphaned: string[] = [];

    for (const dt of dtElements) {
      // Check if dt is inside a dl (can be directly or inside a div wrapper)
      const parent = dt.parentElement;
      const isInDl =
        parent?.tagName.toLowerCase() === "dl" ||
        (parent?.tagName.toLowerCase() === "div" &&
          parent?.parentElement?.tagName.toLowerCase() === "dl");

      if (!isInDl) {
        const text = dt.textContent?.trim().slice(0, 20);
        orphaned.push(`dt: "${text}${text && text.length >= 20 ? "..." : ""}"`);
      }
    }

    for (const dd of ddElements) {
      const parent = dd.parentElement;
      const isInDl =
        parent?.tagName.toLowerCase() === "dl" ||
        (parent?.tagName.toLowerCase() === "div" &&
          parent?.parentElement?.tagName.toLowerCase() === "dl");

      if (!isInDl) {
        const text = dd.textContent?.trim().slice(0, 20);
        orphaned.push(`dd: "${text}${text && text.length >= 20 ? "..." : ""}"`);
      }
    }

    if (orphaned.length > 0) {
      checks.push({
        name: "dlitem",
        status: "fail",
        message: `${orphaned.length} dt/dd element(s) not inside a dl`,
        items: orphaned.slice(0, 10).map((id) => ({ id })),
        details:
          orphaned.length > 10
            ? { additional: orphaned.length - 10 }
            : undefined,
      });
    } else if (dtElements.length + ddElements.length > 0) {
      checks.push({
        name: "dlitem",
        status: "pass",
        message: "All dt/dd elements are inside definition lists",
      });
    } else {
      checks.push({
        name: "dlitem",
        status: "info",
        message: "No dt/dd elements found",
      });
    }

    return { checks };
  },
};
