// #1255: a run that stores scripts fetches far more of them than an audit's own
// checks do, and every fetched body is held for the rules phase. The fetch is
// bounded by the decoded bytes it holds and by wall-clock time, and a script it
// never requested says why.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchScriptContents } from "../src/script-fetcher";

let server: ReturnType<typeof Bun.serve>;
let base: string;
const hits: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      hits.push(pathname);
      const delay = Number(searchParams.get("delay") ?? 0);
      if (delay > 0) await Bun.sleep(delay);
      return new Response(`var a="${pathname}";${"x".repeat(1024 * 1024)}`, {
        headers: { "content-type": "application/javascript" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));

const run = (urls: string[], options: Parameters<typeof fetchScriptContents>[1]) =>
  Effect.runPromise(fetchScriptContents(urls, { concurrency: 1, ...options }));

describe("script fetch bounds (#1255)", () => {
  test("fetchAll lifts the page-count share up to maxScripts", async () => {
    const urls = Array.from({ length: 15 }, (_, i) => `${base}/f${i}.js`);
    // pageCount 4 allows 10 by default
    expect(await run(urls, { pageCount: 4 })).toHaveLength(10);
    expect(await run(urls, { pageCount: 4, fetchAll: true, maxScripts: 15 })).toHaveLength(15);
  });

  test("the held-bytes cap stops requests and marks the rest memory-cap", async () => {
    hits.length = 0;
    const urls = Array.from({ length: 12 }, (_, i) => `${base}/m${i}.js`);
    const results = await run(urls, { fetchAll: true, maxScripts: 12, maxTotalBytes: 3 * 1024 * 1024 });
    const fetched = results.filter((r) => r.content !== null);
    const skipped = results.filter((r) => r.fetchSkipReason === "memory-cap");
    // each body is just over 1 MB: three reach the cap, the rest are never requested
    expect(fetched).toHaveLength(3);
    expect(skipped).toHaveLength(9);
    expect(skipped[0]).toMatchObject({ error: "skipped", status: null, content: null });
    expect(hits.filter((p) => p.startsWith("/m"))).toHaveLength(3);
  });

  test("the time budget stops requests and marks the rest time-budget", async () => {
    hits.length = 0;
    const urls = Array.from({ length: 8 }, (_, i) => `${base}/t${i}.js?delay=120`);
    const results = await run(urls, { fetchAll: true, maxScripts: 8, totalTimeoutMs: 300 });
    const skipped = results.filter((r) => r.fetchSkipReason === "time-budget");
    expect(skipped.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.content !== null).length).toBeGreaterThan(0);
    expect(hits.filter((p) => p.startsWith("/t")).length).toBeLessThan(8);
    expect(results.every((r) => r.content !== null || r.fetchSkipReason === "time-budget")).toBe(true);
  });

  test("with neither bound set nothing is skipped", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `${base}/n${i}.js`);
    const results = await run(urls, { fetchAll: true, maxScripts: 5 });
    expect(results.every((r) => r.content !== null && !r.fetchSkipReason)).toBe(true);
  });
});
