// a11y/th-has-data-cells - Table headers have associated data cells

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI } from "@squirrelscan/utils";

import { ownTableCells, type OwnRow } from "../shared/own-table-cells";

interface GridCell {
  tag: string;
  el: Element;
}

/**
 * Build a 2D grid from a table's own rows (squirrelscan/repo#3355: not those of
 * the tables nested in it), expanding colspan/rowspan so each grid slot maps to
 * the cell that occupies it.
 */
function buildGrid(rows: readonly OwnRow[]): (GridCell | null)[][] {
  const grid: (GridCell | null)[][] = [];

  for (let r = 0; r < rows.length; r++) {
    if (!grid[r]) grid[r] = [];
    const cells = rows[r]!.cells;
    let cursor = 0;

    for (const cell of cells) {
      const colspan = Math.max(1, Number(getAttrCI(cell, "colspan")) || 1);
      const rowspan = Math.max(1, Number(getAttrCI(cell, "rowspan")) || 1);
      const tag = cell.tagName.toLowerCase();
      const entry: GridCell = { tag, el: cell };

      // Find next available column in current row. Every slot left of the
      // previous cell's column is filled, so the search starts there, not at
      // column 0 (a fractional span would make any other start point drift).
      let col = cursor;
      while (grid[r][col]) col++;
      cursor = col;

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
    verdictScope: "page",
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

    const orphanedHeaders: Array<{ el: Element; r: number; c: number }> = [];
    // Track already-reported th elements to avoid duplicates from spans
    const reported = new Set<Element>();
    const own = ownTableCells(doc);

    for (const table of tables) {
      const grid = buildGrid(own.get(table)?.rows ?? []);
      if (grid.length === 0) continue;

      // Which rows hold a td, and how many td slots each column holds, read
      // once rather than rescanned per header. A header's own slot is a th, so
      // a td anywhere in its column is in another row.
      const rowHasTd = grid.map((row) => !!row?.some((slot) => slot && slot.tag === "td"));
      const columnTds: number[] = [];
      for (const row of grid) {
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          if (row[c]?.tag === "td") columnTds[c] = (columnTds[c] ?? 0) + 1;
        }
      }

      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (!cell || cell.tag !== "th") continue;
          if (reported.has(cell.el)) continue;

          // Check same row, then same column, for td
          if (rowHasTd[r] || (columnTds[c] ?? 0) > 0) continue;

          reported.add(cell.el);
          orphanedHeaders.push({ el: cell.el, r, c });
        }
      }
    }

    if (orphanedHeaders.length > 0) {
      checks.push({
        name: "th-has-data-cells",
        status: "warn",
        message: `${orphanedHeaders.length} <th> element(s) without associated data cells`,
        // Text read for the shown ten only: on nested markup each header's
        // text is its whole subtree's.
        items: orphanedHeaders.slice(0, 10).map(({ el, r, c }) => ({
          id: el.textContent?.trim().slice(0, 30) || `row ${r + 1}, col ${c + 1}`,
        })),
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
