// #1457: Klaviyo script loaders that were lost when the script URL signature became anchored.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

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
});
