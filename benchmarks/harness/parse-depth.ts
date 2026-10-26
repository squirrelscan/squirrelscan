// parsePage time on deeply nested pages (squirrelscan/repo#3356). Usage:
//   bun benchmarks/harness/parse-depth.ts [--runs=N] [sizes...]   (default 1000 5000 20000, 3 runs)
// Prints one row per shape and size: parsePage ms and the crawler's
// extractLinks ms (extractors/links.ts) on the same document, min of N runs.

import { parseHTML } from "../../packages/parser/src/dom";
import { extractLinks } from "../../packages/parser/src/extractors/links";
import { parsePage } from "../../packages/parser/src/html";

const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice("--runs=".length)) || 3;
const sizes = args.map(Number).filter((n) => n > 0);

const shapes: Array<[string, string, string]> = [
  ["role=text spans", '<span role="text"><a href="/x">x</a>', "</span>"],
  ["aria-hidden divs", '<div aria-hidden="true"><a href="/x">x</a>', "</div>"],
  ["blockquotes", '<blockquote><a href="/x">l</a>', "</blockquote>"],
];

const url = "https://example.com/";
const min = (f: () => void): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    f();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

for (const size of sizes.length > 0 ? sizes : [1000, 5000, 20000]) {
  for (const [name, open, close] of shapes) {
    const html = `<!doctype html><html lang="en"><body><main>${open.repeat(size)}${close.repeat(size)}</main></body></html>`;
    const parseMs = min(() => parsePage(html, url));
    const { document } = parseHTML(html);
    const linksMs = min(() => extractLinks(document as never, url));
    console.log(`${name}\t${size}\tparsePage ${parseMs.toFixed(0)} ms\textractLinks ${linksMs.toFixed(0)} ms`);
  }
}
