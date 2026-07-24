// Render-provenance derivation (#673/#964). isRenderedFetch is the single source of truth for "did the
// crawl browser-render this page?" — it drives BOTH the ax/content-without-js rule gate (PageData.rendered)
// and the render-prefetch per-page skip set (renderedPageUrlsFrom). Pin both here so a refactor can't quietly
// drop the derivation and re-render every page (the dead-gate class #673 hit — see the adapter doc comment).

import { describe, expect, test } from "bun:test";

import { isRenderedFetch, renderedPageUrlsFrom } from "@squirrelscan/audit-engine";

describe("isRenderedFetch", () => {
  test("true only for the browser-render fetcher ids", () => {
    expect(isRenderedFetch("cloud-render")).toBe(true); // CLI + container paid render
    expect(isRenderedFetch("browser")).toBe(true); // container browser-queue
  });

  test("false for raw HTTP, unknown, and absent fetcher ids", () => {
    expect(isRenderedFetch("fetch")).toBe(false); // raw / render-blocked fallback
    expect(isRenderedFetch("")).toBe(false);
    expect(isRenderedFetch("Browser")).toBe(false); // exact-match, case-sensitive
    expect(isRenderedFetch(undefined)).toBe(false);
    expect(isRenderedFetch(null)).toBe(false);
  });
});

describe("renderedPageUrlsFrom", () => {
  const pg = (url: string, fetcherId?: string | null) => ({ page: { url, fetcherId } });

  test("mixed crawl: only the browser-rendered page urls (an auto hybrid)", () => {
    const set = renderedPageUrlsFrom([
      pg("https://example.com/a", "browser"),
      pg("https://example.com/b", "fetch"),
      pg("https://example.com/c", "cloud-render"),
      pg("https://example.com/d", "fetch"),
      pg("https://example.com/e"), // undefined ⇒ raw
    ]);
    expect(set).toEqual(new Set(["https://example.com/a", "https://example.com/c"]));
  });

  test("all raw (pure HTTP crawl) ⇒ empty set ⇒ gate submits every page", () => {
    expect(
      renderedPageUrlsFrom([pg("https://example.com/a", "fetch"), pg("https://example.com/b")])
        .size,
    ).toBe(0);
  });

  test("all rendered (render:all crawl) ⇒ every url", () => {
    const set = renderedPageUrlsFrom([
      pg("https://example.com/a", "cloud-render"),
      pg("https://example.com/b", "browser"),
    ]);
    expect(set.size).toBe(2);
  });

  test("empty site context ⇒ empty set", () => {
    expect(renderedPageUrlsFrom([]).size).toBe(0);
  });
});
