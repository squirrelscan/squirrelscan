// extractPageMainText (#2359): the classifier as the parser extractor's placer.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseHTML } from "@squirrelscan/parser/dom";
import { extractPageMainText } from "../src/main-text";
import { tryLoadModel } from "../src/predict";

const ARTIFACT = join(import.meta.dir, "../assets/classifier-v2.json");
const HAS_ARTIFACT = existsSync(ARTIFACT);
const URL = "https://example.com/blog/how-we-test-crawlers";

const PAGE = `<!doctype html><html lang="en"><head><title>How we test crawlers</title></head>
<body class="single-post">
  <header class="site-header"><nav><a href="/">Home</a> <a href="/archive">Archive</a></nav></header>
  <main><article><header class="entry-header"><h1>How we test crawlers</h1><p>By Ada Lovelace</p></header>
    <p>The first thing a crawler has to get right is the queue, and the queue is harder
      than it looks once redirects are involved.</p>
    <div class="cookie-banner"><p>We use cookies to remember you.</p></div>
    <h2>Fixtures</h2>
    <pre><code class="language-sh">bun test</code></pre>
    <div class="tawk-widget"><p>Chat with support</p></div>
    <p>We keep a fixture site with every shape we have seen in the wild.</p></article></main>
  <aside class="sidebar"><h2>Elsewhere</h2><ul><li><a href="/blog">Blog</a></li></ul></aside>
  <footer class="site-footer"><p>&copy; 2026 Example Journal, all rights reserved.</p></footer>
</body></html>`;

function assertClean(out: ReturnType<typeof extractPageMainText>) {
  expect(out.text).toContain("The first thing a crawler has to get right");
  expect(out.text).toContain("We keep a fixture site");
  expect(out.text).toContain("How we test crawlers");
  expect(out.text).not.toContain("By Ada Lovelace");
  for (const junk of ["Archive", "Elsewhere", "all rights reserved", "We use cookies", "Chat with support"]) {
    expect(out.text).not.toContain(junk);
  }
  expect(out.blocks.length).toBeGreaterThan(3);
  expect(out.blocks.every((b) => b.region === null || typeof b.region.label === "string")).toBe(true);
  const code = out.blocks.filter((b) => b.code);
  expect(code).toHaveLength(1);
  expect(code[0]).toMatchObject({ language: "sh", text: "bun test" });
  expect(out.proseText).not.toContain("bun test");
  expect(out.markdown).toContain("## Fixtures");
}

describe("extractPageMainText", () => {
  test("without a model: the rules path places landmarks, markup covers the rest", () => {
    const { document } = parseHTML(PAGE);
    const out = extractPageMainText(document, URL);
    assertClean(out);
    expect(out.blocks.some((b) => b.region?.label === "content_block" && b.region.source === "rules")).toBe(
      true,
    );
    expect(out.blocks.find((b) => b.region?.nodeId != null)).toBeDefined();
  });

  test.skipIf(!HAS_ARTIFACT)("with the bundled model: blocks are labelled and chrome dropped", () => {
    const { model } = tryLoadModel(JSON.parse(readFileSync(ARTIFACT, "utf8")));
    expect(model).not.toBeNull();
    const { document } = parseHTML(PAGE);
    const out = extractPageMainText(document, URL, { model, html: PAGE });
    assertClean(out);
    expect(out.placer).toBe("classifier");
  });

  test("does not modify the document", () => {
    const { document } = parseHTML(PAGE);
    const before = document.documentElement.outerHTML;
    extractPageMainText(document, URL);
    expect(document.documentElement.outerHTML).toBe(before);
  });
});
