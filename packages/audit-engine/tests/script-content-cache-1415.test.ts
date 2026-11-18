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

/** A valid cache entry, written out by hand so a change to the stored shape shows here. */
function entry(body: string): string {
  return JSON.stringify({
    v: 1,
    body,
    contentType: "application/javascript",
    contentEncoding: null,
    cacheHeaders: { cacheControl: null, expires: null, date: null, etag: null, lastModified: null },
    responseMs: 5,
  });
}

const storedBody = (raw: string | undefined) => (raw === undefined ? undefined : (JSON.parse(raw) as { body: string }).body);

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
    expect(second.every((r) => r.fromCache === true)).toBe(true);
  });

  test("a hit replays the content type, content-encoding, caching headers and response time", async () => {
    const headers = {
      "content-type": "text/javascript; charset=utf-8",
      "content-encoding": "gzip",
      "cache-control": "public, max-age=600",
      expires: "Wed, 18 Nov 2026 10:10:00 GMT",
      date: "Wed, 18 Nov 2026 10:00:00 GMT",
      etag: '"v1"',
      "last-modified": "Tue, 17 Nov 2026 10:00:00 GMT",
    };
    const gz = Bun.serve({
      port: 0,
      async fetch() {
        hits.push("gz");
        await Bun.sleep(15);
        return new Response(Bun.gzipSync(new TextEncoder().encode("var g=1;")), { headers });
      },
    });
    try {
      const contentCache = memoryCache();
      const url = `http://127.0.0.1:${gz.port}/g.js`;
      const once = async () => (await Effect.runPromise(fetchScriptContents([url], { contentCache })))[0]!;
      const first = await once();
      const second = await once();
      expect(hits).toEqual(["gz"]);
      expect(second.fromCache).toBe(true);
      expect(second.content).toBe("var g=1;");
      expect(second.contentType).toBe("text/javascript; charset=utf-8");
      expect(second.contentEncoding).toBe("gzip");
      expect(second.cacheHeaders).toEqual({
        cacheControl: "public, max-age=600",
        expires: "Wed, 18 Nov 2026 10:10:00 GMT",
        date: "Wed, 18 Nov 2026 10:00:00 GMT",
        etag: '"v1"',
        lastModified: "Tue, 17 Nov 2026 10:00:00 GMT",
      });
      expect(first.responseMs).toBeGreaterThanOrEqual(15);
      expect(second.responseMs).toBe(first.responseMs);
    } finally {
      gz.stop(true);
    }
  });

  test("an entry that is not a valid envelope (a bare body, a corrupt row) is a miss and is rewritten", async () => {
    const contentCache = memoryCache();
    contentCache.map.set(`${base}/a.js`, "var old=1;");
    contentCache.map.set(`${base}/b.js`, JSON.stringify({ v: 1, body: "var old=1;" }));
    const results = await run({ contentCache });
    expect(hits).toEqual(["/a.js", "/b.js"]);
    expect(results.every((r) => !r.fromCache && r.content === "var a=1;")).toBe(true);
    expect(storedBody(contentCache.map.get(`${base}/a.js`))).toBe("var a=1;");
    expect(storedBody(contentCache.map.get(`${base}/b.js`))).toBe("var a=1;");
  });

  test("a stale entry (cache returns null) is refetched and refreshed", async () => {
    const contentCache = memoryCache();
    await run({ contentCache });
    contentCache.map.clear();
    body = "var a=2;";
    const second = await run({ contentCache });
    expect(hits).toHaveLength(4);
    expect(second[0]?.content).toBe("var a=2;");
    expect(storedBody(contentCache.map.get(`${base}/a.js`))).toBe("var a=2;");
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
      contentCache.put(list[9]!, entry("var cached=1;"));
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

  test("a cache that throws degrades to a fetch", async () => {
    const contentCache: ScriptContentCache = {
      get: () => {
        throw new Error("db locked");
      },
      put: () => {
        throw new Error("db locked");
      },
    };
    const results = await run({ contentCache });
    expect(hits).toHaveLength(2);
    expect(results.every((r) => r.error === null && r.content === "var a=1;")).toBe(true);
  });

  test("a script that redirects and sends SourceMap is not cached, so a second run keeps both", async () => {
    const meta = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        hits.push(path);
        if (path === "/old.js") return Response.redirect(new URL("/new.js", request.url).href, 301);
        return new Response("var m=1;", {
          headers: { "content-type": "application/javascript", SourceMap: "/new.js.map" },
        });
      },
    });
    try {
      const contentCache = memoryCache();
      const url = `http://127.0.0.1:${meta.port}/old.js`;
      const once = () => Effect.runPromise(fetchScriptContents([url], { contentCache }));
      const first = await once();
      const second = await once();
      expect(contentCache.map.size).toBe(0);
      expect(hits).toEqual(["/old.js", "/new.js", "/old.js", "/new.js"]);
      for (const r of [first[0], second[0]]) {
        expect(r?.fromCache).toBeFalsy();
        expect(r?.redirected).toBe(true);
        expect(r?.finalUrl).toBe(`http://127.0.0.1:${meta.port}/new.js`);
        expect(r?.sourceMapHeader).toBe("/new.js.map");
      }
    } finally {
      meta.stop(true);
    }
  });

  test("a SourceMap header alone keeps the script out of the cache", async () => {
    const sm = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("var s=1;", {
          headers: { "content-type": "application/javascript", "X-SourceMap": "/s.js.map" },
        }),
    });
    try {
      const contentCache = memoryCache();
      const url = `http://127.0.0.1:${sm.port}/s.js`;
      await Effect.runPromise(fetchScriptContents([url], { contentCache }));
      const second = await Effect.runPromise(fetchScriptContents([url], { contentCache }));
      expect(contentCache.map.size).toBe(0);
      expect(second[0]?.sourceMapHeader).toBe("/s.js.map");
    } finally {
      sm.stop(true);
    }
  });

  test("a redirect alone keeps the script out of the cache", async () => {
    const rd = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/old.js") return Response.redirect(new URL("/new.js", request.url).href, 302);
        return new Response("var r=1;", { headers: { "content-type": "application/javascript" } });
      },
    });
    try {
      const contentCache = memoryCache();
      const url = `http://127.0.0.1:${rd.port}/old.js`;
      await Effect.runPromise(fetchScriptContents([url], { contentCache }));
      const second = await Effect.runPromise(fetchScriptContents([url], { contentCache }));
      expect(contentCache.map.size).toBe(0);
      expect(second[0]?.finalUrl).toBe(`http://127.0.0.1:${rd.port}/new.js`);
    } finally {
      rd.stop(true);
    }
  });

  test("anyContentType passes (manifests, stylesheets) bypass the cache", async () => {
    const contentCache = memoryCache();
    contentCache.put(`${base}/a.js`, entry("stale"));
    const results = await run({ contentCache, anyContentType: true });
    expect(hits).toHaveLength(2);
    expect(results[0]?.content).toBe("var a=1;");
    expect(contentCache.map.get(`${base}/a.js`)).toBe(entry("stale"));
  });
});
