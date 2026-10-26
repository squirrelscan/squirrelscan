// squirrelscan/squirrelscan#819: with `ownSiteOnly` (`squirrel audit --offline`)
// the crawl reaches the audited site and nothing else. Real loopback servers:
// `127.0.0.1` is the site, `localhost` is another host that reaches a second
// server, which records the `Host` of every request it gets. Each case asserts
// by that log that the other host got nothing, and has a control with the flag
// off where it does.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { SITEMAP_OFF_SITE_SKIPPED_ERROR } from "@squirrelscan/core-contracts/storage";
import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";
import type { RobotsTxtData } from "@squirrelscan/core-contracts";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { discoverSitemaps } from "../src/sitemaps";
import { SQLiteStorage } from "../src/storage/sqlite";

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

const html = (body: string) =>
  new Response(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

type Seen = { path: string; host: string | null };
const otherSeen: Seen[] = [];
let site: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let siteBase: string;

beforeAll(() => {
  other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      otherSeen.push({ path, host: req.headers.get("host") });
      if (path.endsWith(".xml")) {
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://localhost:${other.port}/a</loc></url></urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      return html("elsewhere");
    },
  });
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return html(`<a href="/about">About</a><a href="/go-away">Away</a>`);
      if (path === "/go-away") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://localhost:${other.port}/elsewhere` },
        });
      }
      if (path === "/about") return html("About us");
      if (path === "/moved-sitemap.xml") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://localhost:${other.port}/sitemap.xml` },
        });
      }
      if (path === "/seed-away") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://localhost:${other.port}/landed` },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  siteBase = `http://127.0.0.1:${site.port}`;
});

afterAll(() => {
  site.stop(true);
  other.stop(true);
});

beforeEach(() => {
  otherSeen.length = 0;
});

async function crawl(config: Partial<CrawlerConfig>, seed = "/") {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: { ...CONFIG, ...config }, storage });
      const events = Effect.runFork(
        Stream.runForEach(crawler.events, (_event: CrawlerEvent) => Effect.void),
      );
      const crawlId = yield* crawler.start(`${siteBase}${seed}`, `${siteBase}${seed}`);
      const pages = yield* storage.getPages(crawlId);
      yield* Fiber.interrupt(events);
      return pages;
    }),
  );
}

describe.each([
  ["the crawler's own fetch", {}],
  ["a document fetcher", { documentFetcher: createFetchDocumentFetcher() }],
] as const)("a page redirect to another host, via %s", (_name, fetcher) => {
  test("offline: it is recorded as the redirect it answered with, and the other host gets no request", async () => {
    const pages = await crawl({ ...fetcher, ownSiteOnly: true });

    expect(pages.find((p) => p.url === `${siteBase}/about`)?.status).toBe(200);
    expect(pages.find((p) => p.url === `${siteBase}/go-away`)?.status).toBe(302);
    expect(otherSeen).toEqual([]);
  });

  test("control: without the flag the redirect is followed, and the other host sees its own name", async () => {
    await crawl({ ...fetcher });

    expect(otherSeen.length).toBeGreaterThan(0);
    expect(otherSeen[0]?.host).toBe(`localhost:${other.port}`);
  });
});

describe("a start URL that redirects to another host", () => {
  test("offline: the seed redirect probe does not follow it", async () => {
    await crawl({ ownSiteOnly: true }, "/seed-away");
    expect(otherSeen).toEqual([]);
  });

  test("control: without the flag it does", async () => {
    await crawl({}, "/seed-away");
    expect(otherSeen.length).toBeGreaterThan(0);
  });
});

describe("a sitemap that robots.txt names on another host", () => {
  const robots = (sitemaps: string[]): RobotsTxtData => ({
    exists: true,
    url: `${siteBase}/robots.txt`,
    content: "",
    sizeBytes: 0,
    sitemaps,
    rules: [],
    errors: [],
  });
  const egress = (allowHost?: (host: string) => boolean) => ({
    allowPrivateNetwork: true,
    resolve: async () => ["127.0.0.1"],
    ...(allowHost ? { allowHost } : {}),
  });

  test("offline: it is not requested, and it is recorded as skipped, not as a failed fetch", async () => {
    const named = `http://localhost:${other.port}/sitemap.xml`;
    const result = await Effect.runPromise(
      discoverSitemaps(siteBase, robots([named]), "squirrel-test", {
        egress: egress((host) => host === "127.0.0.1"),
      }),
    );

    expect(otherSeen).toEqual([]);
    expect(result.discovered).toEqual([]);
    expect(result.failed.find((f) => f.url === named)).toEqual({
      url: named,
      source: "robots.txt",
      error: SITEMAP_OFF_SITE_SKIPPED_ERROR,
    });
  });

  test("offline: a sitemap on the site that redirects to another host is skipped too, not a failed fetch", async () => {
    const named = `${siteBase}/moved-sitemap.xml`;
    const result = await Effect.runPromise(
      discoverSitemaps(siteBase, robots([named]), "squirrel-test", {
        egress: egress((host) => host === "127.0.0.1"),
      }),
    );

    expect(otherSeen).toEqual([]);
    expect(result.failed.find((f) => f.url === named)?.error).toBe(SITEMAP_OFF_SITE_SKIPPED_ERROR);
  });

  test("control: without the restriction it is requested and read", async () => {
    const named = `http://localhost:${other.port}/sitemap.xml`;
    const result = await Effect.runPromise(
      discoverSitemaps(siteBase, robots([named]), "squirrel-test", { egress: egress() }),
    );

    expect(otherSeen.some((s) => s.path === "/sitemap.xml")).toBe(true);
    expect(result.discovered.map((s) => s.url)).toContain(named);
  });
});
