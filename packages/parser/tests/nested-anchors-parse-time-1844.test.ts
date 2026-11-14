// squirrelscan/squirrelscan#1844: parsePage was quadratic on directly nested anchors. The parse
// keeps `<a>` inside `<a>` (a browser never does: the HTML parser closes the open anchor when the
// next one starts), and anchor text read every descendant anchor's text into each ancestor, so
// 20,000 nested links stored about 1 GB of link text and took 45 s. Anchor text now stops at a
// nested anchor. These pin the time, that every link is still found with its own text, and the
// text semantics on small shapes.

import { describe, expect, test } from "bun:test";

import { anchorTextResult } from "../src/extractors/anchor-text";
import { extractLinks } from "../src/extractors/links";
import { parseHTML } from "../src/dom";
import { parsePage } from "../src/html";

const URL = "https://example.com/";

const nestedAnchors = (n: number): string => {
  let open = "";
  for (let i = 0; i < n; i++) open += `<a href="/p${i}">l${i}`;
  return `<!doctype html><html><head><title>t</title></head><body>${open}${"</a>".repeat(n)}</body></html>`;
};

/**
 * The bound for 20,000 nested anchors. After the fix the parse takes about 0.2 s on a 48-core
 * AMD EPYC 9254 (it took 45 s before); 5 s leaves 25x headroom for a slow or busy CI runner and
 * still fails the quadratic walk by an order of magnitude.
 */
const MAX_PARSE_MS = 5_000;

describe("nested anchors parse in linear time (#1844)", () => {
  test(`20,000 nested anchors parse in under ${MAX_PARSE_MS} ms and keep every link`, { timeout: 60_000 }, () => {
    const n = 20_000;
    const html = nestedAnchors(n);
    const start = performance.now();
    const page = parsePage(html, URL);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(MAX_PARSE_MS);
    // Not passing by returning nothing: every link is found, each with its own text.
    expect(page.links).toHaveLength(n);
    expect(page.links[0]).toMatchObject({ url: "https://example.com/p0", text: "l0" });
    expect(page.links[n - 1]).toMatchObject({ url: `https://example.com/p${n - 1}`, text: `l${n - 1}` });
    expect(page.links.every((link, i) => link.text === `l${i}`)).toBe(true);
  });

  test("extractors/links.ts finds every nested link with its own text", { timeout: 60_000 }, () => {
    const n = 20_000;
    const { document } = parseHTML(nestedAnchors(n));
    const links = extractLinks(document as never, URL);
    expect(links).toHaveLength(n);
    expect(links.every((link, i) => link.text === `l${i}`)).toBe(true);
  });
});

describe("a nested anchor's text is its own, as a browser reads it (#1844)", () => {
  const texts = (html: string) => parsePage(`<html><body>${html}</body></html>`, URL).links.map((l) => l.text);

  test("directly nested anchors each read their own text", () => {
    expect(texts('<a href="/1">outer<a href="/2">inner</a></a>')).toEqual(["outer", "inner"]);
  });

  test("an anchor nested inside an element of the outer anchor is skipped too", () => {
    expect(texts('<a href="/1"><span>outer <b>bold</b></span><div><a href="/2">inner</a></div></a>')).toEqual([
      "outer bold",
      "inner",
    ]);
  });

  test("an anchor without href still ends the outer anchor's text", () => {
    expect(texts('<a href="/1">outer<a name="x">named</a></a>')).toEqual(["outer"]);
  });

  test("outer text on both sides of a nested anchor is not fused into one word", () => {
    const { document } = parseHTML('<html><body><a href="/1">before<a href="/2">x</a>after</a></body></html>');
    const outer = document.querySelector("a") as never;
    expect(anchorTextResult(outer)).toEqual({ text: "before after", glued: false });
  });

  test("an anchor with no nested anchor reads as before", () => {
    expect(texts('<a href="/1"><h3>Carpentry</h3><p>Structural &amp; finish</p></a>')).toEqual([
      "Carpentry Structural & finish",
    ]);
  });
});
