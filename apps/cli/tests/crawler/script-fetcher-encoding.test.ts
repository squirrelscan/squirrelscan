// content-encoding capture in the CLI's script fetcher (#9).
//
// apps/cli/src/crawler/script-fetcher.ts is a FORK of the audit-engine fetcher,
// not a re-export, so the engine's capture test proves nothing about it. It also
// has a content-store cache the engine fork lacks — a cache hit never touches
// the network, so it must report the encoding as unknown rather than as absent.

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchScriptContents } from "@/crawler/script-fetcher";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";

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
});
