// Rule time for nested tables and nested text blocks (squirrelscan/repo#3355).
// Usage:
//   bun benchmarks/harness/a11y-nested-tables.ts [--before] [--only=<rule id part>] [sizes...]
//   (sizes default to 200 1000 5000)
// Prints one row per rule and size: parse ms, rule ms (min of 3 runs).
// `--before` runs the previous implementations, kept as the test oracles.

import { parsePage } from "../../packages/parser/src/index";

import { linkInTextBlockRule } from "../../packages/rules/src/a11y/link-in-text-block";
import { tableHeadersRule } from "../../packages/rules/src/a11y/table-headers";
import { tdHeadersAttrRule } from "../../packages/rules/src/a11y/td-headers-attr";
import { thHasDataCellsRule } from "../../packages/rules/src/a11y/th-has-data-cells";
import type { ParsedPage, Rule, RuleContext } from "../../packages/rules/src/types";
import { referenceLinkInTextBlockRule } from "../../packages/rules/tests/fixtures/reference-3355/link-in-text-block";
import { referenceTableHeadersRule } from "../../packages/rules/tests/fixtures/reference-3355/table-headers";
import { referenceTdHeadersAttrRule } from "../../packages/rules/tests/fixtures/reference-3355/td-headers-attr";
import { referenceThHasDataCellsRule } from "../../packages/rules/tests/fixtures/reference-3355/th-has-data-cells";

const args = process.argv.slice(2);
const before = args.includes("--before");
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const sizes = args.map(Number).filter((n) => n > 0);

/** `depth` nested `open` elements, closed by `close`. */
function nested(depth: number, open: (i: number) => string, close: string): string {
  return `<!doctype html><html lang="en"><body><main>${Array.from({ length: depth }, (_, i) => open(i)).join("")}x${close.repeat(depth)}</main></body></html>`;
}

const table = (i: number) => `<table><tr><th id="h${i}">h</th><td headers="h${i}">`;
const shapes: Array<{ rule: Rule; reference: Rule; html: (n: number) => string }> = [
  {
    rule: thHasDataCellsRule,
    reference: referenceThHasDataCellsRule,
    html: (n) => nested(n, table, "</td></tr></table>"),
  },
  {
    rule: tdHeadersAttrRule,
    reference: referenceTdHeadersAttrRule,
    html: (n) => nested(n, table, "</td></tr></table>"),
  },
  {
    rule: tableHeadersRule,
    reference: referenceTableHeadersRule,
    html: (n) => nested(n, table, "</td></tr></table>"),
  },
  {
    rule: linkInTextBlockRule,
    reference: referenceLinkInTextBlockRule,
    html: (n) =>
      nested(n, () => '<blockquote><a href="/x" style="text-decoration:none">l</a>', "</blockquote>"),
  },
];

const url = "https://example.com/";
for (const size of sizes.length > 0 ? sizes : [200, 1000, 5000]) {
  for (const shape of shapes) {
    if (only && !shape.rule.meta.id.includes(only)) continue;
    const rule = before ? shape.reference : shape.rule;
    const page = shape.html(size);
    const parseStart = performance.now();
    const parsed = parsePage(page, url) as ParsedPage;
    const parseMs = performance.now() - parseStart;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const ctx: RuleContext = {
        page: { url, html: page, statusCode: 200, loadTime: 0, headers: {} },
        parsed,
        options: {},
      };
      const start = performance.now();
      rule.run(ctx);
      best = Math.min(best, performance.now() - start);
    }
    console.log(
      `${rule.meta.id}\t${size}\tparse ${parseMs.toFixed(0)} ms\trule ${best.toFixed(0)} ms`,
    );
  }
}
