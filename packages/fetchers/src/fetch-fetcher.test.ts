import { afterEach, describe, expect, it } from "bun:test";
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
