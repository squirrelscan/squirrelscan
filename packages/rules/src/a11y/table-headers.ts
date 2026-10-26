// a11y/table-headers - Data tables have proper headers

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { ownTableCells, type OwnTable } from "../shared/own-table-cells";

export const tableHeadersRule: Rule = {
  meta: {
    id: "a11y/table-headers",
    name: "Table Headers",
    description: "Checks that data tables have proper headers",
    solution:
      "Data tables need proper headers for screen reader users to understand relationships. Use <th> for header cells, not styled <td>. Add scope='col' or scope='row' to clarify header direction. For complex tables, use id and headers attributes to associate data cells with headers. Include a <caption> to describe the table's purpose. Layout tables should have role='presentation'.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Get all tables that aren't layout tables
    const tables = doc.querySelectorAll(
      "table:not([role='presentation']):not([role='none'])"
    );

    if (tables.length === 0) {
      checks.push({
        name: "table-headers",
        status: "info",
        message: "No data tables found",
      });
      return { checks };
    }

    const tablesWithoutHeaders: number[] = [];
    let tableIndex = 0;
    // squirrelscan/repo#3355: whether a table holds a <th>, its own or a nested
    // table's, as `table.querySelectorAll("th")` answered, without querying
    // every table's subtree. A table wrapping a data table is a layout table
    // (axe reads it so too), so the nested table's headers still clear it.
    // Tables come in document order, so walking them backwards sees every nested
    // table before the one around it.
    const own = ownTableCells(doc);
    const withHeaders = new Set<OwnTable>();
    const owned = [...own.values()];
    for (let i = owned.length - 1; i >= 0; i--) {
      const t = owned[i]!;
      if (withHeaders.has(t) || t.cells.some((cell) => cell.localName === "th")) {
        withHeaders.add(t);
        if (t.parent) withHeaders.add(t.parent);
      }
    }

    for (const table of tables) {
      tableIndex++;
      const t = own.get(table);

      if (!t || !withHeaders.has(t)) {
        tablesWithoutHeaders.push(tableIndex);
      }
    }

    if (tablesWithoutHeaders.length > 0) {
      checks.push({
        name: "table-headers",
        status: "warn",
        message: `${tablesWithoutHeaders.length} table(s) without <th> headers`,
        items: tablesWithoutHeaders.map((i) => ({ id: `Table ${i}` })),
      });
    } else {
      checks.push({
        name: "table-headers",
        status: "pass",
        message: `All ${tables.length} data table(s) have headers`,
      });
    }

    return { checks };
  },
};
