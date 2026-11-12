// classifySitemapReadState: complete / partial / unreadable (#1651). A common-location 404 is not a
// failure; a failed robots.txt entry, a cap, a deadline or a missing index child is.

import { describe, expect, test } from "bun:test";

import type { SitemapData, SitemapFetchFailure } from "@squirrelscan/core-contracts";

import { classifySitemapReadState } from "../src/sitemaps";

const BASE = "https://example.com";

function sitemap(path: string, over: Partial<SitemapData> = {}): SitemapData {
  return {
    url: `${BASE}${path}`,
    type: "urlset",
    urls: [],
    childSitemaps: [],
    errors: [],
    urlCount: 0,
    ...over,
  };
}

function failure(path: string, source: SitemapFetchFailure["source"]): SitemapFetchFailure {
  return { url: `${BASE}${path}`, source, error: "HTTP 500" };
}

describe("classifySitemapReadState", () => {
  test("fully read, no cap, no failure: complete (common-location 404s do not count)", () => {
    const root = sitemap("/sitemap.xml");
    expect(
      classifySitemapReadState({
        discovered: [root],
        all: [root],
        failed: [failure("/sitemap_index.xml", "common")],
        truncated: false,
      }),
    ).toBe("complete");
  });

  test("a cap or deadline (truncated) is partial", () => {
    const root = sitemap("/sitemap.xml");
    expect(
      classifySitemapReadState({ discovered: [root], all: [root], failed: [], truncated: true }),
    ).toBe("partial");
  });

  test("an index child that never came back is partial", () => {
    const index = sitemap("/sitemap.xml", {
      type: "index",
      childSitemaps: [`${BASE}/products-1.xml`, `${BASE}/products-2.xml`],
    });
    const child = sitemap("/products-1.xml");
    expect(
      classifySitemapReadState({
        discovered: [index],
        all: [index, child],
        failed: [],
        truncated: false,
      }),
    ).toBe("partial");
  });

  test("a cross-host child is skipped on purpose, not a failure", () => {
    const index = sitemap("/sitemap.xml", {
      type: "index",
      childSitemaps: ["https://cdn.example.net/products.xml"],
    });
    expect(
      classifySitemapReadState({ discovered: [index], all: [index], failed: [], truncated: false }),
    ).toBe("complete");
  });

  test("a failed robots.txt entry next to a readable one is partial", () => {
    const root = sitemap("/sitemap.xml");
    expect(
      classifySitemapReadState({
        discovered: [root],
        all: [root],
        failed: [failure("/declared.xml", "robots.txt")],
        truncated: false,
      }),
    ).toBe("partial");
  });

  test("a declared sitemap that failed with nothing read is unreadable", () => {
    expect(
      classifySitemapReadState({
        discovered: [],
        all: [],
        failed: [failure("/declared.xml", "robots.txt")],
        truncated: false,
      }),
    ).toBe("unreadable");
  });

  test("no sitemap found and none declared has no state", () => {
    expect(
      classifySitemapReadState({
        discovered: [],
        all: [],
        failed: [failure("/sitemap.xml", "common")],
        truncated: false,
      }),
    ).toBeNull();
  });

  test("a walk that stopped before reading anything is unreadable, not absent", () => {
    expect(classifySitemapReadState({ discovered: [], all: [], failed: [], truncated: true })).toBe(
      "unreadable",
    );
  });
});
