// #422: sitemap fetches obey per_host_concurrency and per_host_delay_ms, like the
// crawl's pages and the discovery probes. The walk used to fetch its guessed
// locations five at a time whatever the setting said.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 3,
  concurrency: 4,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 5000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: true,
  coverageMode: "quick",
  discoveryProbes: [],
};

let inFlight = 0;
let maxInFlight = 0;
const sitemapPaths: string[] = [];
let site: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (/sitemap/i.test(pathname)) {
        sitemapPaths.push(pathname);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(40);
        inFlight--;
        return new Response("not found", { status: 404 });
      }
      if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
      if (pathname === "/") {
        return new Response("<!doctype html><html><head><title>F</title></head><body>hi</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${site.port}`;
});

afterAll(() => site.stop(true));

async function crawl(config: Partial<CrawlerConfig>): Promise<void> {
  inFlight = 0;
  maxInFlight = 0;
  sitemapPaths.length = 0;
  const storage = new SQLiteStorage(":memory:");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: { ...CONFIG, ...config }, storage });
      const events = Effect.runFork(Stream.runForEach(crawler.events, (_e: CrawlerEvent) => Effect.void));
      yield* crawler.start(`${base}/`, `${base}/`);
      yield* Fiber.interrupt(events);
    }),
  );
}

describe("sitemap discovery and per-host limits", () => {
  test("per_host_concurrency = 1 sends the guessed sitemap locations one at a time", async () => {
    await crawl({ perHostConcurrency: 1 });
    expect(sitemapPaths.length).toBeGreaterThan(5);
    expect(maxInFlight).toBe(1);
  });

  test("control: a higher limit lets them overlap", async () => {
    await crawl({ perHostConcurrency: 5 });
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("per_host_delay_ms spaces them", async () => {
    const started = Date.now();
    await crawl({ perHostConcurrency: 1, perHostDelayMs: 60 });
    // Every request after the first waits at least the delay: well over what 40 ms of work alone takes.
    const spent = Date.now() - started;
    expect(spent).toBeGreaterThanOrEqual((sitemapPaths.length - 1) * 60 * 0.8);
  });
});
