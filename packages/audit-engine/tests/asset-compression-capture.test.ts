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
 *   /range-hides-gzip.css  the CDN shape: compression is skipped for RANGE
 *                          requests specifically, so both the HEAD and the
 *                          ranged 206 look identity and only a plain GET is
 *                          gzipped
 *   /confirm-503.css       the same CDN shape, except the confirming GET is
 *                          rate-limited away — the encoding is unknowable
 */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const isHead = req.method === "HEAD";
    const isRanged = req.headers.get("range") !== null;
    const type = path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".png")
        ? "image/png"
        : "application/javascript";

    const gzipped = () =>
      new Response(isHead ? null : GZIPPED, {
        headers: {
          "content-type": type,
          "content-encoding": "gzip",
          "content-length": String(GZIPPED.length),
        },
      });

    const identity = () =>
      new Response(isHead ? null : BODY, {
        headers: { "content-type": type, "content-length": String(BODY.length) },
      });

    /** A 206 that answers the one-byte Range without any coding. */
    const partialIdentity = () =>
      new Response("x", {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": "1",
          "content-range": `bytes 0-0/${BODY.length}`,
        },
      });

    if (path.startsWith("/gzip")) return gzipped();

    if (path === "/head-hides-gzip.css") {
      return isHead ? identity() : gzipped();
    }

    if (path === "/range-hides-gzip.css") {
      if (isHead) return identity();
      return isRanged ? partialIdentity() : gzipped();
    }

    if (path === "/range-really-plain.css") {
      if (isHead) return identity();
      return isRanged ? partialIdentity() : identity();
    }

    // The asset IS gzipped, but the confirming GET never gets to say so.
    if (path === "/confirm-503.css") {
      if (isHead) return identity();
      return isRanged
        ? partialIdentity()
        : new Response("slow down", { status: 503 });
    }

    return identity();
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

/** Record the method + Range of every request one check makes. */
async function traceRequests(fn: () => Promise<unknown>): Promise<string[]> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const ranged = new Headers(init?.headers).get("range") !== null;
    calls.push(ranged ? `${method}(range)` : method);
    return realFetch(input as string, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

const VERIFY = { verifyCompression: true };

describe("resource checker captures content-encoding (#9)", () => {
  test("an uncompressed stylesheet records null", async () => {
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/plain.css`], VERIFY)
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe(null);
    expect(result?.sizeBytes).toBe(BODY.length);
  });

  test("a gzipped stylesheet records the coding", async () => {
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/gzip.css`], VERIFY)
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
  });

  test("a HEAD that hides gzip does NOT record a false null", async () => {
    // Without the HEAD fall-through this returns contentEncoding null and
    // sizeBytes 300_009 — a textbook large-uncompressed-CSS finding against a
    // server that compresses perfectly well.
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/head-hides-gzip.css`], VERIFY)
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
  });

  test("a ranged 206 that hides gzip does NOT record a false null", async () => {
    // The CDN shape: HEAD and the one-byte Range BOTH answer identity, and only
    // an ordinary GET reveals the coding.
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/range-hides-gzip.css`], VERIFY)
    );
    expect(result?.contentEncoding).toBe("gzip");
  });

  test("a genuinely uncompressed asset survives all three probes as null", async () => {
    // The counterpart to the case above: same request sequence, and the finding
    // must still be produced. Otherwise the fix would just silence the rule.
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/range-really-plain.css`], VERIFY)
    );
    expect(result?.contentEncoding).toBe(null);
    expect(result?.sizeBytes).toBe(BODY.length);
  });

  test("an unconfirmable 206 records unknown, NOT a false null", async () => {
    // The whole point of the confirming GET is that a ranged 206's missing
    // Content-Encoding proves nothing. So when that GET cannot answer — 429/503
    // from a rate-limiter, or a timeout on the AbortController it shares with
    // the two probes before it — falling back to the 206's own null would
    // report this gzipped asset as 300KB of uncompressed CSS: precisely the
    // false positive the verification exists to prevent.
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/confirm-503.css`], VERIFY)
    );
    expect(result?.contentEncoding).toBeUndefined();
  });

  test("an unconfirmable 206 still keeps its size for the other rules", async () => {
    // Only the encoding degrades to unknown. perf/css-file-size and
    // perf/total-byte-weight still need the size, so the record must survive.
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/confirm-503.css`], VERIFY)
    );
    expect(result?.sizeBytes).toBe(BODY.length);
    expect(result?.error).toBe(null);
  });

  test("verification costs at most one extra plain GET", async () => {
    const calls = await traceRequests(() =>
      Effect.runPromise(
        checkResourceSizes([`${base}/range-hides-gzip.css`], VERIFY)
      )
    );
    expect(calls).toEqual(["HEAD", "GET(range)", "GET"]);
  });
});

describe("resource checker keeps the cheap path when verification is off (#9)", () => {
  // The sitemap and PDF pools call the same checker but never report on
  // compression. text/html is compressible, so without the option gate every
  // sitemap URL would pay for the extra requests above.
  test("a compressible type short-circuits on HEAD by default", async () => {
    const calls = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/head-hides-gzip.css`]))
    );
    expect(calls).toEqual(["HEAD"]);
  });

  test("a compressible type still short-circuits on a HEAD that names a coding", async () => {
    // Even with verification on, a HEAD carrying positive evidence is enough.
    const calls = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/gzip.css`], VERIFY))
    );
    expect(calls).toEqual(["HEAD"]);
  });

  test("a non-compressible type short-circuits on HEAD even with verification on", async () => {
    const calls = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/plain.png`], VERIFY))
    );
    expect(calls).toEqual(["HEAD"]);
  });
});
