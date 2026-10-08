// parsePage().hreflangAlternates (squirrelscan/squirrelscan#489).
//
// The duplicate title and description rules run without a DOM on the streaming
// path, so the hreflang annotations they need must be captured at parse time and
// stored. These lock in what is captured and that the list is bounded: the
// record is serialized for every page, so a page cannot be allowed to grow it.

import { describe, expect, test } from "bun:test";

import { HREFLANG_ALTERNATES_MAX, parsePage } from "../src/index";

const URL = "http://127.0.0.1:8791/en-gb/shirt.html";

function page(head: string): string {
  return `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body></body></html>`;
}

describe("parsePage: hreflangAlternates", () => {
  test("extracts the issue's repro annotations, value lowercased, in document order", () => {
    const parsed = parsePage(
      page(
        `<link rel="canonical" href="http://127.0.0.1:8791/en-gb/shirt.html">` +
          `<link rel="alternate" hreflang="en-GB" href="http://127.0.0.1:8791/en-gb/shirt.html">` +
          `<link rel="alternate" hreflang="en-us" href="http://127.0.0.1:8791/en-us/shirt.html">` +
          `<link rel="alternate" hreflang="x-default" href="http://127.0.0.1:8791/en-gb/shirt.html">`,
      ),
      URL,
    );

    expect(parsed.hreflangAlternates).toEqual([
      { hreflang: "en-gb", href: "http://127.0.0.1:8791/en-gb/shirt.html" },
      { hreflang: "en-us", href: "http://127.0.0.1:8791/en-us/shirt.html" },
      { hreflang: "x-default", href: "http://127.0.0.1:8791/en-gb/shirt.html" },
    ]);
  });

  test("resolves relative hrefs against the page URL", () => {
    const parsed = parsePage(
      page(`<link rel="alternate" hreflang="en-us" href="../en-us/shirt.html">`),
      URL,
    );
    expect(parsed.hreflangAlternates).toEqual([
      { hreflang: "en-us", href: "http://127.0.0.1:8791/en-us/shirt.html" },
    ]);
  });

  test("deduplicates an exact (value, href) repeat, case-insensitively on the value", () => {
    const parsed = parsePage(
      page(
        `<link rel="alternate" hreflang="en-us" href="/en-us/shirt.html">` +
          `<link rel="alternate" hreflang="EN-US" href="/en-us/shirt.html">` +
          `<link rel="alternate" hreflang="en-us" href="/en-us/other.html">`,
      ),
      URL,
    );
    expect(parsed.hreflangAlternates).toEqual([
      { hreflang: "en-us", href: "http://127.0.0.1:8791/en-us/shirt.html" },
      { hreflang: "en-us", href: "http://127.0.0.1:8791/en-us/other.html" },
    ]);
  });

  test(`caps the list at ${HREFLANG_ALTERNATES_MAX} entries`, () => {
    const links = Array.from(
      { length: HREFLANG_ALTERNATES_MAX + 25 },
      (_, i) => `<link rel="alternate" hreflang="en-x${i}" href="/p${i}.html">`,
    ).join("");
    const alternates = parsePage(page(links), URL).hreflangAlternates ?? [];
    expect(alternates).toHaveLength(HREFLANG_ALTERNATES_MAX);
    expect(alternates[0]).toEqual({ hreflang: "en-x0", href: "http://127.0.0.1:8791/p0.html" });
  });

  test("skips links that are not rel=alternate, and empty or oversize fields", () => {
    const parsed = parsePage(
      page(
        `<link rel="canonical" hreflang="en-us" href="/a.html">` +
          `<link rel="alternate" hreflang="" href="/b.html">` +
          `<link rel="alternate" hreflang="en-us" href="">` +
          `<link rel="alternate" hreflang="en-us" href="/${"x".repeat(2100)}">` +
          `<link rel="ALTERNATE stylesheet" hreflang="de" href="/de.html">`,
      ),
      URL,
    );
    expect(parsed.hreflangAlternates).toEqual([
      { hreflang: "de", href: "http://127.0.0.1:8791/de.html" },
    ]);
  });

  test("a page without annotations gets an empty list", () => {
    expect(parsePage(page(""), URL).hreflangAlternates).toEqual([]);
  });
});
