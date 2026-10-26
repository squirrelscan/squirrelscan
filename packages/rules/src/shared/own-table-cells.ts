// Each table's own rows and cells, by one walk of the page (squirrelscan/repo#3355).
//
// `table.querySelectorAll("tr")` also returns the rows of every table nested
// inside it, so the table rules judged a nested table's cells as the outer
// table's, and a page of nested tables made them quadratic or worse
// (`a11y/th-has-data-cells` took 9.7 s at 200 levels). A row belongs to its
// nearest enclosing table, and a cell to its nearest enclosing row and table, as
// in the HTML table model. So a row nested inside a cell (`<th>B<div><tr>`,
// which a browser closes the cell for) is a row of its own, not part of the
// row around it.
//
// The elements are the ones the document-wide selectors return, so what counts
// as a table, row or cell (and that template content counts as none) is exactly
// what the rules queried before; the walk decides which table and row own them.

export interface OwnRow {
  row: Element;
  /** The row's own `th` and `td` cells, in document order. */
  cells: Element[];
}

export interface OwnTable {
  /** The nearest table this one is nested in. */
  parent: OwnTable | null;
  /** The table's own rows, in document order. */
  rows: OwnRow[];
  /** Every `th` and `td` the table owns, in a row or not, in document order. */
  cells: Element[];
}

/** The page's tables in document order, each with only the rows and cells it owns. */
export function ownTableCells(doc: Document): Map<Element, OwnTable> {
  const isTable = new Set<Element>(doc.querySelectorAll("table"));
  const tables = new Map<Element, OwnTable>();
  if (isTable.size === 0) return tables;
  const isRow = new Set<Element>(doc.querySelectorAll("tr"));
  const isCell = new Set<Element>(doc.querySelectorAll("th, td"));

  const stack: Array<{ el: Element; table: OwnTable | null; row: OwnRow | null }> = [];
  const pushChildren = (parent: ParentNode, table: OwnTable | null, row: OwnRow | null) => {
    const children = parent.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ el: children[i] as Element, table, row });
    }
  };
  pushChildren(doc, null, null);
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { el } = frame;
    let { table, row } = frame;
    // The selectors above never return template content: nothing inside counts.
    if (el.localName === "template") continue;
    if (isTable.has(el)) {
      table = { parent: table, rows: [], cells: [] };
      tables.set(el, table);
      row = null;
    } else if (isRow.has(el)) {
      if (table) {
        row = { row: el, cells: [] };
        table.rows.push(row);
      }
    } else if (isCell.has(el) && table) {
      table.cells.push(el);
      row?.cells.push(el);
    }
    pushChildren(el, table, row);
  }
  return tables;
}
