// repo#1415 AC4: a CLI re-audit reuses cached script bodies again. Run 1 vs run 2
// on an unchanged fixture, through the real content store adapter.

import { fetchScriptContents } from "@squirrelscan/audit-engine/script-fetcher";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "@/crawler/storage/content-store";
import {
  createScriptContentCache,
  SCRIPT_CACHE_MAX_AGE_MS,
} from "@/crawler/storage/script-cache";

let dir: string;
let store: ContentStore;
let server: ReturnType<typeof Bun.serve>;
let hits: string[];
let body: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "script-cache-1415-"));
  store = new ContentStore(join(dir, "content.db"));
  hits = [];
  body = "var a=1;";
  clock = Date.now();
  server = Bun.serve({
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return new Response(body, {
        headers: { "content-type": "application/javascript" },
      });
    },
  });
});
afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const urls = () =>
  [1, 2, 3].map((n) => `http://127.0.0.1:${server.port}/s${n}.js`);
const audit = (withCache: boolean) =>
  Effect.runPromise(
    fetchScriptContents(urls(), {
      concurrency: 1,
      ...(withCache
        ? {
            contentCache: createScriptContentCache(
              () => store,
              () => clock
            ),
          }
        : {}),
    })
  );

describe("CLI re-audit script cache (repo#1415)", () => {
  test("before: without a cache run 2 refetches all 3 scripts", async () => {
    await audit(false);
    await audit(false);
    expect(hits).toHaveLength(6);
  });

  test("after: run 1 fetches 3, run 2 of an unchanged site fetches 0", async () => {
    await audit(true);
    expect(hits).toHaveLength(3);
    const second = await audit(true);
    expect(hits).toHaveLength(3);
    expect(
      second.every((r) => r.fromCache === true && r.content === "var a=1;")
    ).toBe(true);
  });

  test("a changed script is refetched once the cache entry ages out", async () => {
    await audit(true);
    body = "var a=2;";
    clock += SCRIPT_CACHE_MAX_AGE_MS + 1000;
    const second = await audit(true);
    expect(hits).toHaveLength(6);
    expect(second[0]?.content).toBe("var a=2;");
    clock = Date.now(); // the refetch refreshed the entry
    await audit(true);
    expect(hits).toHaveLength(6);
  });
});
