// Rule time for deeply nested role="text" and aria-hidden containers
// (squirrelscan/repo#3066). Usage:
//   bun benchmarks/harness/a11y-nesting.ts [sizes...]   (default 1000 5000 20000)
// Prints one row per rule and size: parse ms, rule ms (min of 3 runs).

import { parsePage } from "../../packages/parser/src/index";

import { ariaHiddenFocusRule } from "../../packages/rules/src/a11y/aria-hidden-focus";
import { ariaTextRule } from "../../packages/rules/src/a11y/aria-text";
import type { ParsedPage, Rule, RuleContext } from "../../packages/rules/src/types";

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);

/** `depth` nested `open` elements, each with a focusable link beside the next level. */
function nested(depth: number, open: string, close: string): string {
  return `<!doctype html><html lang="en"><body><main>${`${open}<a href="/x">x</a>`.repeat(depth)}${close.repeat(depth)}</main></body></html>`;
}

const shapes: Array<{ rule: Rule; html: (n: number) => string }> = [
  { rule: ariaTextRule, html: (n) => nested(n, '<span role="text">', "</span>") },
  { rule: ariaHiddenFocusRule, html: (n) => nested(n, '<div aria-hidden="true">', "</div>") },
];

const url = "https://example.com/";
for (const size of sizes.length > 0 ? sizes : [1000, 5000, 20000]) {
  for (const { rule, html } of shapes) {
    const page = html(size);
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
