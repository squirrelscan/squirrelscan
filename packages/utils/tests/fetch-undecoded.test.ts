// Bun's fetch inflates a Content-Encoding body in full as soon as it arrives,
// read or not, so a byte cap on the reader never bounded a compression bomb
// (squirrelscan/repo#2717). fetchUndecoded turns that decoding off and
// readBodyCapped undoes the coding itself, no further than the cap.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  brotliCompressSync,
  constants,
  createBrotliCompress,
  createGzip,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";

import {
  ACCEPT_ENCODING,
  ContentDecodingError,
  decodedBody,
  fetchUndecoded,
  isDecompressionError,
  readBodyCapped,
} from "../src/response-body";
import { headersForRedirect } from "../src/headers";
import { safeRedirectFetch } from "../src/safe-fetch";

const GIB = 1024 * 1024 * 1024;
const HTML = `<!doctype html><html><head><title>decoded</title></head><body>${"<p>squirrel</p>".repeat(200)}</body></html>`;

/** `total` bytes of spaces through a streaming compressor, never held whole. */
async function bomb(compressor: NodeJS.ReadWriteStream, total: number): Promise<Buffer> {
  const out: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => compressor.on("end", resolve));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    if (!compressor.write(chunk)) await new Promise((resolve) => compressor.once("drain", resolve));
  }
  compressor.end();
  await ended;
  return Buffer.concat(out);
}

let gzipBomb: Buffer;
let brBomb: Buffer;
const requestHeaders: Headers[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin: string;

const encoded = (body: Uint8Array | string, coding: string): Response =>
  new Response(body, { headers: { "content-type": "text/html", "content-encoding": coding } });

beforeAll(async () => {
  gzipBomb = await bomb(createGzip({ level: 6 }), GIB);
  brBomb = await bomb(
    createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }),
    GIB,
  );
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requestHeaders.push(req.headers);
      const path = new URL(req.url).pathname;
      switch (path) {
        case "/gzip":
          return encoded(gzipSync(HTML), "gzip");
        case "/x-gzip":
          return encoded(gzipSync(HTML), "x-gzip");
        case "/upper":
          return encoded(gzipSync(HTML), "GZIP");
        case "/deflate":
          return encoded(deflateSync(HTML), "deflate");
        case "/deflate-raw":
          return encoded(deflateRawSync(HTML), "deflate");
        case "/br":
          return encoded(brotliCompressSync(HTML), "br");
        case "/zstd":
          return encoded(zstdCompressSync(HTML), "zstd");
        case "/identity":
          return encoded(HTML, "identity");
        case "/unknown":
          return encoded(HTML, "x-squirrel");
        case "/stacked":
          return encoded(gzipSync(gzipSync(HTML)), "gzip, gzip");
        case "/empty":
          return encoded(new Uint8Array(0), "gzip");
        case "/liar":
          return encoded(HTML, "gzip");
        case "/truncated": {
          const whole = gzipSync(HTML);
          return encoded(whole.subarray(0, whole.byteLength >> 1), "gzip");
        }
        case "/bomb-gzip":
          return encoded(gzipBomb, "gzip");
        case "/bomb-br":
          return encoded(brBomb, "br");
        case "/stall": {
          // The first compressed chunk, then nothing: the request deadline is
          // what ends this read.
          const whole = gzipSync(HTML);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(whole.subarray(0, 20));
              },
            }),
            { headers: { "content-encoding": "gzip" } },
          );
        }
        case "/hop-1":
          return new Response(null, { status: 302, headers: { location: "/hop-2" } });
        case "/hop-2":
          return new Response(null, { status: 301, headers: { location: "/gzip" } });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));
afterEach(() => {
  requestHeaders.length = 0;
});

/** Peak RSS growth while `run` runs. */
async function peakRssGrowth(run: () => Promise<unknown>): Promise<number> {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 1);
  try {
    await run();
  } finally {
    clearInterval(sampler);
  }
  return Math.max(peak, process.memoryUsage().rss) - before;
}

describe("fetchUndecoded", () => {
  test("turns the runtime's decoding off and asks for what the runtime would", async () => {
    const real = globalThis.fetch;
    const inits: RequestInit[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return real(input, init);
      },
      { preconnect: real.preconnect },
    );
    try {
      await (await fetchUndecoded(`${origin}/gzip`)).body?.cancel();
    } finally {
      globalThis.fetch = real;
    }
    expect(inits).toHaveLength(1);
    expect((inits[0] as { decompress?: boolean }).decompress).toBe(false);
    // Bun sends no Accept-Encoding at all once its decoding is off.
    expect(requestHeaders[0]?.get("accept-encoding")).toBe(ACCEPT_ENCODING);
  });

  test("keeps the caller's own Accept-Encoding", async () => {
    const res = await fetchUndecoded(`${origin}/gzip`, { headers: { "Accept-Encoding": "gzip" } });
    await res.body?.cancel();
    expect(requestHeaders[0]?.get("accept-encoding")).toBe("gzip");
  });
});

