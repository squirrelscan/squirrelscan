// #1255: opt-in storage of the first-party scripts a crawl fetched. Bodies go to
// the content store (one row per distinct body), the index is per crawl and per
// URL, caps bound the work, and retention treats the bodies like stored HTML.

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { ContentStoreAdapter, StoredScriptInput } from "../src/storage";

import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

/** A content-addressed store that counts writes and touches. */
function fakeStore() {
  const rows = new Map<string, string>();
  const puts: string[] = [];
  const touched: string[] = [];
  const adapter: ContentStoreAdapter = {
    put(content) {
      const hash = createHash("sha256").update(content).digest("hex");
      puts.push(hash);
      rows.set(hash, content);
      return hash;
    },
    getString: (hash) => rows.get(hash) ?? null,
    has: (hash) => rows.has(hash),
    touch(hashes) {
      touched.push(...hashes);
      return hashes.length;
    },
  };
  return { adapter, rows, puts, touched };
}

async function freshStorage(store?: ContentStoreAdapter): Promise<SQLiteStorage> {
  const storage = new SQLiteStorage(":memory:", store);
  await run(storage.init());
  return storage;
}

const CRAWL = "crawl-1";
const script = (
  url: string,
  content: string | null,
  sourcePages: string[],
  over: Partial<StoredScriptInput> = {}
): StoredScriptInput => ({
  url,
  status: 200,
  content,
  sizeBytes: content === null ? null : Buffer.byteLength(content),
  sourcePages,
  ...over,
});
const LIMITS = { maxBytes: 1000, totalBytes: 10_000 };

