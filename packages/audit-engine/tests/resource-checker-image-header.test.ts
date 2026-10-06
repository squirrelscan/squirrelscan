// The image pool's header read (#470), against a real local server.
//
// The pool used to send a HEAD (falling back to `Range: bytes=0-0`) and read
// no body. It now sends ONE ranged GET for the first 32 KiB, takes the size
// from Content-Range, and parses the natural size from the bytes. These drive
// the real checker and assert the request shape, the transfer cap when a
// server ignores Range, and the cache paths that carry or re-probe the size.

import { Effect } from "effect";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CachedResourceRecord } from "@squirrelscan/core-contracts";
import { RESOURCE_SIZE_LIMITS } from "@squirrelscan/utils/constants";

import { checkResourceSizes } from "../src/resource-checker";

const CAP = RESOURCE_SIZE_LIMITS.IMAGE_HEADER_BYTES;
const FIXTURES = join(import.meta.dir, "fixtures", "image-header");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** A real PNG header padded out to `size` bytes; only the header is ever parsed. */
function paddedPng(size: number): Uint8Array<ArrayBuffer> {
  const file = new Uint8Array(size);
  file.set(fixture("static-37x23.png"));
  return file;
}

const BIG = paddedPng(1024 * 1024);
const SMALL_GIF = fixture("animated-20x10.gif");
const WEBP = fixture("animated-24x18.webp");

/**
 * A raw TCP server that ignores Range and sends BIG with its Content-Length, in
 * 8 KiB writes 2 ms apart, counting what the kernel accepted. Raw because the
 * two easier servers cannot measure this: Bun.serve sends a stream body chunked
 * whatever Content-Length says, and node:http buffers writes app-side. A path
 * containing "missing" answers 404 with the same 1 MB as its error page.
 */
const noRange = { written: 0, closed: false };
const noRangeServer = Bun.listen<{ started: boolean; done: boolean }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(socket) {
      socket.data = { started: false, done: false };
    },
    data(socket, request) {
      if (socket.data.started) return;
      socket.data.started = true;
      noRange.written = 0;
      noRange.closed = false;
      const status = request.toString().split(" ")[1]?.includes("missing") ? "404 Not Found" : "200 OK";
      socket.write(
        `HTTP/1.1 ${status}\r\ncontent-type: image/png\r\ncontent-length: ${BIG.length}\r\n\r\n`
      );
      let offset = 0;
      const tick = () => {
        if (socket.data.done || offset >= BIG.length) return;
        const sent = socket.write(BIG.subarray(offset, offset + 8192));
        if (sent < 0) return;
        offset += sent;
        noRange.written += sent;
        setTimeout(tick, 2);
      };
      tick();
    },
    close(socket) {
      socket.data.done = true;
      noRange.closed = true;
    },
    error(socket) {
      socket.data.done = true;
    },
  },
});

