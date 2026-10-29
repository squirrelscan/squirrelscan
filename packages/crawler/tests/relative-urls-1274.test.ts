// #1274: relative sitemap <loc> values and scheme-less links reached the rules
// as page URLs ("/pricing"), and six URL rules failed "Invalid URL" on every
// page. A page is stored and audited under an absolute URL, and a sitemap that
// ships relative <loc> values is told so.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { parseSitemap } from "../src/sitemaps";
import { SQLiteStorage } from "../src/storage/sqlite";

const SITEMAP_URL = "https://example.com/maps/sitemap.xml";
const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;

describe("parseSitemap with relative <loc> values", () => {
  test("a relative loc is resolved against the sitemap URL and reported", () => {
    const result = parseSitemap(urlset("/", "/pricing", "https://example.com/abs"), SITEMAP_URL);

    expect(result.urls.map((u) => u.loc)).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/abs",
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("2 <url> <loc> values are not an absolute URL");
    expect(result.errors[0]).toContain("/pricing");
  });

  test("a sitemap of absolute locs has no error", () => {
    const result = parseSitemap(urlset("https://example.com/a"), SITEMAP_URL);
    expect(result.errors).toEqual([]);
  });

  test("an index with a relative child is resolved and reported", () => {
    const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>/child.xml</loc></sitemap></sitemapindex>`;
    const result = parseSitemap(index, SITEMAP_URL);

    expect(result.childSitemaps).toEqual(["https://example.com/child.xml"]);
    expect(result.errors[0]).toContain("1 <sitemap> <loc> value is not an absolute URL");
  });
});

const html = (body: string) =>
  new Response(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

let site: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/sitemap.xml") {
        return new Response(urlset("/", "/pricing"), {
          headers: { "content-type": "application/xml" },
        });
      }
      if (path === "/") return html(`<a href="other-host.example.net/apps/x">x</a>`);
      if (path === "/pricing" || path.startsWith("/other-host")) return html("page");
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${site.port}`;
});

afterAll(() => site.stop(true));

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 20,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 3000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: true,
  coverageMode: "full",
  discoveryProbes: [],
};

describe("a crawl seeded by a relative-loc sitemap", () => {
  test("every stored page URL is absolute and parses", async () => {
    const storage = new SQLiteStorage(":memory:");
    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawler = yield* createCrawler({ config: CONFIG, storage });
        const events = Effect.runFork(
          Stream.runForEach(crawler.events, (_event: CrawlerEvent) => Effect.void),
        );
        const crawlId = yield* crawler.start(`${base}/`, `${base}/`);
        const stored = yield* storage.getPages(crawlId);
        yield* Fiber.interrupt(events);
        return stored;
      }),
    );

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(() => new URL(page.url)).not.toThrow();
    }
    expect(pages.map((p) => p.url)).toContain(`${base}/pricing`);
  });
});
