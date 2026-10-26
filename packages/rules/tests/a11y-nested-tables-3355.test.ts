// squirrelscan/repo#3355: four a11y rules scanned a subtree once per matched
// element. `a11y/th-has-data-cells`, `a11y/td-headers-attr` and
// `a11y/table-headers` read each table's rows and cells with
// `table.querySelectorAll`, which also returns those of every nested table, so
// a nested table's cells were judged as the outer table's and nested tables
// made the rules quadratic or worse (9.7 s at 200 levels).
// `a11y/link-in-text-block` took each text block's links, so a link in nested
// blocks was counted once per enclosing block. These pin (1) that the rewrites
// report what the previous implementations did wherever the two can agree, on
// seeded random pages; (2) the nested-table verdicts, now per table; and (3) a
// time budget on the deeply nested shapes.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { linkInTextBlockRule } from "../src/a11y/link-in-text-block";
import { tableHeadersRule } from "../src/a11y/table-headers";
import { tdHeadersAttrRule } from "../src/a11y/td-headers-attr";
import { thHasDataCellsRule } from "../src/a11y/th-has-data-cells";
import type { ParsedPage, Rule, RuleContext } from "../src/types";
import { referenceLinkInTextBlockRule } from "./fixtures/reference-3355/link-in-text-block";
import { referenceTableHeadersRule } from "./fixtures/reference-3355/table-headers";
import { referenceTdHeadersAttrRule } from "./fixtures/reference-3355/td-headers-attr";
import { referenceThHasDataCellsRule } from "./fixtures/reference-3355/th-has-data-cells";

const URL = "https://example.com/";

const parse = (html: string) => parsePage(html, URL) as ParsedPage;

function run(rule: Rule, parsed: ParsedPage, html = "") {
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed,
    options: {},
  };
  return rule.run(ctx);
}

/** mulberry32: a small seeded PRNG, so every failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;

const LINKS = [
  '<a href="/a">plain link</a>',
  '<a href="/b" style="text-decoration: none">no underline</a>',
  '<a href="/c" style="TEXT-DECORATION: underline">underlined</a>',
  '<a href="/d" class="no-underline">class</a>',
  '<a href="/e" class="text-decoration-none btn">class two</a>',
  "<a>no href</a>",
  '<a href="/f" style="color:red; text-decoration:dotted">dotted</a>',
  '<a href="/g">a link with a long enough text to be cut at thirty</a>',
];

const ID_POOL = ["h1", "h2", "h3", "x", "missing"];

/** One table cell's content: text, a link, a block, or nothing. */
function cellContent(r: () => number): string {
  return pick(r, ["", "text", pick(r, LINKS), `<p>${pick(r, LINKS)}</p>`, "<div>d</div>"]);
}

/** Span values, junk included, that the previous rule read the same way. */
const SPANS = ["2", "3", "2", "1.5", "2.7", "0.5", "0", "-1", "abc", "2px", " 2 ", "1e1", ""];

/** One cell: a th or td with optional id, headers, colspan and rowspan. */
function cell(r: () => number): string {
  const tag = r() < 0.4 ? "th" : "td";
  const attrs: string[] = [];
  if (tag === "th" && r() < 0.5) attrs.push(`id="${pick(r, ID_POOL)}"`);
  if (tag === "td" && r() < 0.4) {
    const ids = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(r, ID_POOL));
    attrs.push(`headers="${ids.join(" ")}"`);
  }
  if (r() < 0.15) attrs.push(`colspan="${pick(r, SPANS)}"`);
  if (r() < 0.15) attrs.push(`ROWSPAN="${pick(r, SPANS)}"`);
  return `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${cellContent(r)}</${tag}>`;
}

/** A table with no table nested in it. */
function flatTable(r: () => number): string {
  const role = pick(r, ["", "", "", ' role="presentation"', ' role="none"', ' role="grid"']);
  const rows = Array.from({ length: Math.floor(r() * 4) + (r() < 0.1 ? 0 : 1) }, () => {
    const cells = Array.from({ length: Math.floor(r() * 4) }, () => cell(r)).join("");
    return `<tr>${cells}</tr>`;
  });
  const body = pick(r, [
    rows.join(""),
    `<tbody>${rows.join("")}</tbody>`,
    `<thead>${rows.slice(0, 1).join("")}</thead><tbody>${rows.slice(1).join("")}</tbody>`,
    `<caption>c</caption>${rows.join("")}`,
    // Malformed: cells with no row, and a row's cell inside a wrapper.
    `${cell(r)}${cell(r)}${rows.join("")}`,
    `<tr>${cell(r)}<div>${cell(r)}</div></tr>${rows.join("")}`,
  ]);
  return `<table${role}>${body}</table>`;
}

