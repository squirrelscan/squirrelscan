// a11y/td-headers-attr - Table cells reference valid headers

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { ownTableCells } from "../shared/own-table-cells";

export const tdHeadersAttrRule: Rule = {
  meta: {
    id: "a11y/td-headers-attr",
    name: "Table Cell Headers",
    description: "Checks that td headers attribute references valid th ids",
    solution:
      "When using the headers attribute on <td> elements to associate cells with headers, ensure each id in the headers attribute matches an existing <th> element's id in the same table.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const tables = doc.querySelectorAll("table");
    const invalidReferences: Array<{ td: Element; headerId: string }> = [];
    // squirrelscan/repo#3355: each table's own cells, so a cell is checked once,
    // against the header cells of its own table, as the HTML table model
    // resolves `headers`; the cells of a nested table are not the outer one's.
    const own = ownTableCells(doc);
    const isThWithId = new Set(doc.querySelectorAll("th[id]"));
    const isTdWithHeaders = new Set(doc.querySelectorAll("td[headers]"));

    for (const table of tables) {
      const cells = own.get(table)?.cells ?? [];
      // Get all th ids in this table
      const validIds = new Set(
        cells.filter((cell) => isThWithId.has(cell)).map((th) => th.getAttribute("id"))
      );

      // Check all td elements with headers attribute
      const tdWithHeaders = cells.filter((cell) => isTdWithHeaders.has(cell));

      for (const td of tdWithHeaders) {
        const headers = td.getAttribute("headers") || "";
        const headerIds = headers.split(/\s+/).filter(Boolean);

        for (const headerId of headerIds) {
          if (!validIds.has(headerId)) invalidReferences.push({ td, headerId });
        }
      }
    }

    const tdWithHeadersCount = isTdWithHeaders.size;

    if (invalidReferences.length > 0) {
      checks.push({
        name: "td-headers-attr",
        status: "fail",
        message: `${invalidReferences.length} invalid header reference(s) in table cells`,
        // Text read for the shown ten only: on nested tables a cell's text is
        // its whole subtree's.
        items: invalidReferences.slice(0, 10).map(({ td, headerId }) => {
          const cellContent = td.textContent?.trim().slice(0, 15) || "";
          return {
            id: `td references non-existent header "${headerId}"${cellContent ? ` (content: "${cellContent}...")` : ""}`,
          };
        }),
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
