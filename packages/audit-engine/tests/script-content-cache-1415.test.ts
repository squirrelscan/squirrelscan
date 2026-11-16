// repo#1415 AC4: the optional injected script body cache. No cache: unchanged
// behaviour. With one: a hit never requests, a miss fetches and stores, and the
// capped read and the tarpit budget still apply.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createFetchBudget } from "../src/fetch-budget";
import { fetchScriptContents, type ScriptContentCache } from "../src/script-fetcher";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let hits: string[] = [];
let body = "var a=1;";

function memoryCache(): ScriptContentCache & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (url) => map.get(url) ?? null, put: (url, b) => void map.set(url, b) };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return new Response(body, { headers: { "content-type": "application/javascript" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));
beforeEach(() => {
  hits = [];
  body = "var a=1;";
});

const urls = () => [`${base}/a.js`, `${base}/b.js`];
const run = (opts: Parameters<typeof fetchScriptContents>[1]) =>
  Effect.runPromise(fetchScriptContents(urls(), { concurrency: 1, ...opts }));

describe("script content cache (repo#1415)", () => {
  test("no cache injected: every run fetches every script", async () => {
    await run({});
    await run({});
    expect(hits).toHaveLength(4);
  });

  test("second run replays cached bodies with 0 fetches", async () => {
    const contentCache = memoryCache();
    const first = await run({ contentCache });
    expect(hits).toHaveLength(2);
    expect(first.every((r) => !r.fromCache)).toBe(true);
    const second = await run({ contentCache });
    expect(hits).toHaveLength(2);
    expect(second.map((r) => r.content)).toEqual(["var a=1;", "var a=1;"]);
    expect(second.every((r) => r.fromCache === true && r.contentEncoding === undefined)).toBe(true);
  });

  test("a stale entry (cache returns null) is refetched and refreshed", async () => {
    const contentCache = memoryCache();
    await run({ contentCache });
    contentCache.map.clear();
    body = "var a=2;";
    const second = await run({ contentCache });
    expect(hits).toHaveLength(4);
    expect(second[0]?.content).toBe("var a=2;");
    expect(contentCache.map.get(`${base}/a.js`)).toBe("var a=2;");
  });

  test("failed fetches are not cached", async () => {
    const contentCache = memoryCache();
    const bad = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    try {
      await Effect.runPromise(fetchScriptContents([`http://127.0.0.1:${bad.port}/x.js`], { contentCache }));
      expect(contentCache.map.size).toBe(0);
    } finally {
      bad.stop(true);
    }
  });

  test("the capped read still applies: an oversized body is rejected and not cached", async () => {
    const contentCache = memoryCache();
    body = "a".repeat(5000);
    const results = await run({ contentCache, maxSizeBytes: 100 });
    expect(results[0]?.error).toBeTruthy();
    expect(contentCache.map.size).toBe(0);
  });

  test("a cached body over a lowered size cap is a miss", async () => {
    const contentCache = memoryCache();
    body = "a".repeat(500);
    await run({ contentCache });
    hits = [];
    const results = await run({ contentCache, maxSizeBytes: 100 });
    expect(hits).toHaveLength(2);
    expect(results[0]?.error).toBeTruthy();
  });

  test("the tarpit budget still skips uncached scripts, while hits spend none", async () => {
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(40);
        return new Response("var a=1;", { headers: { "content-type": "application/javascript" } });
      },
    });
    try {
      const slowBase = `http://127.0.0.1:${slow.port}`;
      const list = Array.from({ length: 10 }, (_, i) => `${slowBase}/t${i}.js`);
      const contentCache = memoryCache();
      contentCache.put(list[9]!, "var cached=1;");
      const budget = createFetchBudget({ tarpitLatencyMs: 10, tarpitStrikes: 2 });
      const results = await Effect.runPromise(
        fetchScriptContents(list, { concurrency: 1, fetchAll: true, maxScripts: 10, budget, contentCache }),
      );
      expect(budget.summary().skipped).toBeGreaterThan(0);
      expect(results[9]?.fromCache).toBe(true);
      expect(results[9]?.content).toBe("var cached=1;");
    } finally {
      slow.stop(true);
    }
  });
});