/** A page of flat tables among other content, nested in ordinary containers. */
function flatTablePage(r: () => number): string {
  const parts = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
    const wrap = pick(r, ["", "div", "section", "li", "blockquote"]);
    const table = flatTable(r);
    const inner = r() < 0.3 ? `${table}<p>${pick(r, LINKS)}</p>` : table;
    return wrap ? `<${wrap}>${inner}</${wrap}>` : inner;
  });
  const stray = r() < 0.2 ? `<div><td headers="${pick(r, ID_POOL)}">stray</td></div>` : "";
  return `<!doctype html><html><body>${parts.join("")}${stray}</body></html>`;
}

/** A table nested in a cell of another, `depth` levels at most. */
function nestedTable(r: () => number, depth: number): string {
  const table = flatTable(r);
  if (depth === 0 || r() < 0.3) return table;
  const inner = nestedTable(r, depth - 1);
  const at = table.lastIndexOf("</td>") >= 0 ? table.lastIndexOf("</td>") : table.lastIndexOf("</th>");
  if (at < 0) return `${table}${inner}`;
  return `${table.slice(0, at)}${inner}${table.slice(at)}`;
}

/** Text blocks nested in each other and in other containers, with links. */
function blockTree(r: () => number, depth: number): string {
  if (depth === 0 || r() < 0.3) return pick(r, LINKS);
  const tag = pick(r, ["p", "li", "dd", "blockquote", "figcaption", "div", "span", "section"]);
  const kids = Array.from({ length: 1 + Math.floor(r() * 3) }, () => blockTree(r, depth - 1));
  if (tag === "li") return `<li>${kids.join("")}<ul>${kids.slice(0, 1).map((k) => `<li>${k}</li>`).join("")}</ul></li>`;
  return `<${tag}>${kids.join("")}</${tag}>`;
}

function blockPage(r: () => number): string {
  const body = Array.from({ length: 1 + Math.floor(r() * 3) }, () => blockTree(r, 5)).join("");
  const table = r() < 0.3 ? `<table><tr><td>${blockTree(r, 3)}</td><th>${pick(r, LINKS)}</th></tr></table>` : "";
  return `<!doctype html><html><body>${body}${table}<template><p>${LINKS[1]}</p></template></body></html>`;
}

const TABLE_RULES = [
  [thHasDataCellsRule, referenceThHasDataCellsRule],
  [tdHeadersAttrRule, referenceTdHeadersAttrRule],
  [tableHeadersRule, referenceTableHeadersRule],
] as const;

describe("the rewrites report what the previous implementations did (#3355)", () => {
  test("table rules: identical results on 600 seeded random pages without nested tables", { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= 600; seed++) {
      const html = flatTablePage(rng(seed));
      const parsed = parse(html);
      for (const [rule, reference] of TABLE_RULES) {
        expect(run(rule, parsed), `${rule.meta.id} seed ${seed}`).toEqual(run(reference, parsed));
      }
    }
  });

  test("table-headers: identical results on 600 seeded random pages of nested tables", { timeout: 30_000 }, () => {
    // A table counts the headers of the tables nested in it, as before.
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const html = `<!doctype html><html><body>${nestedTable(r, 4)}${nestedTable(r, 2)}</body></html>`;
      const parsed = parse(html);
      expect(run(tableHeadersRule, parsed), `seed ${seed}`).toEqual(run(referenceTableHeadersRule, parsed));
    }
  });

  test("link-in-text-block: identical results on 600 seeded random pages of nested blocks, each link once", { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= 600; seed++) {
      const parsed = parse(blockPage(rng(seed)));
      expect(run(linkInTextBlockRule, parsed), `seed ${seed}`).toEqual(
        run(referenceLinkInTextBlockRule, parsed),
      );
    }
  });
});

