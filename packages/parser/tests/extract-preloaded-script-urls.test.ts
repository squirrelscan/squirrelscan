// Script files a page preloads without a <script src>: modulepreload and preload as=script.

import { describe, expect, test } from "bun:test";

import { parseDocument } from "../src/index";
import { extractPreloadedScriptUrls } from "../src/extractors/scripts";

const BASE = "https://example.com/blog/post";
const preloaded = (html: string): string[] =>
  extractPreloadedScriptUrls(parseDocument(`<!doctype html><html><head>${html}</head><body></body></html>`), BASE);

describe("extractPreloadedScriptUrls", () => {
  test("finds modulepreload and preload as=script, resolved and deduplicated", () => {
    expect(
      preloaded(
        '<link rel="modulepreload" href="/a.js"><link rel="Preload" as="SCRIPT" href="b.js"><link rel="modulepreload" href="/a.js">',
      ),
    ).toEqual(["https://example.com/a.js", "https://example.com/blog/b.js"]);
  });

  test("ignores other preloads, data: URLs and noscript content", () => {
    expect(
      preloaded(
        '<link rel="preload" as="style" href="/a.css"><link rel="modulepreload" href="data:text/javascript,1"><noscript><link rel="modulepreload" href="/n.js"></noscript>',
      ),
    ).toEqual([]);
  });
});
