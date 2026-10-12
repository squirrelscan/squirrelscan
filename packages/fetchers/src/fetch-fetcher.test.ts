import { afterEach, describe, expect, it } from "bun:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createFetchDocumentFetcher } from "./index";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("createFetchDocumentFetcher decompression resilience #292", () => {
  it("recovers the page when a server lies about Content-Encoding: br", async () => {
    const html = "<!doctype html><title>hi</title>";
    server = Bun.serve({
      port: 0,
      fetch() {
        // Plain HTML mislabeled as brotli — Bun's decode would throw.
        return new Response(html, {
          headers: { "Content-Encoding": "br", "Content-Type": "text/html" },
        });
      },
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    expect(res.status).toBe(200);
    // Page is kept (not dropped) and the real HTML is recovered via the identity refetch.
    expect(res.body).toBe(html);
  });

  it("recovers when a server lies about Content-Encoding: gzip", async () => {
    const html = "<!doctype html><title>z</title>";
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(html, { headers: { "Content-Encoding": "gzip", "Content-Type": "text/html" } }),
    });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    expect(res.status).toBe(200);
    expect(res.body).toBe(html);
  });

  it("returns valid bodies normally", async () => {
    const html = "<!doctype html><title>ok</title>";
    server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
    const fetcher = createFetchDocumentFetcher();
    const res = await fetcher.fetch({ url: `http://localhost:${server.port}/` });
    expect(res.body).toBe(html);
  });
});

describe("createFetchDocumentFetcher undecoded fetches #2717", () => {
  it("turns the runtime's decoding off on every redirect hop and decodes the page", async () => {
    const html = "<!doctype html><title>decoded</title>";
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        // Each hop's own body is encoded too: the redirect loop discards it.
        if (path === "/a") {
          return new Response(gzipSync("moved"), {
            status: 301,
            headers: { location: "/b", "Content-Encoding": "gzip" },
          });
        }
        if (path === "/b") {
          return new Response(brotliCompressSync("moved"), {
            status: 302,
            headers: { location: "/c", "Content-Encoding": "br" },
          });
        }
        return new Response(brotliCompressSync(html), {
          headers: { "Content-Encoding": "br", "Content-Type": "text/html" },
        });
      },
    });
    const real = globalThis.fetch;
    const sent: Array<{ path: string; decompress: unknown }> = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({
          path: new URL(String(input)).pathname,
          decompress: (init as { decompress?: unknown } | undefined)?.decompress,
        });
        return real(input, init);
      },
      { preconnect: real.preconnect },
    );
    try {
      const res = await createFetchDocumentFetcher().fetch({ url: `http://localhost:${server.port}/a` });
      expect(res.body).toBe(html);
      expect(res.headers["content-encoding"]).toBe("br");
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toEqual([
      { path: "/a", decompress: false },
      { path: "/b", decompress: false },
      { path: "/c", decompress: false },
    ]);
  });
});
