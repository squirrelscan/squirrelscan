// repo#4765 end to end: a site drops its X-Robots-Tag noindex and leaves its
// HTML alone. The next incremental audit refetches the page, sees the same body
// and reuses the stored record (a hash match, or the origin's 304). It reused
// the stored HEADERS with it, so core/robots-meta reported "noindex via
// X-Robots-Tag header" from a response the site no longer sent.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

import { runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const HTML =
  '<!doctype html><html lang="en"><head><meta name="robots" content="index, follow"><title>About the nut shop</title></head><body><h1>About</h1></body></html>';
const ETAG = '"about-v1"';

const CONFIG = {
  rule_options: {},
  rules: { enable: ["core/robots-meta"] },
  crawler: { max_pages: 1, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

/**
 * A one-page site whose X-Robots-Tag can change between audits. `etag` makes
 * it answer a conditional GET with a 304 that resends its current headers;
 * without it every refetch is a 200 whose body matches the stored one.
 */
function site(opts: { etag: boolean }) {
  const state = { robots: "noindex, nofollow" as string | null, notModified: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      if (state.robots) headers["x-robots-tag"] = state.robots;
      if (opts.etag) {
        headers.etag = ETAG;
        if (req.headers.get("if-none-match") === ETAG) {
          state.notModified++;
          return new Response(null, { status: 304, headers });
        }
      }
      return new Response(HTML, { headers });
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, state };
}

/** One incremental audit of the site against the shared store. */
async function audit(storage: SQLiteStorage, origin: string) {
  const crawler = await Effect.runPromise(
    createCrawler({
      storage,
      config: {
        maxPages: 1,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: true,
        useCacheControl: false,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      return yield* runStreamingRules(storage, crawlId, CONFIG, pre.assets);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  const checks = (ran.ruleResultsMap.get("core/robots-meta")?.checks ?? []) as CheckResult[];
  const stats = await Effect.runPromise(storage.getStats(crawlId));
  const [page] = await Effect.runPromise(storage.getPages(crawlId));
  return { checks, stats, page };
}

const viaHeader = (checks: CheckResult[]) =>
  checks.filter((c) => c.status !== "pass" && /X-Robots-Tag/.test(c.message ?? ""));

describe("core/robots-meta after a site drops its X-Robots-Tag (repo#4765)", () => {
  test("200 with an unchanged body (hash match): audit 2 has no noindex finding", async () => {
    const { origin, state } = site({ etag: false });
    const storage = new SQLiteStorage(":memory:");
    await Effect.runPromise(storage.init());

    const first = await audit(storage, origin);
    expect(viaHeader(first.checks).length).toBeGreaterThan(0);

    state.robots = null;
    const second = await audit(storage, origin);
    // The body was reused, not refetched into a new record...
    expect(second.stats?.cacheHitsByReason?.hash_match).toBe(1);
    // ...and the headers are the second response's.
    expect(second.page?.securityHeaders.xRobotsTag).toBeNull();
    expect(viaHeader(second.checks)).toEqual([]);
  });

  test("the origin's own 304 updates the headers it resends: audit 2 has no noindex finding", async () => {
    const { origin, state } = site({ etag: true });
    const storage = new SQLiteStorage(":memory:");
    await Effect.runPromise(storage.init());

    const first = await audit(storage, origin);
    expect(viaHeader(first.checks).length).toBeGreaterThan(0);

    // The site now allows indexing and says so on every response, 304s included.
    state.robots = "index, follow";
    const second = await audit(storage, origin);
    expect(state.notModified).toBe(1);
    expect(second.stats?.cacheHitsByReason?.["304"]).toBe(1);
    expect(second.page?.securityHeaders.xRobotsTag).toBe("index, follow");
    expect(viaHeader(second.checks)).toEqual([]);
  });
});
