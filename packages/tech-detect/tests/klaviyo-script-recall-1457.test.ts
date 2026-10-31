// #1457: Klaviyo script loaders that were lost when the script URL signature became anchored.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { ALL_FINGERPRINTS } from "../src/fingerprints";

const KLAVIYO = ALL_FINGERPRINTS.find((fp) => fp.id === "klaviyo")!;

const SRC = "https://static.klaviyo.com/onsite/js/klaviyo.js";
const page = (head: string, body = "<p>Shop</p>") =>
  `<!doctype html><html><head><title>Shop</title>${head}</head><body>${body}</body></html>`;
const found = (html: string, scripts?: Array<{ url: string; content?: string }>): string[] =>
  detectTechnologies({ url: "https://shop.example.com/", headers: {}, html, ...(scripts ? { scripts } : {}) }).map((t) => t.id);
const withAndWithoutBodies = (html: string): string[][] => [
  found(html),
  found(html, [{ url: "https://cdn.example.com/theme.js", content: "var theme = true;" }]),
];

describe("Klaviyo script recall", () => {
  test("an unquoted script src", () => {
    for (const ids of withAndWithoutBodies(page(`<script src=${SRC}></script>`))) expect(ids).toContain("klaviyo");
  });

  test("a quoted script src with browser-trimmed leading space", () => {
    for (const ids of withAndWithoutBodies(page(`<script src="  ${SRC}"></script>`))) expect(ids).toContain("klaviyo");
  });

  test("a script src after more than 300 characters of attributes", () => {
    const padding = Array.from({ length: 40 }, (_, i) => `data-padding-${i}="abcdefgh"`).join(" ");
    for (const ids of withAndWithoutBodies(page(`<script ${padding} src="${SRC}"></script>`))) expect(ids).toContain("klaviyo");
  });

  test("an inline JavaScript loader assignment", () => {
    const loader = `<script>var b=document.createElement("script");b.src="//static.klaviyo.com/onsite/js/klaviyo.js";document.head.appendChild(b);</script>`;
    for (const ids of withAndWithoutBodies(page(loader))) expect(ids).toContain("klaviyo");
  });

  test("a preload link and a lazy data-src", () => {
    for (const html of [
      page(`<link rel="preload" as="script" href="${SRC}">`),
      page(`<script data-src="${SRC}"></script>`),
    ]) {
      for (const ids of withAndWithoutBodies(html)) expect(ids).toContain("klaviyo");
    }
  });

  test("a proxied URL in the collected script list", () => {
    const proxy = `https://proxy.example.com/fetch/${SRC}`;
    expect(found(page(""), [{ url: proxy }])).toContain("klaviyo");
    expect(found(page(""), [{ url: proxy, content: "var loaded = true;" }])).toContain("klaviyo");
  });

  test("an anchor, escaped pre sample and commented-out script are not loaded scripts", () => {
    const html = page(
      `<!-- <script src="${SRC}"></script> -->`,
      `<a href="${SRC}">docs</a><pre>&lt;script src="${SRC}"&gt;&lt;/script&gt;</pre>`,
    );
    for (const ids of withAndWithoutBodies(html)) expect(ids).not.toContain("klaviyo");
  });

  test("only a preload link loads the script: rel before or after the href, stylesheet and prefetch do not", () => {
    for (const html of [
      page(`<link rel="modulepreload" href="${SRC}">`),
      page(`<link href="${SRC}" rel="preload" as="script">`),
      page(`<link as=script rel=preload href=${SRC}>`),
    ]) {
      for (const ids of withAndWithoutBodies(html)) expect(ids).toContain("klaviyo");
    }
    for (const html of [
      page(`<link rel="stylesheet" href="${SRC}">`),
      page(`<link rel="prefetch" href="${SRC}">`),
      page(`<link href="${SRC}">`),
    ]) {
      for (const ids of withAndWithoutBodies(html)) expect(ids).not.toContain("klaviyo");
    }
  });

  test("the inline loader scan stays inside the script's own body", () => {
    // The assignment sits in the NEXT script: the first, empty script must not claim it.
    const html = page(`<script></script><script>var b=document.createElement("script");b.src="//cdn.example.com/x.js";</script><link rel="preload" href="/a.css">`);
    for (const ids of withAndWithoutBodies(html)) expect(ids).not.toContain("klaviyo");
    const other = `<script>var u="${SRC}";</script><script>var b=1;b.src="/local.js";</script>`;
    for (const ids of withAndWithoutBodies(page(other))) expect(ids).not.toContain("klaviyo");
  });

  test("a megabyte of empty script tags is not slow", () => {
    const html = page("<script></script>".repeat(Math.ceil((1024 * 1024) / "<script></script>".length)));
    const start = performance.now();
    found(html);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test("a tag whose quoted attribute holds thousands of line-start openers is not slow", () => {
    for (const tag of ["script", "link"]) {
      const opener = `\n<${tag} `;
      const html = page(`<${tag} data-x="${opener.repeat(Math.ceil((1024 * 1024) / opener.length))}" src="/a.js"></${tag}>`);
      // The Klaviyo fingerprint alone: other vendors' patterns have their own cost on this shape.
      const start = performance.now();
      detectTechnologies({ url: "https://shop.example.com/", headers: {}, html }, [KLAVIYO]);
      expect(performance.now() - start).toBeLessThan(3000);
    }
  });
});
