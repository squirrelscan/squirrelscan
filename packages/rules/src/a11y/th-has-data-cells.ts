// a11y/th-has-data-cells - Table headers have associated data cells

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI } from "@squirrelscan/utils";

interface GridCell {
  tag: string;
  el: Element;
}

/**
 * Build a 2D grid from a table, expanding colspan/rowspan so each
 * grid slot maps to the cell that occupies it.
 */
function buildGrid(table: Element): (GridCell | null)[][] {
  const rows = table.querySelectorAll("tr");
  const grid: (GridCell | null)[][] = [];

  for (let r = 0; r < rows.length; r++) {
    if (!grid[r]) grid[r] = [];
    const cells = rows[r].querySelectorAll("th, td");

    for (const cell of cells) {
      const colspan = Math.max(1, Number(getAttrCI(cell, "colspan")) || 1);
      const rowspan = Math.max(1, Number(getAttrCI(cell, "rowspan")) || 1);
      const tag = cell.tagName.toLowerCase();
      const entry: GridCell = { tag, el: cell };

      // Find next available column in current row
      let col = 0;
      while (grid[r][col]) col++;

      // Fill the grid for the span area
      for (let dr = 0; dr < rowspan; dr++) {
        const row = r + dr;
        if (!grid[row]) grid[row] = [];
        for (let dc = 0; dc < colspan; dc++) {
          grid[row][col + dc] = entry;
        }
      }
    }
  }

  return grid;
}

export const thHasDataCellsRule: Rule = {
  meta: {
    id: "a11y/th-has-data-cells",
    name: "TH Has Data Cells",
    description: "Checks that table headers have associated data cells",
    solution:
      "Each <th> element should be associated with at least one <td> data cell in the same row or column. Orphaned header cells without data cells usually indicate the table is being misused for layout purposes. If the table is for layout, add role='presentation'. Otherwise, ensure every header has corresponding data cells.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const tables = doc.querySelectorAll(
      "table:not([role='presentation']):not([role='none'])"
    );

    if (tables.length === 0) {
      checks.push({
        name: "th-has-data-cells",
        status: "info",
        message: "No data tables found",
      });
      return { checks };
    }

    const orphanedHeaders: string[] = [];
    // Track already-reported th elements to avoid duplicates from spans
    const reported = new Set<Element>();

    for (const table of tables) {
      const grid = buildGrid(table);
      if (grid.length === 0) continue;

      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (!cell || cell.tag !== "th") continue;
          if (reported.has(cell.el)) continue;

          // Check same row for td
          const rowHasTd = row.some((slot) => slot && slot.tag === "td");
          if (rowHasTd) continue;

          // Check same column for td
          let colHasTd = false;
          for (let ri = 0; ri < grid.length; ri++) {
            if (ri !== r && grid[ri]?.[c]?.tag === "td") {
              colHasTd = true;
              break;
            }
          }
          if (colHasTd) continue;

          reported.add(cell.el);
          const text =
            cell.el.textContent?.trim().slice(0, 30) ||
            `row ${r + 1}, col ${c + 1}`;
          orphanedHeaders.push(text);
        }
      }
    }

    if (orphanedHeaders.length > 0) {
      checks.push({
        name: "th-has-data-cells",
        status: "warn",
        message: `${orphanedHeaders.length} <th> element(s) without associated data cells`,
        items: orphanedHeaders.slice(0, 10).map((id) => ({ id })),
        details:
          orphanedHeaders.length > 10
            ? { additional: orphanedHeaders.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "th-has-data-cells",
        status: "pass",
        message: "All table headers have associated data cells",
        details: { tablesChecked: tables.length },
      });
    }

    return { checks };
  },
};
