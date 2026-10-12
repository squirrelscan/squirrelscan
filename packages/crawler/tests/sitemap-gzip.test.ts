// squirrelscan/squirrelscan#662: the sitemap protocol allows gzip FILES
// (`sitemap.xml.gz`, typically served as `application/gzip` with no
// Content-Encoding), and an index may list them as children. The walk read
// every body with `response.text()`, so the compressed bytes reached the XML
// parser and the child was reported as `Unknown sitemap format`. Every case is
// driven against a real origin except where only the decoder is under test.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

import {
  SITEMAP_CORRUPT_GZIP_ERROR,
  SITEMAP_MAX_BYTES,
  SITEMAP_TOO_LARGE_ERROR,
  SITEMAP_UNSUPPORTED_ENCODING_ERROR,
  decodeSitemapBody,
  discoverSitemaps,
  fetchSitemap,
} from "../src/sitemaps";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

type Route = { body: string | Uint8Array | ReadableStream; headers: Record<string, string> };

/** An origin serving `routes` (built from its own base URL) and 404 elsewhere. */
function serve(routes: (base: string) => Record<string, Route>): string {
  let table: Record<string, Route> = {};
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const route = table[new URL(req.url).pathname];
      return route ? new Response(route.body, { headers: route.headers }) : new Response("nope", { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://localhost:${server.port}`;
  table = routes(base);
  return base;
}

function urlset(...locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${NS}">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;
}

function sitemapIndex(...children: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="${NS}">${children
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
}

const XML = { "Content-Type": "application/xml; charset=utf-8" };
const GZIP_FILE = { "Content-Type": "application/gzip" };

/** The repro's shape: an index, named in robots.txt, whose one child is `childPath`. */
function indexWithChild(childPath: string, child: (base: string) => Route): string {
  return serve((base) => ({
    "/sitemap.xml": { body: sitemapIndex(`${base}${childPath}`), headers: XML },
    [childPath]: child(base),
  }));
}

async function discover(origin: string) {
  return Effect.runPromise(
    discoverSitemaps(
      origin,
      {
        exists: true,
        url: `${origin}/robots.txt`,
        content: "",
        sizeBytes: 0,
        sitemaps: [`${origin}/sitemap.xml`],
        rules: [],
        errors: [],
      },
      "squirrel-test",
    ),
  );
}

function child(result: Awaited<ReturnType<typeof discover>>, url: string) {
  const found = result.all.find((sitemap) => sitemap.url === url);
  if (!found) throw new Error(`${url} was not stored; stored: ${result.all.map((s) => s.url).join(", ")}`);
  return found;
}

describe("gzip child sitemaps (#662)", () => {
  test("a gzip child served as application/gzip is decompressed and its URLs discovered", async () => {
    const origin = indexWithChild("/child.xml.gz", (base) => ({
      body: gzipSync(urlset(`${base}/`, `${base}/a`)),
      headers: GZIP_FILE,
    }));

    const result = await discover(origin);
    const gz = child(result, `${origin}/child.xml.gz`);

    expect(gz.errors).toEqual([]);
    expect(gz.urls.map((url) => url.loc)).toEqual([`${origin}/`, `${origin}/a`]);
  });

  test("the uncompressed control reads the same as the gzip child", async () => {
    const origin = indexWithChild("/child.xml", (base) => ({
      body: urlset(`${base}/`, `${base}/a`),
      headers: XML,
    }));

    const plain = child(await discover(origin), `${origin}/child.xml`);

    expect(plain.errors).toEqual([]);
    expect(plain.urls.map((url) => url.loc)).toEqual([`${origin}/`, `${origin}/a`]);
  });

  test("a sitemap served with Content-Encoding: gzip still parses", async () => {
    const origin = serve((base) => ({
      "/sitemap.xml": {
        body: gzipSync(urlset(`${base}/`)),
        headers: { ...XML, "Content-Encoding": "gzip" },
      },
    }));

    const result = await Effect.runPromise(fetchSitemap(`${origin}/sitemap.xml`, "squirrel-test"));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.errors).toEqual([]);
    expect(result.data.urls.map((url) => url.loc)).toEqual([`${origin}/`]);
  });

  test("the walk asks for gzip and undoes Content-Encoding itself, within the limit", async () => {
    // Bun's own decoding inflates the whole response before a reader can stop
    // it, so the bound only holds if the walk decodes. A Content-Encoding bomb
    // reports the size error rather than whatever the runtime made of it.
    let acceptEncoding: string | null = null;
    const bomb = gzipSync(Buffer.alloc(SITEMAP_MAX_BYTES + 1, 0x20));
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        acceptEncoding = req.headers.get("accept-encoding");
        return new Response(bomb, { headers: { ...XML, "Content-Encoding": "gzip" } });
      },
    });
    servers.push(server);

    const result = await Effect.runPromise(fetchSitemap(`http://localhost:${server.port}/sitemap.xml`, "squirrel-test"));

    expect(acceptEncoding as string | null).toBe("gzip");
    expect(result.success && result.data.errors).toEqual([SITEMAP_TOO_LARGE_ERROR]);
  });

  test("a server that answers with br or deflate anyway is still decoded", () => {
    const xml = urlset("https://example.com/");
    for (const [coding, body] of [
      ["br", brotliCompressSync(xml)],
      ["deflate", deflateSync(xml)],
      ["deflate", deflateRawSync(xml)],
    ] as const) {
      const decoded = decodeSitemapBody(body, "https://example.com/s.xml", "application/xml", coding);
      expect([coding, decoded.data.errors, decoded.data.urlCount]).toEqual([coding, [], 1]);
    }
  });

  test("a corrupt, stacked or unknown Content-Encoding is reported, not parsed", () => {
    const url = "https://example.com/s.xml";
    const corrupt = Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
    expect(decodeSitemapBody(corrupt, url, "application/xml", "gzip").data.errors[0]?.startsWith(
      `${SITEMAP_CORRUPT_GZIP_ERROR}: `,
    )).toBe(true);
    expect(decodeSitemapBody(Uint8Array.from([1, 2, 3]), url, "application/xml", "zstd").data.errors).toEqual([
      `${SITEMAP_UNSUPPORTED_ENCODING_ERROR}: zstd`,
    ]);
    const twice = gzipSync(gzipSync(urlset("https://example.com/")));
    expect(decodeSitemapBody(twice, url, "application/xml", "gzip, gzip").data.errors).toEqual([
      `${SITEMAP_UNSUPPORTED_ENCODING_ERROR}: gzip, gzip`,
    ]);
  });

  test("a coding name that is an Object property is still unknown", () => {
    const decoded = decodeSitemapBody(
      new TextEncoder().encode(urlset("https://example.com/")),
      "https://example.com/s.xml",
      "application/xml",
      "constructor",
    );
    expect(decoded.data.errors).toEqual([`${SITEMAP_UNSUPPORTED_ENCODING_ERROR}: constructor`]);
  });

  test("every request, redirect hops included, turns the runtime's decoding off", async () => {
    // The memory bound rests on this: with Bun's own decoding on, a bomb is
    // inflated in full before any reader can stop it, and the size error the
    // test above sees would still come back, just 1.9 GB later.
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; decompress: unknown; acceptEncoding: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({
        url,
        decompress: (init as { decompress?: unknown } | undefined)?.decompress,
        acceptEncoding: new Headers(init?.headers).get("accept-encoding"),
      });
      return url.endsWith("/old.xml")
        ? new Response(null, { status: 301, headers: { location: "/sitemap.xml" } })
        : new Response(urlset("https://example.com/"), { headers: XML });
    }) as typeof fetch;
    try {
      const result = await Effect.runPromise(fetchSitemap("https://example.com/old.xml", "squirrel-test"));
      expect(result.success && result.data.urlCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen).toEqual([
      { url: "https://example.com/old.xml", decompress: false, acceptEncoding: "gzip" },
      { url: "https://example.com/sitemap.xml", decompress: false, acceptEncoding: "gzip" },
    ]);
  });

  test("a gzip file ALSO sent with Content-Encoding: gzip is decoded by HTTP, then decompressed", async () => {
    const origin = serve((base) => ({
      "/sitemap.xml.gz": {
        body: gzipSync(gzipSync(urlset(`${base}/`))),
        headers: { ...GZIP_FILE, "Content-Encoding": "gzip" },
      },
    }));

    const result = await Effect.runPromise(fetchSitemap(`${origin}/sitemap.xml.gz`, "squirrel-test"));

    expect(result.success && result.data.urls.map((url) => url.loc)).toEqual([`${origin}/`]);
  });

  test("a corrupt gzip body reports a corrupt-gzip error, not Unknown sitemap format", async () => {
    // The gzip signature and header, then bytes that are not a deflate stream.
    const corrupt = Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8]);
    const origin = indexWithChild("/child.xml.gz", () => ({ body: corrupt, headers: GZIP_FILE }));

    const gz = child(await discover(origin), `${origin}/child.xml.gz`);

    expect(gz.errors).toHaveLength(1);
    expect(gz.errors[0]?.startsWith(`${SITEMAP_CORRUPT_GZIP_ERROR}: `)).toBe(true);
    expect(gz.urls).toEqual([]);
  });

  test("a truncated gzip body is corrupt too", () => {
    const whole = gzipSync(urlset("https://example.com/"));
    const decoded = decodeSitemapBody(whole.subarray(0, whole.length - 10), "https://example.com/s.xml.gz", null);

    expect(decoded.data.errors[0]?.startsWith(`${SITEMAP_CORRUPT_GZIP_ERROR}: `)).toBe(true);
    expect(decoded.notASitemap).toBeUndefined();
  });

  test("a gzip bomb is refused at the 50 MB limit with a size error", async () => {
    // One byte past the limit, decompressed: 51 KB on the wire.
    const bomb = gzipSync(Buffer.alloc(SITEMAP_MAX_BYTES + 1, 0x20));
    const origin = indexWithChild("/child.xml.gz", () => ({ body: bomb, headers: GZIP_FILE }));

    const gz = child(await discover(origin), `${origin}/child.xml.gz`);

    expect(gz.errors).toEqual([SITEMAP_TOO_LARGE_ERROR]);
    expect(gz.urls).toEqual([]);
  });

  test("an endless plain body is cut off at the limit, not buffered whole", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const origin = serve(() => ({
      "/sitemap.xml": {
        body: new ReadableStream({
          async pull(controller) {
            // Yield between chunks: the origin shares this process's event loop.
            await Bun.sleep(0);
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        headers: XML,
      },
    }));

    const result = await Effect.runPromise(fetchSitemap(`${origin}/sitemap.xml`, "squirrel-test"));

    expect(result.success && result.data.errors).toEqual([SITEMAP_TOO_LARGE_ERROR]);
    // The read stopped near the limit rather than draining the stream.
    expect(sent).toBeLessThan(SITEMAP_MAX_BYTES * 2);
  });

  test("a body is decompressed once: a gzip inside the gzip is not unwrapped again", () => {
    const twice = gzipSync(gzipSync(urlset("https://example.com/")));
    const decoded = decodeSitemapBody(twice, "https://example.com/s.xml.gz", "application/gzip");

    expect(decoded.data.urls).toEqual([]);
    expect(decoded.data.errors).toHaveLength(1);
  });
});
