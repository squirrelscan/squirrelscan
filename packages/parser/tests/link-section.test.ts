// LinkData.section: which part of the page an anchor sits in (#2307). Both producers must agree
// (parsePage is what the crawler stores; extractLinks feeds parseHtmlForRules).

import { describe, expect, test } from "bun:test";

import { extractLinks } from "../src/extractors/links";
import { parsePage } from "../src/html";
import { parseDocument } from "../src/index";

const URL = "https://example.com/post";

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}

function sections(body: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const l of parsePage(page(body), URL).links) out[l.text] = l.section;
  return out;
}

describe("link section", () => {
  test("landmarks name the section", () => {
    expect(
      sections(
        `<header><a href="/h">h</a></header><nav><a href="/n">n</a></nav>` +
          `<aside><a href="/s">s</a></aside><footer><a href="/f">f</a></footer>` +
          `<main><p><a href="/c">c</a></p></main><a href="/x">x</a>`,
      ),
    ).toEqual({
      h: "header",
      n: "navigation",
      s: "sidebar",
      f: "footer",
      c: "content",
      x: "unknown",
    });
  });

  test("ARIA roles count; the outermost chrome landmark wins", () => {
    expect(
      sections(
        `<div role="contentinfo"><nav><a href="/a">a</a></nav></div>` +
          `<div role="banner"><a href="/b">b</a></div>`,
      ),
    ).toEqual({ a: "footer", b: "header" });
  });

  test("a header or footer inside an article is the article's own, not the site's", () => {
    expect(
      sections(
        `<article><header><a href="/a">a</a></header><p><a href="/b">b</a></p>` +
          `<footer><a href="/c">c</a></footer></article>`,
      ),
    ).toEqual({ a: "content", b: "content", c: "content" });
  });

  test("a comment thread is comments, inside main or article", () => {
    expect(
      sections(
        `<main><article><a href="/body">body</a></article>` +
          `<section id="comments"><ol class="comment-list"><li><a href="/spam">spam</a></li></ol></section></main>`,
      ),
    ).toEqual({ body: "content", spam: "comments" });
    expect(sections(`<div class="disqus_thread"><a href="/d">d</a></div>`)).toEqual({
      d: "comments",
    });
  });

  test("names that only contain the word do not count", () => {
    expect(
      sections(
        `<main><div class="comment-form"><a href="/a">a</a></div>` +
          `<div class="commentary"><a href="/b">b</a></div>` +
          `<div id="recommendations"><a href="/c">c</a></div></main>`,
      ),
    ).toEqual({ a: "content", b: "content", c: "content" });
  });

  test("a comment thread inside the footer stays footer", () => {
    expect(sections(`<footer><div id="comments"><a href="/a">a</a></div></footer>`)).toEqual({
      a: "footer",
    });
  });

  test("extractLinks agrees with parsePage", () => {
    const html = page(
      `<nav><a href="/n">n</a></nav><main><a href="/c">c</a><div id="comments"><a href="/m">m</a></div></main>`,
    );
    const stored = parsePage(html, URL).links.map((l) => [l.text, l.section]);
    const document = parseDocument(html);
    const extracted = extractLinks(document, URL).map((l) => [l.text, l.section]);
    expect(extracted).toEqual(stored);
  });
});
