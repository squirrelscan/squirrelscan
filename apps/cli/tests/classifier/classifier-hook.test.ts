// The parser hook for the bundled classifier (#2307): what the crawler hands to `parsePage`.

import { parseDocument, parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import {
  isClassifierLoaded,
  resetBundledClassifier,
} from "../../src/classifier";
import { createPageClassifierHook } from "../../src/classifier/hook";

const URL = "https://example.com/blog/post";
const HTML = `<!doctype html><html><head><title>t</title></head><body>
<header><nav><a href="/">Home</a></nav></header>
<main><article><h1>Post</h1><p>${"Some text about crawling and queues. ".repeat(20)}</p>
<a href="/in-body">in body</a></article></main>
<footer><a href="/legal">Legal</a></footer></body></html>`;

describe("the parser hook", () => {
  test("creating it reads nothing; the first classified page loads the model", () => {
    resetBundledClassifier();
    const hook = createPageClassifierHook();
    expect(isClassifierLoaded()).toBe(false);
    expect(
      hook({ document: parseDocument(HTML), url: URL, html: HTML })
    ).not.toBeNull();
    expect(isClassifierLoaded()).toBe(true);
  });

  test("answers a page type and places an anchor", () => {
    const hook = createPageClassifierHook();
    const document = parseDocument(HTML);
    const out = hook({ document, url: URL, html: HTML })!;
    expect(out.classification.degraded).toBe("");
    expect(typeof out.classification.pageType.label).toBe("string");
    expect(["model", "rules"]).toContain(out.classification.pageType.source);
    const placement = out.placeLink(
      document.querySelector('a[href="/in-body"]')!
    );
    expect(placement).not.toBeNull();
  });

  test("a spent budget degrades the page and says why", () => {
    const hook = createPageClassifierHook({ budgetMs: -1 });
    const out = hook({ document: parseDocument(HTML), url: URL, html: HTML })!;
    expect(out.classification.degraded).toContain("time budget");
  });

  test("through parsePage: classification is stored, markup sections stay", () => {
    const parsed = parsePage(HTML, URL, {
      classify: createPageClassifierHook(),
    });
    expect(parsed.classification).toBeDefined();
    expect(parsed.classification!.degraded).toBe("");
    const section = (href: string) =>
      parsed.links.find((l) => l.url.endsWith(href))!.section;
    expect(section("/")).toBe("header");
    expect(section("/legal")).toBe("footer");
  });
});
