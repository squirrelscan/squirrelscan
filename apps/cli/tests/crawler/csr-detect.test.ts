// Tests for the quick-mode HTTP-first hybrid CSR-shell detector (#294).
// Bias: low false positives — SSR/static pages must NOT be flagged.

import { describe, expect, test } from "bun:test";

import {
  extractVisibleText,
  looksClientRendered,
} from "../../src/crawl/csr-detect";

const CONTENT_PAGE = `<!doctype html><html><head><title>About</title></head>
<body>
  <header><nav>Home About Contact</nav></header>
  <main>
    <h1>About squirrelscan</h1>
    <p>squirrelscan is a website audit tool built for AI agents. It
    runs SEO, performance, and security checks across hundreds of rules and
    returns an LLM-optimized report with a health score and actionable fixes.</p>
    <p>This paragraph exists purely to push the visible text well past the
    shell threshold so a normal server-rendered page is never mistaken for a
    client-side-rendered shell.</p>
  </main>
  <footer>© squirrelscan</footer>
  <script src="/analytics.js"></script>
</body></html>`;

describe("looksClientRendered", () => {
  test("server-rendered content page is NOT flagged", () => {
    expect(looksClientRendered(CONTENT_PAGE)).toBe(false);
  });

  test("empty React root (#root) IS flagged", () => {
    const html = `<!doctype html><html><head><title>app</title></head>
<body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
    expect(looksClientRendered(html)).toBe(true);
  });

  test("empty #app / __next / app-root variants are flagged", () => {
    expect(
      looksClientRendered(
        `<body><div id="app"></div><script src="x.js"></script></body>`
      )
    ).toBe(true);
    expect(
      looksClientRendered(
        `<body><div id="__next"></div><script src="x.js"></script></body>`
      )
    ).toBe(true);
    expect(
      looksClientRendered(
        `<body><app-root></app-root><script src="x.js"></script></body>`
      )
    ).toBe(true);
  });

  test("FILLED SSR root (#__next with markup) is NOT flagged", () => {
    const html = `<body><div id="__next"><main><h1>Real SSR content here</h1>
    <p>${"server rendered text ".repeat(20)}</p></main></div>
    <script src="/_next/static/chunk.js"></script></body>`;
    expect(looksClientRendered(html)).toBe(false);
  });

  test("sparse body with scripts (no recognized root) IS flagged", () => {
    const html = `<!doctype html><html><body><div class="mount"></div>
    <script src="/a.js"></script><script src="/b.js"></script></body></html>`;
    expect(looksClientRendered(html)).toBe(true);
  });

  test("sparse body WITHOUT scripts is NOT flagged (e.g. a stub, not a JS app)", () => {
    const html = `<!doctype html><html><body><p>Coming soon.</p></body></html>`;
    expect(looksClientRendered(html)).toBe(false);
  });

  test("empty string is not flagged", () => {
    expect(looksClientRendered("")).toBe(false);
  });

  test("extractVisibleText strips scripts/styles/tags", () => {
    const text = extractVisibleText(
      `<body><style>.a{color:red}</style><h1>Hi</h1><script>var x=1</script><p>there</p></body>`
    );
    expect(text).toBe("Hi there");
  });
});
