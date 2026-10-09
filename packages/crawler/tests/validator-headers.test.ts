// pub#600: a weak ETag on a zstd page was reported as missing. The crawler
// records ETag and Last-Modified verbatim whatever the content-encoding, weak
// or strong; what removed it was the edge, which drops the ETag for requests
// that ask for HTML, and squirrel asks for HTML the way a browser does.

import { brotliCompressSync } from "node:zlib";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchPage } from "../src/fetcher";

const FETCH_OPTIONS = { userAgent: "squirrel-test", timeoutMs: 5_000, followRedirects: false };

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const PAGE = "<!doctype html><html><head><title>t</title></head><body>hello</body></html>";
const LAST_MODIFIED = "Wed, 16 Sep 2026 08:01:44 GMT";

const ENCODERS: Record<string, ((body: string) => Uint8Array) | null> = {
  identity: null,
  gzip: (body) => Bun.gzipSync(body),
  br: (body) => brotliCompressSync(body),
  zstd: (body) => Bun.zstdCompressSync(body),
};

function serve(handler: (req: Request) => Response): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://localhost:${server.port}/`;
}

describe("validators survive every content-encoding", () => {
  for (const [encoding, encode] of Object.entries(ENCODERS)) {
    for (const etag of ['W/"5e1f-weak"', '"5e1f-strong"']) {
      const kind = etag.startsWith("W/") ? "weak" : "strong";
      test(`${kind} ETag and Last-Modified on a ${encoding} response are stored verbatim`, async () => {
        const url = serve(
          () =>
            new Response(encode ? encode(PAGE) : PAGE, {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "public, max-age=0, must-revalidate",
                etag,
                "last-modified": LAST_MODIFIED,
                ...(encode ? { "content-encoding": encoding } : {}),
              },
            }),
        );

        const result = await Effect.runPromise(fetchPage(url, FETCH_OPTIONS));

        expect(result.status).toBe(200);
        expect(result.body).toBe(PAGE);
        expect(result.headers.etag).toBe(etag);
        expect(result.headers.lastModified).toBe(LAST_MODIFIED);
        if (encode) expect(result.headers.contentEncoding).toBe(encoding);
      });
    }
  }
});

describe("page requests ask for HTML", () => {
  test("an origin that drops the ETag for HTML requests is recorded without one", async () => {
    // What a Cloudflare zone with an HTML-rewriting feature looks like from
    // outside: `curl` (Accept: */*) gets the ETag, a browser does not. squirrel
    // records what the browser gets.
    let accept: string | null = null;
    const url = serve((req) => {
      accept = req.headers.get("accept");
      const html = (accept ?? "").includes("text/html");
      return new Response(PAGE, {
        headers: { "content-type": "text/html", ...(html ? {} : { etag: 'W/"abc"' }) },
      });
    });

    const result = await Effect.runPromise(fetchPage(url, FETCH_OPTIONS));

    expect(accept ?? "").toContain("text/html");
    expect(result.headers.etag).toBeNull();
  });
});
