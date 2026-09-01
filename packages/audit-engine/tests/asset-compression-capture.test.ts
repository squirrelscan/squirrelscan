// End-to-end capture of `content-encoding` for perf/asset-compression (#9).
//
// The rule's own unit tests inject contentEncoding through fixtures, so they
// would still pass if the capture were deleted from the fetchers. These drive
// the REAL fetchers against a real local server and assert what actually lands
// in the record the rule reads — including the nginx-shaped case where a
// bodiless HEAD hides the compression that a GET reveals.

import { Effect } from "effect";
import { afterAll, describe, expect, test } from "bun:test";

import { checkResourceSizes } from "../src/resource-checker";
import { fetchScriptContents } from "../src/script-fetcher";

const BODY = "/* ".concat("x".repeat(300_000), " */");
const GZIPPED = Bun.gzipSync(new TextEncoder().encode(BODY));

/**
 * Routes, by path:
 *   /plain.*        uncompressed on every method
 *   /gzip.*         compressed, and says so on HEAD as well as GET
 *   /head-hides-gzip.css   the nginx shape: compression is a body filter, so the
 *                          bodiless HEAD carries NO Content-Encoding and the
 *                          UNCOMPRESSED Content-Length, while the GET is gzipped
 */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const isHead = req.method === "HEAD";
    const type = path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".png")
        ? "image/png"
        : "application/javascript";

    if (path.startsWith("/gzip")) {
      return new Response(isHead ? null : GZIPPED, {
        headers: {
          "content-type": type,
          "content-encoding": "gzip",
          "content-length": String(GZIPPED.length),
        },
      });
    }

    if (path === "/head-hides-gzip.css") {
      if (isHead) {
        return new Response(null, {
          headers: { "content-type": type, "content-length": String(BODY.length) },
        });
      }
      return new Response(GZIPPED, {
        headers: {
          "content-type": type,
          "content-encoding": "gzip",
          "content-length": String(GZIPPED.length),
        },
      });
    }

    return new Response(isHead ? null : BODY, {
      headers: { "content-type": type, "content-length": String(BODY.length) },
    });
  },
});

const base = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("script fetcher captures content-encoding (#9)", () => {
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
    // fetch decodes the body, so sizeBytes is the DECODED length while the
    // header survives — the property the whole rule depends on.
    expect(result?.sizeBytes).toBe(BODY.length);
  });
});

describe("resource checker captures content-encoding (#9)", () => {
  test("an uncompressed stylesheet records null", async () => {
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/plain.css`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe(null);
    expect(result?.sizeBytes).toBe(BODY.length);
  });

  test("a gzipped stylesheet records the coding", async () => {
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/gzip.css`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
  });

  test("a HEAD that hides gzip does NOT record a false null", async () => {
    // Without the fall-through added in #9 this returns contentEncoding null
    // and sizeBytes 300_009 — a textbook large-uncompressed-CSS finding against
    // a server that compresses perfectly well.
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/head-hides-gzip.css`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
  });

  test("a compressible type still short-circuits on a HEAD that names a coding", async () => {
    // The extra GET is confined to assets that would otherwise be misreported;
    // a HEAD carrying positive evidence must still take the shortcut.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return realFetch(input as string, init);
    }) as typeof fetch;
    try {
      await Effect.runPromise(checkResourceSizes([`${base}/gzip.css`]));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["HEAD"]);
  });

  test("a non-compressible type still short-circuits on HEAD", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return realFetch(input as string, init);
    }) as typeof fetch;
    try {
      await Effect.runPromise(checkResourceSizes([`${base}/plain.png`]));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["HEAD"]);
  });
});
