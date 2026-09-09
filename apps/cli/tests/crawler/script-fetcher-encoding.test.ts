// content-encoding capture in the CLI's script fetcher (#9).
//
// apps/cli/src/crawler/script-fetcher.ts is a FORK of the audit-engine fetcher,
// not a re-export, so the engine's capture test proves nothing about it. It also
// has a content-store cache the engine fork lacks — a cache hit never touches
// the network, so it must report the encoding as unknown rather than as absent.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCRIPT_CACHE_MAX_AGE_MS,
  fetchScriptContents,
} from "@/crawler/script-fetcher";
import {
  closeGlobalContentStore,
  getGlobalContentStore,
  hashContent,
} from "@/crawler/storage/content-store";

const BODY = `console.log(${JSON.stringify("x".repeat(2000))});`;
const GZIPPED = Bun.gzipSync(new TextEncoder().encode(BODY));
let cacheRouteRequests = 0;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/cache.js") {
      cacheRouteRequests++;
      return new Response(BODY, {
        headers: { "content-type": "application/javascript" },
      });
    }
    if (path === "/gzip.js") {
      return new Response(GZIPPED, {
        headers: {
          "content-type": "application/javascript",
          "content-encoding": "gzip",
          "content-length": String(GZIPPED.length),
        },
      });
    }
    return new Response(BODY, {
      headers: {
        "content-type": "application/javascript",
        "content-length": String(BODY.length),
      },
    });
  },
});

const base = `http://localhost:${server.port}`;
const cacheDir = mkdtempSync(join(tmpdir(), "squirrel-script-fetcher-"));
const priorContentStorePath = process.env.SQUIRREL_CONTENT_STORE_PATH;
process.env.SQUIRREL_CONTENT_STORE_PATH = join(cacheDir, "content.db");

afterAll(() => {
  server.stop(true);
  closeGlobalContentStore();
  if (priorContentStorePath === undefined) {
    delete process.env.SQUIRREL_CONTENT_STORE_PATH;
  } else {
    process.env.SQUIRREL_CONTENT_STORE_PATH = priorContentStorePath;
  }
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("CLI script fetcher content-encoding (#9)", () => {
  test("an uncompressed script records null — observed, and absent", async () => {
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/plain.js`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe(null);
  });

  test("a gzipped script records the coding, not null", async () => {
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/gzip.js`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
    // fetch decodes the body; the header survives and sizeBytes is the decoded
    // length. That mismatch is why the rule never judges size on a compressed
    // asset — it only ever reports assets with no coding at all.
    expect(result?.sizeBytes).toBe(BODY.length);
  });

  test("the second fetch of one URL is served from the content store", async () => {
    const url = `${base}/cache.js`;

    const [first] = await Effect.runPromise(fetchScriptContents([url]));
    const [second] = await Effect.runPromise(fetchScriptContents([url]));

    expect(first?.content).toBe(BODY);
    expect(first?.fromCache).not.toBe(true);
    expect(second?.content).toBe(BODY);
    expect(second?.fromCache).toBe(true);
    expect(second?.contentEncoding).toBeUndefined();
    expect(cacheRouteRequests).toBe(1);
  });

  // The store is shared by every audit on the machine and keyed by URL, so a
  // stable URL would otherwise be replayed forever (#182 follow-up).
  test("a cached script older than the max age is fetched again", async () => {
    const url = `${base}/cache.js`;
    const before = cacheRouteRequests;
    const store = getGlobalContentStore();
    const key = hashContent(url);
    expect(store.getMeta(key)).not.toBeNull();

    // Age the row past the ceiling with the same content still in place.
    store.putForKey(url, "stale body", "application/javascript");
    const db = new Database(store.getPath());
    db.prepare("UPDATE content SET created_at = ? WHERE hash = ?").run(
      Date.now() - SCRIPT_CACHE_MAX_AGE_MS - 1000,
      key
    );
    db.close();

    const [refreshed] = await Effect.runPromise(fetchScriptContents([url]));
    expect(refreshed?.fromCache).not.toBe(true);
    expect(refreshed?.content).toBe(BODY);
    expect(cacheRouteRequests).toBe(before + 1);

    // The refresh overwrote the stale row, so the next read is a fresh hit.
    expect(store.getString(key)).toBe(BODY);
    const [again] = await Effect.runPromise(fetchScriptContents([url]));
    expect(again?.fromCache).toBe(true);
    expect(cacheRouteRequests).toBe(before + 1);
  });
});
