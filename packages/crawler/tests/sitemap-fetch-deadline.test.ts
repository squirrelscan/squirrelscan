// #1729: a sitemap request's deadline must cover the BODY read, not just the
// headers. A sitemap that answers 200 and then stalls its body would otherwise
// park the crawl preamble. Moved here from the CLI's sitemap copy (#756),
// which the crawl no longer ran.

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchSitemap } from "../src/sitemaps";

const DEADLINE_MS = 300;

// Headers land immediately; the stalled body is enqueued once and never
// closed, so only the client can end the request.
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/stall-sitemap.xml") {
      const stall = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<?xml"));
        },
      });
      return new Response(stall, { headers: { "content-type": "application/xml" } });
    }
    if (path === "/missing.xml") return new Response("nope", { status: 404 });
    if (path === "/sitemap.xml") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/one</loc></url>
</urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    }
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  },
});
const base = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
});

const fetchWithin = (path: string) =>
  Effect.runPromise(fetchSitemap(`${base}${path}`, "test-agent", undefined, undefined, DEADLINE_MS));

describe("sitemap fetch deadline (#1729)", () => {
  test("a sitemap body that stalls after the headers ends at the deadline", async () => {
    const startedAt = Date.now();
    const result = await fetchWithin("/stall-sitemap.xml");
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });

  test("a sitemap that answers promptly is still parsed", async () => {
    const result = await fetchWithin("/sitemap.xml");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.urls.map((u) => u.loc)).toEqual(["https://example.com/one"]);
  });

  test("a stalled body, an HTTP error and a connect failure keep their own reasons", async () => {
    const stalled = await fetchWithin("/stall-sitemap.xml");
    const notFound = await fetchWithin("/missing.xml");

    // The connect failure is injected rather than aimed at an unresolvable
    // host: real DNS can outrun a short deadline, and then the abort wins the
    // race and proves nothing about the connect path.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new TypeError("connection refused"))) as typeof fetch;
    let unreachable;
    try {
      unreachable = await fetchWithin("/sitemap.xml");
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(stalled.success || notFound.success || unreachable.success).toBe(false);
    if (stalled.success || notFound.success || unreachable.success) return;
    // A body that never arrives reads as "Empty response", the text persisted
    // sitemap-failure records have always carried; it is not settled, so it
    // is not reported as the origin's answer.
    expect(stalled).toMatchObject({ error: "Empty response", settled: false });
    expect(notFound).toMatchObject({ error: "HTTP 404", settled: true });
    expect(unreachable).toMatchObject({ error: "connection refused", settled: false });
  });
});