describe("a nested table is judged as its own table (#3355)", () => {
  test("th-has-data-cells: an outer header is not given data cells from a nested table", () => {
    const html =
      "<table><tr><th>Outer</th></tr><tr><th>Side<table><tr><td>inner data</td></tr></table></th></tr></table>";
    const [check] = run(thHasDataCellsRule, parse(html)).checks;
    expect(check!.status).toBe("warn");
    // A header's label is its text, the nested table's included.
    expect(check!.items!.map((i) => i.id)).toEqual(["Outer", "Sideinner data"]);
    // The previous rule read the nested td into the outer grid and passed it.
    expect(run(referenceThHasDataCellsRule, parse(html)).checks[0]!.status).toBe("pass");
    // Nor from a nested table whose cell sits in no row of its own.
    const rowless =
      "<table><tr><th>Outer</th></tr><tr><th>Side<table><td>inner data</td></table></th></tr></table>";
    expect(run(thHasDataCellsRule, parse(rowless)).checks[0]!.items).toHaveLength(2);
  });

  test("th-has-data-cells: a row inside a cell is a row of its own, as a browser builds it", () => {
    // The previous rule read the inner row's td into the outer row and passed.
    const html = "<table><tr><th>A</th><th>B<div><tr><td>x</td></tr></div></th></tr></table>";
    const [check] = run(thHasDataCellsRule, parse(html)).checks;
    expect(check!.items!.map((i) => i.id)).toEqual(["Bx"]);
    expect(run(referenceThHasDataCellsRule, parse(html)).checks[0]!.status).toBe("pass");
  });

  test("th-has-data-cells: a nested table's own orphaned header is still reported, once", () => {
    const html =
      "<table><tr><th>A</th><td><table><tr><th>Lonely</th></tr></table></td></tr></table>";
    const [check] = run(thHasDataCellsRule, parse(html)).checks;
    expect(check!.items!.map((i) => i.id)).toEqual(["Lonely"]);
  });

  test("td-headers-attr: a bad reference in a nested table is reported once, not once per table", () => {
    const html =
      '<table><tr><th id="o">o</th><td><table><tr><th id="i">i</th><td headers="missing">x</td></tr></table></td></tr></table>';
    const [check] = run(tdHeadersAttrRule, parse(html)).checks;
    expect(check!.status).toBe("fail");
    expect(check!.items).toHaveLength(1);
    expect(run(referenceTdHeadersAttrRule, parse(html)).checks[0]!.items).toHaveLength(2);
  });

  test("td-headers-attr: a cell may only reference the header cells of its own table", () => {
    const html =
      '<table><tr><th id="o">o</th><td><table><tr><td headers="o">x</td></tr></table></td></tr></table>' +
      '<table><tr><th id="t">t</th><td headers="t">ok</td></tr></table>';
    const [check] = run(tdHeadersAttrRule, parse(html)).checks;
    expect(check!.status).toBe("fail");
    expect(check!.items!.map((i) => i.id)).toEqual([
      'td references non-existent header "o" (content: "x...")',
    ]);
  });

  test("table-headers: a table wrapping a table with headers still passes, as a layout table", () => {
    const html =
      "<table><tr><td><table><tr><th>h</th></tr><tr><td>d</td></tr></table></td></tr></table>" +
      "<table><tr><td><table><tr><td>no headers</td></tr></table></td></tr></table>";
    const [check] = run(tableHeadersRule, parse(html)).checks;
    expect(check!.status).toBe("warn");
    expect(check!.items).toEqual([{ id: "Table 3" }, { id: "Table 4" }]);
  });

  test("link-in-text-block: a link in nested list items is counted once", () => {
    const html =
      '<ul><li>Intro <ul><li><a href="/x" style="text-decoration:none">deep</a></li></ul></li></ul>';
    const [check] = run(linkInTextBlockRule, parse(html)).checks;
    expect(check!.items).toEqual([{ id: '"deep"' }]);
  });
});

/** The rule's own run time on `html`, parsing not included. */
function ruleMs(rule: Rule, html: string): number {
  const parsed = parse(html);
  const start = performance.now();
  run(rule, parsed);
  return performance.now() - start;
}

const nested = (depth: number, open: (i: number) => string, close: string) =>
  `<!doctype html><html><body>${Array.from({ length: depth }, (_, i) => open(i)).join("")}x${close.repeat(depth)}</body></html>`;

/**
 * Subtree queries the rule makes while it runs: `querySelectorAll` called on
 * an element rather than on the document. The previous rules made one per
 * table or text block; the rewrites make none, however deep the page.
 */
function elementQueries(rule: Rule, parsed: ParsedPage): number {
  const doc = parsed.document as unknown as Document;
  let proto = Object.getPrototypeOf(doc.querySelector("body"));
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "querySelectorAll")) {
    proto = Object.getPrototypeOf(proto);
  }
  const original = proto.querySelectorAll;
  let calls = 0;
  proto.querySelectorAll = function (this: Node, ...args: unknown[]) {
    // An element (nodeType 1), not the document (9) the page-wide queries run on.
    if (this.nodeType === 1) calls++;
    return original.apply(this, args);
  };
  try {
    run(rule, parsed);
  } finally {
    proto.querySelectorAll = original;
  }
  return calls;
}