describe("storeCrawlScripts", () => {
  test("every stored script is retrievable by URL for that crawl", async () => {
    const { adapter } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/a.js", "var a=1;", ["https://example.com/"]),
          script("https://example.com/b.js", "var b=2;", ["https://example.com/"]),
        ],
        LIMITS
      )
    );
    expect(await run(storage.getCrawlScriptBody(CRAWL, "https://example.com/a.js"))).toBe("var a=1;");
    expect(await run(storage.getCrawlScriptBody(CRAWL, "https://example.com/b.js"))).toBe("var b=2;");
    expect(await run(storage.getCrawlScriptBody(CRAWL, "https://example.com/c.js"))).toBeNull();
    expect(await run(storage.getCrawlScriptBody("other-crawl", "https://example.com/a.js"))).toBeNull();
  });

  test("identical bodies are stored once and every URL still resolves", async () => {
    const { adapter, puts, rows } = fakeStore();
    const storage = await freshStorage(adapter);
    const body = "var shared=1;".repeat(20);
    const summary = await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/v1/vendor.js", body, ["https://example.com/"]),
          script("https://example.com/v2/vendor.js", body, ["https://example.com/other"]),
        ],
        LIMITS
      )
    );
    expect(puts).toHaveLength(1);
    expect(rows.size).toBe(1);
    expect(summary).toMatchObject({ stored: 2, distinct: 1, skipped: 0 });
    expect(await run(storage.getCrawlScriptBody(CRAWL, "https://example.com/v2/vendor.js"))).toBe(body);
  });

  test("a second crawl with the same bundle adds no content-store row", async () => {
    const { adapter, rows } = fakeStore();
    const storage = await freshStorage(adapter);
    const s = script("https://example.com/a.js", "var a=1;", ["https://example.com/"]);
    await run(storage.storeCrawlScripts("crawl-1", [s], LIMITS));
    await run(storage.storeCrawlScripts("crawl-2", [s], LIMITS));
    expect(rows.size).toBe(1);
    expect(await run(storage.getCrawlScriptBody("crawl-2", s.url))).toBe("var a=1;");
  });

  test("the index links each script to the pages that load it", async () => {
    const { adapter } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/shared.js", "s", ["https://example.com/", "https://example.com/p2"]),
          script("https://example.com/only-p2.js", "o", ["https://example.com/p2"]),
        ],
        LIMITS
      )
    );
    const home = await run(storage.getCrawlScripts(CRAWL, { pageUrl: "https://example.com/" }));
    expect(home.map((r) => r.url)).toEqual(["https://example.com/shared.js"]);
    const p2 = await run(storage.getCrawlScripts(CRAWL, { pageUrl: "https://example.com/p2" }));
    expect(p2.map((r) => r.url)).toEqual(["https://example.com/only-p2.js", "https://example.com/shared.js"]);
    expect(p2[0]).toMatchObject({ status: "stored", skipReason: null, sizeBytes: 1 });
    expect(p2[0]?.contentHash).toBe(createHash("sha256").update("o").digest("hex"));
  });

  test("a script over the per-file cap is skipped with its size and never written", async () => {
    const { adapter, puts } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/big.js", "x".repeat(1500), ["https://example.com/"]),
          // body not kept by the fetcher, only its size
          script("https://example.com/huge.js", null, ["https://example.com/"], { sizeBytes: 9_000_000 }),
        ],
        LIMITS
      )
    );
    expect(puts).toHaveLength(0);
    const rows = await run(storage.getCrawlScripts(CRAWL));
    expect(rows).toEqual([
      expect.objectContaining({ url: "https://example.com/big.js", status: "skipped", skipReason: "too-large", sizeBytes: 1500, contentHash: null }),
      expect.objectContaining({ url: "https://example.com/huge.js", status: "skipped", skipReason: "too-large", sizeBytes: 9_000_000 }),
    ]);
  });

  test("the total cap bounds the distinct bytes; a shared bundle is not charged twice", async () => {
    const { adapter, puts } = fakeStore();
    const storage = await freshStorage(adapter);
    const a = "a".repeat(600);
    const summary = await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/1.js", a, ["https://example.com/"]),
          script("https://example.com/2.js", a, ["https://example.com/"]), // same body: free
          script("https://example.com/3.js", "b".repeat(600), ["https://example.com/"]),
          script("https://example.com/4.js", "c".repeat(600), ["https://example.com/"]), // 1800 > 1000
        ],
        { maxBytes: 1000, totalBytes: 1000 }
      )
    );
    expect(summary).toMatchObject({ stored: 2, skipped: 2, distinct: 1 });
    expect(puts).toHaveLength(1);
    const skipped = (await run(storage.getCrawlScripts(CRAWL))).filter((r) => r.status === "skipped");
    expect(skipped.map((r) => [r.url, r.skipReason, r.sizeBytes])).toEqual([
      ["https://example.com/3.js", "total-cap", 600],
      ["https://example.com/4.js", "total-cap", 600],
    ]);
  });

  test("failed fetches and bodiless small scripts leave no row", async () => {
    const { adapter } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/404.js", null, ["https://example.com/"], { status: 404 }),
          script("https://example.com/err.js", null, ["https://example.com/"], { status: null }),
          script("https://example.com/nobody.js", null, ["https://example.com/"], { sizeBytes: 100 }),
        ],
        LIMITS
      )
    );
    expect(await run(storage.getCrawlScripts(CRAWL))).toEqual([]);
  });

  test("a store that throws skips that script and keeps the audit going", async () => {
    const { adapter } = fakeStore();
    const failing: ContentStoreAdapter = {
      ...adapter,
      put(content, type) {
        if (content.includes("boom")) throw new Error("disk full");
        return adapter.put(content, type);
      },
    };
    const storage = await freshStorage(failing);
    const summary = await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/a.js", "boom", ["https://example.com/"]),
          script("https://example.com/b.js", "ok", ["https://example.com/"]),
        ],
        LIMITS
      )
    );
    expect(summary).toMatchObject({ stored: 1, skipped: 1 });
    expect((await run(storage.getCrawlScripts(CRAWL))).find((r) => r.url.endsWith("a.js"))?.skipReason).toBe("store-error");
  });

  test("without a content store nothing is stored or indexed", async () => {
    const storage = await freshStorage();
    const summary = await run(
      storage.storeCrawlScripts(CRAWL, [script("https://example.com/a.js", "a", [])], LIMITS)
    );
    expect(summary).toEqual({ stored: 0, skipped: 0, skippedByReason: {}, distinct: 0, distinctBytes: 0 });
    expect(await run(storage.getCrawlScripts(CRAWL))).toEqual([]);
  });

  test("retention keeps the stored bodies: retainPageBodies touches their hashes", async () => {
    const { adapter, touched } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/a.js", "alpha", ["https://example.com/"]),
          script("https://example.com/b.js", "alpha", ["https://example.com/"]),
          script("https://example.com/c.js", "gamma", ["https://example.com/"]),
        ],
        LIMITS
      )
    );
    await run(storage.retainPageBodies(CRAWL));
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    expect([...new Set(touched)].sort()).toEqual([hash("alpha"), hash("gamma")].sort());
  });

  test("many 5 MB bundles: work stops at the total cap, identical ones are hashed not written", async () => {
    const { adapter, puts } = fakeStore();
    const storage = await freshStorage(adapter);
    const mb5 = 5 * 1024 * 1024;
    const bundles: StoredScriptInput[] = [];
    // 20 distinct 5 MB bodies, then 20 copies of the first: 200 MB of input.
    for (let i = 0; i < 20; i++) {
      bundles.push(script(`https://example.com/d${i}.js`, String.fromCharCode(97 + (i % 26)).repeat(mb5 - i), ["https://example.com/"]));
    }
    for (let i = 0; i < 20; i++) bundles.push(script(`https://example.com/c${i}.js`, bundles[0]!.content, ["https://example.com/"]));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const summary = await run(
      storage.storeCrawlScripts(CRAWL, bundles, { maxBytes: mb5, totalBytes: 16 * 1024 * 1024 })
    );
    const elapsed = performance.now() - started;
    expect(summary.distinct).toBe(3); // 15 MB of distinct bodies under the 16 MB cap
    expect(puts).toHaveLength(3);
    expect(summary.stored).toBe(3 + 20); // the 20 copies share the first body
    expect(elapsed).toBeLessThan(15_000);
    // nothing is retained by the storage call itself
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
  });

  test("a 200 that is an HTML page behind a script URL is skipped as not-javascript", async () => {
    const { adapter, puts } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/spa.js", "<!DOCTYPE html><html><body>app</body></html>", ["https://example.com/"]),
          script("https://example.com/ok.js", "var ok=1;", ["https://example.com/"]),
        ],
        LIMITS
      )
    );
    expect(puts).toHaveLength(1);
    const rows = await run(storage.getCrawlScripts(CRAWL));
    expect(rows.find((r) => r.url.endsWith("spa.js"))).toMatchObject({ status: "skipped", skipReason: "not-javascript" });
  });

  test("a redirected script keeps its final URL and resolves by either", async () => {
    const { adapter } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [script("https://example.com/old.js", "var moved=1;", ["https://example.com/"], { finalUrl: "https://cdn.example.com/new.js" })],
        LIMITS
      )
    );
    expect((await run(storage.getCrawlScripts(CRAWL)))[0]?.finalUrl).toBe("https://cdn.example.com/new.js");
    expect(await run(storage.getCrawlScriptBody(CRAWL, "https://example.com/old.js"))).toBe("var moved=1;");
    expect(await run(storage.getCrawlScriptBody(CRAWL, "https://cdn.example.com/new.js"))).toBe("var moved=1;");
  });

  test("a stored script whose body the content store dropped reads as evicted", async () => {
    const { adapter, rows } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [script("https://example.com/a.js", "var a=1;", ["https://example.com/"]), script("https://example.com/b.js", "var b=2;", ["https://example.com/"])],
        LIMITS
      )
    );
    expect((await run(storage.getCrawlScripts(CRAWL))).map((r) => r.evicted)).toEqual([false, false]);
    rows.delete([...rows.keys()][0]!);
    const after = await run(storage.getCrawlScripts(CRAWL));
    expect(after.filter((r) => r.evicted)).toHaveLength(1);
    expect(after.every((r) => r.status === "stored")).toBe(true);
  });

  test("the fetch summary records what the script fetch limit left out", async () => {
    const { adapter } = fakeStore();
    const storage = await freshStorage(adapter);
    expect(await run(storage.getCrawlScriptsSummary(CRAWL))).toBeNull();
    await run(
      storage.storeCrawlScripts(CRAWL, [script("https://example.com/a.js", "a", [])], LIMITS, {
        fetchLimit: 12,
        droppedByLimit: 13,
      })
    );
    expect(await run(storage.getCrawlScriptsSummary(CRAWL))).toEqual({ fetchLimit: 12, droppedByLimit: 13 });
  });

  test("scripts the fetch never requested are recorded with the reason and no size", async () => {
    const { adapter, puts } = fakeStore();
    const storage = await freshStorage(adapter);
    await run(
      storage.storeCrawlScripts(
        CRAWL,
        [
          script("https://example.com/a.js", null, ["https://example.com/"], { status: null, fetchSkipReason: "memory-cap" }),
          script("https://example.com/b.js", null, ["https://example.com/"], { status: null, fetchSkipReason: "time-budget" }),
        ],
        LIMITS
      )
    );
    expect(puts).toHaveLength(0);
    expect((await run(storage.getCrawlScripts(CRAWL))).map((r) => [r.url, r.status, r.skipReason, r.sizeBytes])).toEqual([
      ["https://example.com/a.js", "skipped", "memory-cap", null],
      ["https://example.com/b.js", "skipped", "time-budget", null],
    ]);
  });
});
