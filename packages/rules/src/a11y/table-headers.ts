// a11y/table-headers - Data tables have proper headers

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const tableHeadersRule: Rule = {
  meta: {
    id: "a11y/table-headers",
    name: "Table Headers",
    description: "Checks that data tables have proper headers",
    solution:
      "Data tables need proper headers for screen reader users to understand relationships. Use <th> for header cells, not styled <td>. Add scope='col' or scope='row' to clarify header direction. For complex tables, use id and headers attributes to associate data cells with headers. Include a <caption> to describe the table's purpose. Layout tables should have role='presentation'.",
    category: "a11y",
    scope: "page",
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

    for (const table of tables) {
      tableIndex++;
      const headers = table.querySelectorAll("th");

      if (headers.length === 0) {
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
