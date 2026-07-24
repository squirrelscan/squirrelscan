// a11y/td-headers-attr - Table cells reference valid headers

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const tdHeadersAttrRule: Rule = {
  meta: {
    id: "a11y/td-headers-attr",
    name: "Table Cell Headers",
    description: "Checks that td headers attribute references valid th ids",
    solution:
      "When using the headers attribute on <td> elements to associate cells with headers, ensure each id in the headers attribute matches an existing <th> element's id in the same table.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const tables = doc.querySelectorAll("table");
    const invalidReferences: string[] = [];

    for (const table of tables) {
      // Get all th ids in this table
      const thElements = table.querySelectorAll("th[id]");
      const validIds = new Set(
        Array.from(thElements).map((th) => th.getAttribute("id"))
      );

      // Check all td elements with headers attribute
      const tdWithHeaders = table.querySelectorAll("td[headers]");

      for (const td of tdWithHeaders) {
        const headers = td.getAttribute("headers") || "";
        const headerIds = headers.split(/\s+/).filter(Boolean);

        for (const headerId of headerIds) {
          if (!validIds.has(headerId)) {
            const cellContent = td.textContent?.trim().slice(0, 15) || "";
            invalidReferences.push(
              `td references non-existent header "${headerId}"${cellContent ? ` (content: "${cellContent}...")` : ""}`
            );
          }
        }
      }
    }

    const tdWithHeadersCount = doc.querySelectorAll("td[headers]").length;

    if (invalidReferences.length > 0) {
      checks.push({
        name: "td-headers-attr",
        status: "fail",
        message: `${invalidReferences.length} invalid header reference(s) in table cells`,
        items: invalidReferences.slice(0, 10).map((id) => ({ id })),
        details:
          invalidReferences.length > 10
            ? { additional: invalidReferences.length - 10 }
            : undefined,
      });
    } else if (tdWithHeadersCount > 0) {
      checks.push({
        name: "td-headers-attr",
        status: "pass",
        message: "All td headers attributes reference valid th ids",
        details: { cellsWithHeaders: tdWithHeadersCount },
      });
    } else if (tables.length > 0) {
      checks.push({
        name: "td-headers-attr",
        status: "info",
        message: "No td elements with headers attribute found",
      });
    } else {
      checks.push({
        name: "td-headers-attr",
        status: "info",
        message: "No tables found",
      });
    }

    return { checks };
  },
};