describe("nested markup costs a walk, not a walk per element (#3355)", () => {
  test("th-has-data-cells: 20,000 nested tables in under 1 s", { timeout: 60_000 }, () => {
    const html = nested(20_000, () => "<table><tr><th>h</th><td>", "</td></tr></table>");
    expect(ruleMs(thHasDataCellsRule, html)).toBeLessThan(1_000);
  });

  test("td-headers-attr and table-headers: 20,000 nested tables in under 1 s each", { timeout: 60_000 }, () => {
    const html = nested(
      20_000,
      (i) => `<table><tr><th id="h${i}">h</th><td headers="h${i}">`,
      "</td></tr></table>",
    );
    expect(ruleMs(tdHeadersAttrRule, html)).toBeLessThan(1_000);
    expect(ruleMs(tableHeadersRule, html)).toBeLessThan(1_000);
  });

  test("link-in-text-block: 5,000 nested blocks in under 1 s", { timeout: 60_000 }, () => {
    const html = nested(
      5_000,
      () => '<blockquote><a href="/x" style="text-decoration:none">l</a>',
      "</blockquote>",
    );
    expect(ruleMs(linkInTextBlockRule, html)).toBeLessThan(1_000);
  });

  test("none of the four queries a subtree per table or block", () => {
    const tables = parse(
      nested(50, (i) => `<table><tr><th id="h${i}">h</th><td headers="h${i}"><p><a href="/x">l</a>`, "</p></td></tr></table>"),
    );
    for (const [rule, reference] of [
      ...TABLE_RULES,
      [linkInTextBlockRule, referenceLinkInTextBlockRule] as const,
    ]) {
      expect(elementQueries(rule, tables), rule.meta.id).toBe(0);
      // The spy sees the previous rule's per-table and per-block queries.
      expect(elementQueries(reference, tables), rule.meta.id).toBeGreaterThan(0);
    }
  });
});

describe("spans a browser would not read (#3355)", () => {
  const judge = (colspan: string, rowspan = "1") =>
    run(
      thHasDataCellsRule,
      parse(
        `<table><tr><th colspan="${colspan}" rowspan="${rowspan}">h</th><td>d</td></tr>` +
          "<tr><th>lonely</th></tr></table>",
      ),
    ).checks[0]!;

  test("an infinite, unparseable, zero, negative or fractional span reads as before or as 1", { timeout: 10_000 }, () => {
    // Infinity and 1e999 used to fill slots until the process ran out of memory.
    const asOne = judge("1");
    for (const value of ["Infinity", "1e999", "-Infinity", "NaN", "abc", "0", "-1", "0.5"]) {
      expect(judge(value), `colspan ${value}`).toEqual(asOne);
      expect(judge("1", value), `rowspan ${value}`).toEqual(asOne);
    }
    expect(judge("1.5")).toEqual(run(referenceThHasDataCellsRule, parse(
      '<table><tr><th colspan="1.5" rowspan="1">h</th><td>d</td></tr><tr><th>lonely</th></tr></table>',
    )).checks[0]!);
  });

  test("a span past the spec's limit reads as the limit, and a grid stops at its slot cap", { timeout: 10_000 }, () => {
    // 1,000 columns: the second row's td sits under the header's 1,000th column.
    const wide = parse(
      '<table><tr><th colspan="100000">h</th></tr><tr><td colspan="999"></td><td>d</td></tr></table>',
    );
    expect(run(thHasDataCellsRule, wide).checks[0]!.status).toBe("pass");
    const start = performance.now();
    const huge = run(
      thHasDataCellsRule,
      parse(
        '<table><tr><th>first</th></tr><tr><td colspan="1000" rowspan="65534">x</td><th>after</th></tr></table>',
      ),
    ).checks[0]!;
    expect(performance.now() - start).toBeLessThan(1_000);
    // The cell past the cap is not placed: the table is judged on what came before.
    expect(huge.items).toEqual([{ id: "first" }]);
  });

  test("wide rows cost a walk of the row, not one per cell", { timeout: 60_000 }, () => {
    const headers = `<table><tr>${"<th>h</th>".repeat(20_000)}</tr></table>`;
    expect(ruleMs(thHasDataCellsRule, headers)).toBeLessThan(1_000);
    const spans = `<table><tr>${'<td colspan="1000">x</td>'.repeat(500)}<th>h</th></tr></table>`;
    expect(ruleMs(thHasDataCellsRule, spans)).toBeLessThan(1_000);
  });
});
