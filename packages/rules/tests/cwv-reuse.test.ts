import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { getCWVHints } from "../src/performance/cwv";

const HTML = `<!doctype html><html><head>
<style>@font-face { font-family: 'Foo'; src: url(foo.woff2); }</style>
<link rel="stylesheet" href="/a.css">
<script src="/blocking.js"></script>
</head><body>
<img src="/hero.jpg">
<img src="/sized.jpg" width="100" height="50">
</body></html>`;

const URL = "https://example.com/";

describe("CWV hints reuse + memoization (#262)", () => {
  test("derives hints from a pre-parsed document (no internal parse)", () => {
    const { document } = parseHTML(HTML);
    const hints = getCWVHints(document, HTML, URL);
    // @font-face without font-display → still detected via the raw-html regex
    expect(hints.fontsWithoutSwap).toContain("Foo");
    // CLS: image without dimensions flagged, sized image not
    expect(hints.imagesWithoutDimensions).toContain("/hero.jpg");
    expect(hints.imagesWithoutDimensions).not.toContain("/sized.jpg");
    // render-blocking stylesheet + script in <head>
    expect(hints.renderBlockingResources.length).toBeGreaterThan(0);
  });

  test("getCWVHints memoizes on document identity (the 6 CWV rules share one result)", () => {
    const { document } = parseHTML(HTML);
    const a = getCWVHints(document, HTML, URL);
    const b = getCWVHints(document, HTML, URL);
    expect(b).toBe(a); // same reference → computed once, not 6x
  });

  test("returned hints are frozen (a rule can't corrupt the shared cache)", () => {
    const { document } = parseHTML(HTML);
    const hints = getCWVHints(document, HTML, URL);
    expect(Object.isFrozen(hints)).toBe(true);
    expect(Object.isFrozen(hints.fontsWithoutSwap)).toBe(true);
    expect(() => {
      (hints.fontsWithoutSwap as string[]).push("oops");
    }).toThrow();
  });

  test("distinct documents get distinct hints (no cross-page leakage)", () => {
    const d1 = parseHTML(HTML).document;
    const d2 = parseHTML("<!doctype html><html><body></body></html>").document;
    const h1 = getCWVHints(d1, HTML, URL);
    const h2 = getCWVHints(d2, "", URL);
    expect(h2).not.toBe(h1);
    expect(h2.fontsWithoutSwap).toEqual([]);
  });

  test("null document + empty html short-circuits to empty hints (no throw)", () => {
    const hints = getCWVHints(null, "", URL);
    expect(hints.fontsWithoutSwap).toEqual([]);
    expect(hints.totalScripts).toBe(0);
  });

  test("null document + non-empty html is memoized on (pageUrl, html) (#309)", () => {
    const a = getCWVHints(null, HTML, URL);
    expect(a.fontsWithoutSwap).toContain("Foo"); // derived from the parse
    const b = getCWVHints(null, HTML, URL);
    expect(b).toBe(a); // same (url, html) → parsed once, shared across the 6 CWV rules
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("null-doc memo keys on pageUrl too — same body, different URL ≠ same entry (#309)", () => {
    const a = getCWVHints(null, HTML, URL);
    const c = getCWVHints(null, HTML, "https://other.example.org/404");
    expect(c).not.toBe(a); // pageUrl is part of the key (hints depend on page domain)
  });

  test("null-doc memo evicts the oldest entry past its 32-entry cap (#309)", () => {
    const first = getCWVHints(null, HTML, "https://evict-0.example.com/");
    // 32 more distinct URLs (same body) can't coexist with the first under a 32 cap.
    for (let i = 1; i <= 32; i++) {
      getCWVHints(null, HTML, `https://evict-${i}.example.com/`);
    }
    const firstAgain = getCWVHints(null, HTML, "https://evict-0.example.com/");
    expect(firstAgain).not.toBe(first); // evicted → recomputed with a fresh identity
  });
});
