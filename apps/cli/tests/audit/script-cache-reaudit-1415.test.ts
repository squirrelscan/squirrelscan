// repo#1415 AC4: a CLI re-audit of an unchanged site reuses cached script
// bodies. The cache was lost when the CLI's own script fetcher was folded into
// the engine's (a97f8085, #806); the engine now takes an injected cache that the
// CLI backs with its content store.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PageRecord } from "@/crawler/storage/types";

import { getDefaultConfig } from "@/config";
import { analyzeStoredCrawl } from "@/controllers/analyze";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
const priorStorePath = process.env.SQUIRREL_CONTENT_STORE_PATH;
const scriptHits: string[] = [];
let appBody = "window.squirrel = 1;";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith(".js")) scriptHits.push(path);
      return new Response(path === "/app.js" ? appBody : "window.vendor = 1;", {
        headers: {
          "content-type": "application/javascript",
          "cache-control": "public, max-age=600",
          etag: '"v1"',
        },
      });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  closeGlobalContentStore();
  dir = mkdtempSync(join(tmpdir(), "script-cache-1415-"));
  process.env.SQUIRREL_CONTENT_STORE_PATH = join(dir, "content-store.db");
  scriptHits.length = 0;
  appBody = "window.squirrel = 1;";
});

afterEach(() => {
  closeGlobalContentStore();
  if (priorStorePath === undefined)
    delete process.env.SQUIRREL_CONTENT_STORE_PATH;
  else process.env.SQUIRREL_CONTENT_STORE_PATH = priorStorePath;
  rmSync(dir, { recursive: true, force: true });
});

function page(url: string, html: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${url}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

/** One audit of the stored home page: the engine's asset phase, then the rules. */
function audit() {
  const html = `<!doctype html><html lang="en"><head><title>Home</title><script src="/app.js"></script><script src="/vendor.js"></script></head><body><p>Home</p></body></html>`;
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: base,
        seedUrl: `${base}/`,
        originalUrl: `${base}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {} as never,
      } as never);
      yield* storage.upsertPage(crawlId, page(`${base}/`, html));
      const crawl = (yield* storage.getCrawl(crawlId))!;
      const config = getDefaultConfig();
      const { assets } = yield* analyzeStoredCrawl(storage, crawl, {
        ...config,
        rules: { ...config.rules, enable: ["links/broken-links"] },
      });
      return assets.scripts;
    }).pipe(Effect.orDie)
  );
}

describe("a CLI re-audit reuses cached script bodies (repo#1415 AC4)", () => {
  test("run 1 fetches both scripts, run 2 of the unchanged site fetches none", async () => {
    const first = await audit();
    expect(scriptHits.sort()).toEqual(["/app.js", "/vendor.js"]);

    scriptHits.length = 0;
    const second = await audit();
    expect(scriptHits).toEqual([]);
    expect(second.map((s) => [s.url, s.content])).toEqual(
      first.map((s) => [s.url, s.content])
    );
    expect(second.every((s) => s.content !== null && s.error === null)).toBe(
      true
    );
    // The rules read the response metadata too: a replay keeps it, so the
    // caching, compression and render-blocking rules judge run 2 as run 1.
    const meta = (s: (typeof first)[number]) => [
      s.url,
      s.contentType,
      s.contentEncoding,
      s.cacheHeaders,
      s.responseMs,
    ];
    expect(second.map(meta)).toEqual(first.map(meta));
    expect(
      second.every(
        (s) =>
          s.contentEncoding === null &&
          s.cacheHeaders?.cacheControl === "public, max-age=600" &&
          s.cacheHeaders?.etag === '"v1"' &&
          typeof s.responseMs === "number"
      )
    ).toBe(true);
  });

  test("a changed script is fetched again once its cache entry is gone", async () => {
    await audit();
    // The 24 hour ceiling is what bounds a changed script at a stable URL.
    appBody = "window.squirrel = 2;";
    const { Database } = await import("bun:sqlite");
    const db = new Database(process.env.SQUIRREL_CONTENT_STORE_PATH!);
    db.run("UPDATE content SET created_at = created_at - 25 * 60 * 60 * 1000");
    db.close();
    scriptHits.length = 0;
    const scripts = await audit();
    expect(scriptHits).toContain("/app.js");
    expect(scripts.find((s) => s.url.endsWith("/app.js"))?.content).toBe(
      "window.squirrel = 2;"
    );
  });

  test("a script cached under a stale entry is fetched again", async () => {
    await audit();
    // Age every cached body past the 24 hour ceiling.
    const { Database } = await import("bun:sqlite");
    const db = new Database(process.env.SQUIRREL_CONTENT_STORE_PATH!);
    db.run("UPDATE content SET created_at = created_at - 25 * 60 * 60 * 1000");
    db.close();
    scriptHits.length = 0;
    await audit();
    expect(scriptHits.sort()).toEqual(["/app.js", "/vendor.js"]);
  });
});
