// A response whose declared content-encoding does not match its body used to
// fail with the runtime's bare "Decompression error: ZlibError": no URL, no
// encoding, and nothing recorded about the page that was lost. It must now be
// attributed to the URL and the declared encoding, and counted by the crawl so
// the report can say its coverage was short.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Either, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { CrawlError, fetchPage, isDecompressionError } from "../src/fetcher";

const FETCH_OPTIONS = { userAgent: "squirrel-test", timeoutMs: 5_000, followRedirects: false };

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<a href="/bad">bad</a></body></html>`;

/** Plain HTML labelled with an encoding it was never compressed with. */
function lyingResponse(encoding: string): Response {
  return new Response("<!doctype html><title>plain</title>", {
    headers: { "content-type": "text/html", "content-encoding": encoding },
  });
}

describe("decode failures are attributed", () => {
  for (const encoding of ["br", "gzip"]) {
    test(`content-encoding: ${encoding} that the body does not match names the URL and encoding`, async () => {
      const server = Bun.serve({ port: 0, fetch: () => lyingResponse(encoding) });
      servers.push(server);
      const url = `http://localhost:${server.port}/`;

      const result = await Effect.runPromise(Effect.either(fetchPage(url, FETCH_OPTIONS)));

      expect(Either.isLeft(result)).toBe(true);
      if (!Either.isLeft(result)) return;
      expect(result.left).toBeInstanceOf(CrawlError);
      expect(result.left.type).toBe("decode");
      expect(result.left.message).toContain(url);
      expect(result.left.message).toContain(`content-encoding: ${encoding}`);
    });
  }

  test("a body that decodes normally is untouched", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
    });
    servers.push(server);
    const result = await Effect.runPromise(
      fetchPage(`http://localhost:${server.port}/`, FETCH_OPTIONS),
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe(PAGE);
  });

  test("isDecompressionError matches the runtime's decode failures only", () => {
    expect(isDecompressionError(new Error("ZlibError"))).toBe(true);
    expect(isDecompressionError(new Error("BrotliDecompressionError"))).toBe(true);
    expect(isDecompressionError(new Error("connection refused"))).toBe(false);
    expect(isDecompressionError("ZlibError")).toBe(false);
  });
});

describe("a page that cannot be decoded is counted by the crawl", () => {
  const CONFIG: Partial<CrawlerConfig> = {
    maxPages: 5,
    concurrency: 1,
    perHostConcurrency: 1,
    delayMs: 0,
    perHostDelayMs: 0,
    timeoutMs: 2_000,
    userAgent: "squirrel-test",
    respectRobots: false,
    incremental: false,
    useCacheControl: false,
    breadthFirst: false,
    coverageMode: "full",
  };

  test("records a failed page and pagesUndecodable, and keeps the pages it could read", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/robots.txt") return new Response("", { status: 404 });
        if (path === "/bad") return lyingResponse("br");
        return new Response(PAGE, { headers: { "content-type": "text/html" } });
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}/`;

    const crawler = await Effect.runPromise(createCrawler({ config: CONFIG }));
    const failures: string[] = [];
    const events = Effect.runFork(
      Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
        Effect.sync(() => {
          if (event.type === "page:failed") failures.push(event.error);
        }),
      ),
    );
    try {
      const crawlId = await Effect.runPromise(crawler.start(origin, origin));
      const stats = await Effect.runPromise(crawler.storage.getStats(crawlId));
      const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));

      expect(stats?.pagesUndecodable).toBe(1);
      // A subset of pagesFailed, never in place of it.
      expect(stats?.pagesFailed).toBe(1);
      expect(pages.map((p) => p.url)).toEqual([origin]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`${origin}bad`);
      expect(failures[0]).toContain("content-encoding: br");
    } finally {
      await Effect.runPromise(Fiber.interrupt(events));
    }
  });
});
