// #422: an audit asks for robots.txt once. The RSL probe used to fetch it again
// to find `License:` directives and the `Link: rel=license` header; it now reuses
// the crawl's own read, and still finds both.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 5,
  concurrency: 1,
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
};

let robotsHits = 0;
let site: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/robots.txt") {
        robotsHits++;
        return new Response("User-agent: *\nAllow: /\nLicense: /license.xml\n", {
          headers: { "content-type": "text/plain", link: '</other-license.xml>; rel="license"' },
        });
      }
      if (pathname === "/license.xml" || pathname === "/other-license.xml") {
        return new Response('<?xml version="1.0"?><rsl xmlns="https://rslstandard.org/rsl"><content url="/"/></rsl>', {
          headers: { "content-type": "application/rsl+xml" },
        });
      }
      if (pathname === "/") {
        return new Response(
          '<!doctype html><html><head><title>Fixture</title></head><body><p>hello</p></body></html>',
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${site.port}`;
});

afterAll(() => site.stop(true));

describe("robots.txt is read once per crawl", () => {
  test("one request, and the RSL probe still sees the License: line and the Link header", async () => {
    robotsHits = 0;
    const storage = new SQLiteStorage(":memory:");
    const rsl = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawler = yield* createCrawler({ config: CONFIG, storage });
        const events = Effect.runFork(Stream.runForEach(crawler.events, (_e: CrawlerEvent) => Effect.void));
        const crawlId = yield* crawler.start(`${base}/`, `${base}/`);
        const record = yield* storage.getRsl(crawlId);
        yield* Fiber.interrupt(events);
        return record;
      }),
    );
    expect(robotsHits).toBe(1);
    expect(rsl?.licenseUrls.sort()).toEqual([`${base}/license.xml`, `${base}/other-license.xml`].sort());
    expect(rsl?.robotsHasLicense).toBe(true);
    expect(rsl?.linkHeaderPresent).toBe(true);
  });
});