function ranged(
  req: Request,
  body: Uint8Array<ArrayBuffer>,
  type: string,
  extra: Record<string, string> = {}
) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
  if (!match) {
    return new Response(req.method === "HEAD" ? null : body, {
      headers: { "content-type": type, "content-length": String(body.length), ...extra },
    });
  }
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), body.length - 1);
  const slice = body.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "content-type": type,
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${end}/${body.length}`,
      ...extra,
    },
  });
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/ranged/big.png") return ranged(req, BIG, "image/png");
    if (path === "/ranged/small.gif") return ranged(req, SMALL_GIF, "image/gif");
    if (path === "/ranged/animated.webp") return ranged(req, WEBP, "image/webp");
    if (path === "/etag/a.png") {
      if (req.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return ranged(req, BIG, "image/png", { etag: '"v1"' });
    }
    if (path === "/chunked/a.png" || path === "/chunked-head/a.png") {
      // Range ignored and no Content-Length (Bun.serve sends a stream chunked).
      // /chunked-head answers a HEAD with the length; /chunked does not.
      const body = paddedPng(100_000);
      if (req.method === "HEAD" && path === "/chunked-head/a.png") {
        return new Response(null, {
          headers: { "content-type": "image/png", "content-length": String(body.length) },
        });
      }
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= body.length) return controller.close();
            controller.enqueue(body.slice(offset, offset + 8192));
            offset += 8192;
          },
        }),
        { headers: { "content-type": "image/png" } }
      );
    }
    if (path === "/stall/a.png") {
      // Headers and the first chunk arrive, then nothing until the check times out.
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(BIG.slice(0, 4096));
              return;
            }
            await Bun.sleep(5_000);
          },
        }),
        {
          status: 206,
          headers: { "content-type": "image/png", "content-range": `bytes 0-${CAP - 1}/${BIG.length}` },
        }
      );
    }
    if (path === "/missing.png") return new Response("not found", { status: 404 });
    return new Response("?", { status: 500 });
  },
});

const base = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop(true);
  noRangeServer.stop(true);
});

/** Record the method + Range of every request the checks make. */
async function traceRequests<T>(fn: () => Promise<T>): Promise<{ calls: string[]; result: T }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    calls.push(range ? `${init?.method ?? "GET"} ${range}` : (init?.method ?? "GET"));
    return realFetch(input as string, init);
  }) as typeof fetch;
  try {
    return { calls, result: await fn() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const HEADER = { readImageHeader: true, verifyCompression: true };

describe("one ranged GET per image (#470)", () => {
  test("replaces the HEAD: size from Content-Range, natural size from the bytes", async () => {
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/ranged/big.png`], HEADER))
    );
    expect(calls).toEqual([`GET bytes=0-${CAP - 1}`]);
    expect(result[0]).toMatchObject({
      status: 206,
      error: null,
      sizeBytes: BIG.length,
      transferBytes: BIG.length,
      naturalWidth: 37,
      naturalHeight: 23,
      animated: false,
    });
  });

  test("a file under the cap comes back whole, animation and all", async () => {
    const [gif, webp] = await Effect.runPromise(
      checkResourceSizes([`${base}/ranged/small.gif`, `${base}/ranged/animated.webp`], HEADER)
    );
    expect(gif).toMatchObject({ sizeBytes: SMALL_GIF.length, naturalWidth: 20, naturalHeight: 10, animated: true });
    expect(webp).toMatchObject({ sizeBytes: WEBP.length, naturalWidth: 24, naturalHeight: 18, animated: true });
  });

  test("pools that do not read headers keep the HEAD, and record no size", async () => {
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/ranged/big.png`], { verifyCompression: true }))
    );
    expect(calls).toEqual(["HEAD"]);
    expect(result[0]).toMatchObject({ sizeBytes: BIG.length, naturalWidth: null, naturalHeight: null });
  });

  test("an error status reads no body and records no size", async () => {
    const [result] = await Effect.runPromise(checkResourceSizes([`${base}/missing.png`], HEADER));
    expect(result).toMatchObject({ status: 404, naturalWidth: null, naturalHeight: null, animated: null });
  });
});

describe("a server that ignores Range", () => {
  test("with a Content-Length: the read stops at 32 KiB and the connection closes", async () => {
    const url = `http://127.0.0.1:${noRangeServer.port}/big.png`;
    const [result] = await Effect.runPromise(checkResourceSizes([url], HEADER));
    expect(result).toMatchObject({ status: 200, sizeBytes: BIG.length, naturalWidth: 37, naturalHeight: 23 });
    // Long enough for the 1 MB file to finish (128 writes, 2 ms apart) had
    // the transfer gone on.
    await Bun.sleep(600);
    expect(noRange.closed).toBe(true);
    // Socket buffering can let the server run a little ahead of the reader,
    // never anywhere near the whole file.
    expect(noRange.written).toBeLessThan(128 * 1024);
  });

  test("an error page is not read, and does not stream on either", async () => {
    const url = `http://127.0.0.1:${noRangeServer.port}/missing.png`;
    const [result] = await Effect.runPromise(checkResourceSizes([url], HEADER));
    expect(result).toMatchObject({ status: 404, naturalWidth: null });
    await Bun.sleep(600);
    expect(noRange.closed).toBe(true);
    expect(noRange.written).toBeLessThan(128 * 1024);
  });

  test("without one: the size comes from a HEAD, as before the header read", async () => {
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/chunked-head/a.png`], HEADER))
    );
    expect(calls).toEqual([`GET bytes=0-${CAP - 1}`, "HEAD"]);
    expect(result[0]).toMatchObject({ status: 200, sizeBytes: 100_000, naturalWidth: 37, naturalHeight: 23 });
  });

  test("without one anywhere: a counted read of the body, as before", async () => {
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([`${base}/chunked/a.png`], HEADER))
    );
    expect(calls).toEqual([`GET bytes=0-${CAP - 1}`, "HEAD", "GET"]);
    expect(result[0]).toMatchObject({ status: 200, sizeBytes: 100_000, naturalWidth: 37, naturalHeight: 23 });
  });

  test("a body that stalls keeps its size and the header that did arrive", async () => {
    const started = Date.now();
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${base}/stall/a.png`], { ...HEADER, timeoutMs: 400 })
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toMatchObject({
      status: 206,
      error: null,
      sizeBytes: BIG.length,
      naturalWidth: 37,
      naturalHeight: 23,
    });
  });
});

