// repo#1024: crawler-level proof of adaptive per-host ramp-up against a local origin.
// Measures peak in-flight requests at the origin and wall-clock crawl time.
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlerConfig } from "../src/core/types";

import { createCrawler } from "../src/core/crawler";
import { DEFAULT_RAMP_SUCCESSES } from "../src/host-backoff";

const LATENCY_MS = 25;
const CONFIGURED = 1;
const CEILING = 4;
// Enough pages for several ramp steps (one slot per DEFAULT_RAMP_SUCCESSES responses).
const PAGES = DEFAULT_RAMP_SUCCESSES * (CEILING + 1);

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(robots: string) {
  const state = { inFlight: 0, peak: 0 };
  const links = Array.from(
    { length: PAGES },
    (_, i) => `<a href="/p${i}">p${i}</a>`
  ).join("");
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/robots.txt") {
        return new Response(robots, {
          headers: { "content-type": "text/plain" },
        });
      }
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await Bun.sleep(LATENCY_MS);
      state.inFlight -= 1;
      return new Response(
        `<!doctype html><html><head><title>t</title></head><body>${path === "/" ? links : "x"}</body></html>`,
        { headers: { "content-type": "text/html" } }
      );
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}/`, state };
}

async function crawl(origin: string, extra: Partial<CrawlerConfig>) {
  const config: Partial<CrawlerConfig> = {
    maxPages: PAGES + 1,
    concurrency: 16,
    perHostConcurrency: CONFIGURED,
    delayMs: 0,
    perHostDelayMs: 0,
    timeoutMs: 5000,
    userAgent: "squirrel-test",
    respectRobots: true,
    incremental: false,
    useCacheControl: false,
    breadthFirst: false,
    coverageMode: "full",
    ...extra,
  };
  const crawler = await Effect.runPromise(createCrawler({ config }));
  const startedAt = Date.now();
  const crawlId = await Effect.runPromise(crawler.start(origin, origin));
  const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
  return { ms: Date.now() - startedAt, pages: pages.length };
}

describe("adaptive ramp-up in a real crawl (repo#1024)", () => {
  test("ramp-up reduces crawl time and never exceeds the ceiling", async () => {
    const flat = serve("");
    const flatOut = await crawl(flat.origin, {});
    expect(flat.state.peak).toBe(CONFIGURED);

    const ramped = serve("");
    const rampedOut = await crawl(ramped.origin, {
      maxPerHostConcurrency: CEILING,
    });

    expect(rampedOut.pages).toBe(flatOut.pages);
    expect(ramped.state.peak).toBeGreaterThan(CONFIGURED);
    expect(ramped.state.peak).toBeLessThanOrEqual(CEILING);
    expect(rampedOut.ms).toBeLessThan(flatOut.ms * 0.85);
  }, 60_000);

  test("a robots.txt Crawl-delay blocks the ramp", async () => {
    const polite = serve("User-agent: *\nCrawl-delay: 0.01\n");
    const out = await crawl(polite.origin, {
      maxPerHostConcurrency: CEILING,
      maxPages: DEFAULT_RAMP_SUCCESSES * 2,
    });
    expect(out.pages).toBeGreaterThan(DEFAULT_RAMP_SUCCESSES);
    expect(polite.state.peak).toBe(CONFIGURED);
  }, 60_000);
});
