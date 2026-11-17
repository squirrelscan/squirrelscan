// A 304 revalidation on an incremental re-audit is a response seen on THIS crawl,
// and it carries the caching headers the asset is served with (RFC 9110 15.4.5).
// perf/bad-caching judges that record (repo#4492), so the checker must keep the
// 304's own Expires and Date, never a stale or missing value, on both the HEAD
// path and the ranged-GET path.

import { Effect } from "effect";
import { afterAll, describe, expect, test } from "bun:test";

import type { CachedResourceRecord } from "@squirrelscan/core-contracts";

import { checkResourceSizes } from "../src/resource-checker";

const EXPIRES = "Thu, 01 Jan 2099 00:00:00 GMT";
const DATE = "Tue, 17 Nov 2026 00:00:00 GMT";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (req.headers.get("if-none-match") === '"v1"') {
      return new Response(null, {
        status: 304,
        headers: { etag: '"v1"', "cache-control": "max-age=0", expires: EXPIRES, date: DATE },
      });
    }
    return new Response("body{}", { headers: { "content-type": "text/css", etag: '"v1"' } });
  },
});
afterAll(() => server.stop(true));

const base = `http://localhost:${server.port}`;

function prior(url: string): Map<string, CachedResourceRecord> {
  return new Map([
    [
      url,
      {
        url,
        type: "css",
        status: 200,
        error: null,
        contentType: "text/css",
        sizeBytes: 6,
        sourcePages: [],
        cacheControl: "max-age=0",
        etag: '"v1"',
        lastModified: null,
        vary: null,
        fetchedAt: Date.now() - 1_000,
      },
    ],
  ]);
}

describe("a 304 keeps the revalidation's own Expires and Date (repo#4492)", () => {
  test("HEAD path", async () => {
    const url = `${base}/a.css`;
    const [r] = await Effect.runPromise(checkResourceSizes([url], { priorByUrl: prior(url) }));
    expect(r).toMatchObject({ cacheReason: "304", cacheControl: "max-age=0", expires: EXPIRES, date: DATE });
  });

  test("ranged-GET path", async () => {
    const url = `${base}/b.png`;
    const [r] = await Effect.runPromise(
      checkResourceSizes([url], { priorByUrl: prior(url), readImageHeader: true })
    );
    expect(r).toMatchObject({ cacheReason: "304", cacheControl: "max-age=0", expires: EXPIRES, date: DATE });
  });
});
