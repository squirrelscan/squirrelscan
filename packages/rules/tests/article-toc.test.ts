// content/article-toc reads ItemList JSON-LD nested in an @graph wrapper (#339).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { articleTocRule } from "../src/content/article-toc";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/guide";

const TOC_LIST = {
  "@type": "ItemList",
  itemListElement: [
    { "@type": "ListItem", position: 1, url: `${URL}#intro`, name: "Intro" },
    { "@type": "ListItem", position: 2, url: `${URL}#setup`, name: "Setup" },
  ],
};

const ARTICLE = { "@type": "Article", headline: "Guide", url: URL };

function ld(json: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
}

function page(jsonLd: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Guide</title>${jsonLd}</head><body>
<nav aria-label="Table of contents"><a href="#intro">Intro</a><a href="#setup">Setup</a></nav>
<article><h1>Guide</h1>
<h2 id="intro">Intro</h2><p>Text.</p>
<h2 id="setup">Setup</h2><p>Text.</p>
<h2 id="more">More</h2><p>Text.</p>
</article></body></html>`;
}

function run(html: string): CheckResult {
  const parsed = parsePage(html, URL);
  const ctx = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  } as unknown as RuleContext;
  const result = articleTocRule.run(ctx) as { checks: CheckResult[] };
  const check = result.checks.find((c) => c.name === "article-toc");
  if (!check) throw new Error("no article-toc check");
  return check;
}

describe("content/article-toc: ItemList schema", () => {
  test("an ItemList nested in an @graph wrapper counts as TOC schema", () => {
    const c = run(page(ld(ARTICLE) + ld({ "@context": "https://schema.org", "@graph": [TOC_LIST] })));
    expect(c.status).toBe("pass");
  });

  test("the @graph verdict matches the flat markup verdict", () => {
    const flat = run(page(ld(ARTICLE) + ld(TOC_LIST)));
    const graph = run(page(ld(ARTICLE) + ld({ "@context": "https://schema.org", "@graph": [TOC_LIST] })));
    expect(graph.status).toBe(flat.status);
    expect(graph.message).toBe(flat.message);
  });

  test("a graph with no ItemList still warns about missing schema", () => {
    const c = run(page(ld({ "@context": "https://schema.org", "@graph": [ARTICLE] })));
    expect(c.status).toBe("warn");
    expect(c.message).toBe("Table of contents missing schema markup");
  });

  test("unparseable JSON-LD is skipped, not thrown on", () => {
    const html = page(ld(ARTICLE) + `<script type="application/ld+json">{"@graph": [</script>`);
    expect(() => run(html)).not.toThrow();
    expect(run(html).status).toBe("warn");
  });
});
