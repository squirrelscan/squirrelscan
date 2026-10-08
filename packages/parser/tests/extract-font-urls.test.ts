// Font files a page references directly: preload links and inline @font-face (#318).

import { describe, expect, test } from "bun:test";

import { parseDocument } from "../src/index";
import { extractFontUrls } from "../src/extractors/fonts";

const BASE = "https://example.com/blog/post";
const fonts = (html: string): string[] =>
  extractFontUrls(parseDocument(`<!doctype html><html><head>${html}</head><body></body></html>`), BASE);

describe("extractFontUrls", () => {
  test("finds a font preload and resolves it against the page", () => {
    expect(fonts('<link rel="preload" as="font" href="/f/a.woff2" crossorigin>')).toEqual([
      "https://example.com/f/a.woff2",
    ]);
  });

  test("matches as=font and rel case-insensitively, and rel as a token list", () => {
    expect(fonts('<link rel="Preload prefetch" as="FONT" href="/f/a.woff2">')).toEqual([
      "https://example.com/f/a.woff2",
    ]);
  });

  test("finds every url() source of an inline @font-face, quoted or not", () => {
    const css = `@font-face{font-family:A;src:url("/f/a.woff2") format("woff2"),url('/f/a.woff?v=2') format('woff'),url(/f/a.ttf)}`;
    expect(fonts(`<style>${css}</style>`)).toEqual([
      "https://example.com/f/a.woff2",
      "https://example.com/f/a.woff?v=2",
      "https://example.com/f/a.ttf",
    ]);
  });

  test("lists a font used twice once", () => {
    const css = `@font-face{src:url(/f/a.woff2)}@font-face{src:url(/f/a.woff2)}`;
    expect(fonts(`<link rel="preload" as="font" href="/f/a.woff2"><style>${css}</style>`)).toEqual([
      "https://example.com/f/a.woff2",
    ]);
  });

  test("negative control: ignores everything that is not a font file the page names", () => {
    const css = `body{background:url(/img/bg.woff2)}@font-face{src:local("Arial"),url(/f/icons.svg#i),url(data:font/woff2;base64,AAAA)}`;
    expect(
      fonts(
        `<link rel="stylesheet" href="/f/external.css">` +
          `<link rel="preload" as="style" href="/f/a.woff2">` +
          `<link rel="prefetch" href="/f/b.woff2">` +
          `<style>${css}</style>` +
          `<noscript><link rel="preload" as="font" href="/f/ns.woff2"></noscript>`,
      ),
    ).toEqual([]);
  });
});
