// Tests for sitemap URL ingestion cap (huge-site protection)
// A 410k-URL sitemap index (e.g. techcrunch.com) must not be fetched or
// enqueued wholesale when maxPages is small.

import type { SitemapData } from "@squirrelscan/core-contracts";

import {
  computeSitemapUrlCap,
  discoverSitemaps,
  fetchSitemapsRecursive,
  selectSitemapUrls,
} from "@squirrelscan/crawler/sitemaps";
import { describe, it, expect, afterEach } from "bun:test";
import { Effect } from "effect";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const urlsetXml = (sitemapIndex: number, count: number): string => {
  const urls = Array.from(
    { length: count },
    (_, i) =>
      `<url><loc>https://example.com/section-${sitemapIndex}/post-${i}</loc></url>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
};

const indexXml = (childCount: number): string => {
  const children = Array.from(
    { length: childCount },
    (_, i) => `<sitemap><loc>https://example.com/child-${i}.xml</loc></sitemap>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`;
};

/**
 * Stub fetch serving a sitemap index with `childCount` children of
 * `urlsPerChild` URLs each. Everything else 404s. Records fetched URLs.
 */
const stubSitemapSite = (childCount: number, urlsPerChild: number) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);

    if (url === "https://example.com/sitemap.xml") {
      return new Response(indexXml(childCount), { status: 200 });
    }
    const childMatch = url.match(/\/child-(\d+)\.xml$/);
    if (childMatch) {
      return new Response(urlsetXml(Number(childMatch[1]), urlsPerChild), {
        status: 200,
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return calls;
};

describe("computeSitemapUrlCap", () => {
  it("is 10x maxPages with a floor of 1000", () => {
    expect(computeSitemapUrlCap(100)).toBe(1000);
    expect(computeSitemapUrlCap(25)).toBe(1000);
    expect(computeSitemapUrlCap(500)).toBe(5000);
  });
});

describe("fetchSitemapsRecursive URL budget", () => {
  it("stops fetching sitemap-index children once the budget is exhausted", async () => {
    // 200 children x 200 URLs = 40k URLs total
    const calls = stubSitemapSite(200, 200);

    const results = await Effect.runPromise(
      fetchSitemapsRecursive(
        ["https://example.com/sitemap.xml"],
        "test-agent",
        3,
        0,
        new Set(),
        { remaining: 1000 }
      )
    );

    const childFetches = calls.filter((url) => url.includes("/child-"));
    // Budget of 1000 at 200 URLs/child = 5 children; chunked fetching may
    // overshoot by at most one concurrency chunk (5), never all 200.
    expect(childFetches.length).toBeGreaterThanOrEqual(5);
    expect(childFetches.length).toBeLessThanOrEqual(10);

    const parsedUrls = results
      .filter((r) => r.success)
      .reduce((sum, r) => sum + (r.success ? r.data.urlCount : 0), 0);
    expect(parsedUrls).toBeGreaterThanOrEqual(1000);
    expect(parsedUrls).toBeLessThanOrEqual(2000);
  });

  it("fetches everything when no budget is given", async () => {
    const calls = stubSitemapSite(20, 50);

    await Effect.runPromise(
      fetchSitemapsRecursive(["https://example.com/sitemap.xml"], "test-agent")
    );

    const childFetches = calls.filter((url) => url.includes("/child-"));
    expect(childFetches.length).toBe(20);
  });
});

describe("discoverSitemaps maxUrls option", () => {
  it("respects maxUrls across discovery", async () => {
    const calls = stubSitemapSite(100, 200);

    const result = await Effect.runPromise(
      discoverSitemaps("https://example.com", null, "test-agent", {
        maxUrls: 1000,
      })
    );

    const childFetches = calls.filter((url) => url.includes("/child-"));
    expect(childFetches.length).toBeLessThanOrEqual(10);

    const totalUrls = result.all.reduce((sum, s) => sum + s.urlCount, 0);
    expect(totalUrls).toBeLessThanOrEqual(2000);
  });
});

describe("selectSitemapUrls", () => {
  const sitemap = (url: string, locs: string[]): SitemapData => ({
    url,
    type: "urlset",
    urls: locs.map((loc) => ({ loc })),
    childSitemaps: [],
    errors: [],
    urlCount: locs.length,
  });

  it("caps total selected URLs", () => {
    const sitemaps = [
      sitemap(
        "https://example.com/a.xml",
        Array.from({ length: 500 }, (_, i) => `https://example.com/a/${i}`)
      ),
      sitemap(
        "https://example.com/b.xml",
        Array.from({ length: 500 }, (_, i) => `https://example.com/b/${i}`)
      ),
    ];

    const selected = selectSitemapUrls(sitemaps, 100);
    expect(selected.length).toBe(100);
  });

  it("round-robins across sitemaps for section diversity", () => {
    const sitemaps = [
      sitemap(
        "https://example.com/a.xml",
        Array.from({ length: 50 }, (_, i) => `https://example.com/a/${i}`)
      ),
      sitemap(
        "https://example.com/b.xml",
        Array.from({ length: 50 }, (_, i) => `https://example.com/b/${i}`)
      ),
      sitemap(
        "https://example.com/c.xml",
        Array.from({ length: 50 }, (_, i) => `https://example.com/c/${i}`)
      ),
    ];

    const selected = selectSitemapUrls(sitemaps, 30);
    expect(selected.length).toBe(30);
    const bySection = { a: 0, b: 0, c: 0 };
    for (const url of selected) {
      const section = url.loc.split("/")[3] as "a" | "b" | "c";
      bySection[section]++;
    }
    // Equal sampling: 10 from each section, not 30 from the first
    expect(bySection.a).toBe(10);
    expect(bySection.b).toBe(10);
    expect(bySection.c).toBe(10);
  });

  it("deduplicates URLs that appear in multiple sitemaps", () => {
    const sitemaps = [
      sitemap("https://example.com/a.xml", ["https://example.com/page"]),
      sitemap("https://example.com/b.xml", ["https://example.com/page"]),
    ];

    const selected = selectSitemapUrls(sitemaps, 10);
    expect(selected.length).toBe(1);
  });

  it("returns all URLs when under the cap", () => {
    const sitemaps = [
      sitemap("https://example.com/a.xml", [
        "https://example.com/1",
        "https://example.com/2",
      ]),
    ];

    const selected = selectSitemapUrls(sitemaps, 1000);
    expect(selected.length).toBe(2);
  });
});