function prior(url: string, overrides: Partial<CachedResourceRecord>): Map<string, CachedResourceRecord> {
  return new Map([
    [
      url,
      {
        type: "image",
        url,
        status: 200,
        error: null,
        contentType: "image/png",
        sizeBytes: BIG.length,
        sourcePages: [],
        cacheControl: "public, max-age=86400",
        etag: null,
        lastModified: null,
        vary: null,
        fetchedAt: Date.now() - 1_000,
        naturalWidth: 37,
        naturalHeight: 23,
        animated: false,
        ...overrides,
      },
    ],
  ]);
}

describe("cache reuse carries the natural size, or re-probes a record without one", () => {
  const url = `${base}/ranged/big.png`;

  test("an origin-fresh hit makes no request and keeps the size", async () => {
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([url], { ...HEADER, priorByUrl: prior(url, {}) }))
    );
    expect(calls).toEqual([]);
    expect(result[0]).toMatchObject({ cacheReason: "max-age", naturalWidth: 37, naturalHeight: 23, animated: false });
  });

  test("a 304 keeps the size", async () => {
    const etagUrl = `${base}/etag/a.png`;
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(
        checkResourceSizes([etagUrl], {
          ...HEADER,
          priorByUrl: prior(etagUrl, { cacheControl: null, etag: '"v1"' }),
        })
      )
    );
    expect(calls).toEqual([`GET bytes=0-${CAP - 1}`]);
    expect(result[0]).toMatchObject({ cacheReason: "304", naturalWidth: 37, naturalHeight: 23 });
  });

  test("a record from before the probe is fetched again rather than reused", async () => {
    const legacy = prior(url, { naturalWidth: undefined, naturalHeight: undefined, animated: undefined });
    const { calls, result } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([url], { ...HEADER, priorByUrl: legacy }))
    );
    expect(calls).toEqual([`GET bytes=0-${CAP - 1}`]);
    expect(result[0]).toMatchObject({ cacheReason: null, naturalWidth: 37, naturalHeight: 23 });
  });

  test("an SVG never has a size, so its record keeps its cheap reuse", async () => {
    const svg = prior(url, { contentType: "image/svg+xml", naturalWidth: null, naturalHeight: null });
    const { calls } = await traceRequests(() =>
      Effect.runPromise(checkResourceSizes([url], { ...HEADER, priorByUrl: svg }))
    );
    expect(calls).toEqual([]);
  });
});