describe("readBodyCapped over fetchUndecoded", () => {
  for (const path of ["/gzip", "/x-gzip", "/upper", "/deflate", "/deflate-raw", "/br", "/zstd"]) {
    test(`decodes ${path}`, async () => {
      expect(await readBodyCapped(await fetchUndecoded(`${origin}${path}`), 1_000_000)).toBe(HTML);
    });
  }

  for (const path of ["/identity", "/unknown"]) {
    test(`reads ${path} as it arrived`, async () => {
      expect(await readBodyCapped(await fetchUndecoded(`${origin}${path}`), 1_000_000)).toBe(HTML);
    });
  }

  test("passes stacked codings through untouched, as Bun's own decoding does", async () => {
    const raw = new TextDecoder().decode(gzipSync(gzipSync(HTML)));
    expect(await readBodyCapped(await fetchUndecoded(`${origin}/stacked`), 1_000_000)).toBe(raw);
  });

  test("reads an empty encoded body as empty", async () => {
    expect(await readBodyCapped(await fetchUndecoded(`${origin}/empty`), 1_000)).toBe("");
  });

  for (const path of ["/liar", "/truncated"]) {
    test(`a body that does not decode (${path}) is a decompression error`, async () => {
      const read = readBodyCapped(await fetchUndecoded(`${origin}${path}`), 1_000_000);
      const error = await read.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ContentDecodingError);
      expect(isDecompressionError(error)).toBe(true);
      expect((error as Error).message).toContain("gzip");
    });
  }

  test("a deadline firing mid-body is still an abort, not a decode failure", async () => {
    const controller = new AbortController();
    const res = await fetchUndecoded(`${origin}/stall`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const error = await readBodyCapped(res, 1_000_000).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).name).toBe("AbortError");
  });

  for (const [path, label] of [
    ["/bomb-gzip", "gzip"],
    ["/bomb-br", "br"],
  ] as const) {
    test(`a ${label} body that inflates to 1 GiB is decoded only to the cap`, async () => {
      const cap = 1024 * 1024;
      let text = "";
      const growth = await peakRssGrowth(async () => {
        text = await readBodyCapped(await fetchUndecoded(`${origin}${path}`), cap);
      });
      expect(text.length).toBe(cap);
      expect(text.trim()).toBe("");
      // Inflated in full this is over 1 GiB (2.3 GB+ measured before #2717);
      // read lazily it is the cap plus the runtime's own buffers.
      expect(growth).toBeLessThan(256 * 1024 * 1024);
    });
  }
});

describe("decodedBody", () => {
  test("leaves a response that fetchUndecoded did not fetch alone", async () => {
    const res = encoded(HTML, "gzip");
    const body = res.body;
    expect(decodedBody(res)).toBe(body);
  });
});

describe("redirects", () => {
  test("a native redirect's final hop arrives undecoded too", async () => {
    // `redirect: "follow"` hides the hops from any spy, so this reads the end of
    // the chain: had the runtime decoded the final gzip body itself, decoding
    // it again would fail. The hops themselves were never the risk: Bun
    // discards the body of a 3xx it follows (measured on 1.3.14 and 1.4.0).
    const res = await fetchUndecoded(`${origin}/hop-1`, { redirect: "follow" });
    expect(res.url).toBe(`${origin}/gzip`);
    expect(await readBodyCapped(res, 1_000_000)).toBe(HTML);
  });

  test("a cross-origin hop keeps the caller's Accept-Encoding, never its secrets", () => {
    const next = headersForRedirect(
      { "Accept-Encoding": "gzip", "X-Api-Key": "secret" },
      "https://a.example/",
      "https://b.example/",
    );
    // Dropped, the hop would ask for the default codings, which a caller like
    // the sitemap reader does not decode.
    expect(next.get("accept-encoding")).toBe("gzip");
    expect(next.has("x-api-key")).toBe(false);
  });
});

describe("safeRedirectFetch", () => {
  test("sends every hop through the given fetch", async () => {
    const hops: string[] = [];
    const { response, finalUrl } = await safeRedirectFetch(`${origin}/hop-1`, {}, (url, init) => {
      hops.push(new URL(url).pathname);
      return fetchUndecoded(url, init);
    });
    expect(hops).toEqual(["/hop-1", "/hop-2", "/gzip"]);
    expect(finalUrl).toBe(`${origin}/gzip`);
    expect(await readBodyCapped(response, 1_000_000)).toBe(HTML);
  });
});
