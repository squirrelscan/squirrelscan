// A redirect whose Location the URL parser refuses (`http://[`) used to throw
// inside the fetcher's Effect generator, which is a defect: it failed the fetch
// as a crash instead of recording the page (squirrelscan/repo#3382). It is a
// terminal error hop now, like a redirect with no Location at all, on both
// fetchers, and the crawl goes on to the next URL.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Stream } from "effect";

import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { fetchPage } from "../src/fetcher";

const BAD_LOCATION = "http://[";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const PAGE = `<!doctype html><html><head><title>home</title></head><body>
<a href="/bad">bad</a> <a href="/next">next</a></body></html>`;

function site() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/robots.txt") return new Response("", { status: 404 });
      if (path === "/bad") {
        return new Response(null, { status: 302, headers: { location: BAD_LOCATION } });
      }
      if (path === "/next") {
        return new Response("<!doctype html><title>next</title><p>next</p>", {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}/`;
}

describe("a redirect with an unparseable Location", () => {
  test("fetchPage records a terminal error hop, not a defect", async () => {
    const origin = site();
    const exit = await Effect.runPromiseExit(
      fetchPage(`${origin}bad`, {
        userAgent: "squirrel-test",
        timeoutMs: 5_000,
        followRedirects: true,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.status).toBe(302);
    expect(exit.value.redirectChain.endsInError).toBe(true);
    expect(exit.value.redirectChain.hops.map((h) => h.statusCode)).toEqual([302]);
  });

  test("the crawl records the page and goes on to the next URL", async () => {
    const origin = site();
    const config: Partial<CrawlerConfig> = {
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
      breadthFirst: true,
      coverageMode: "full",
    };
    const crawler = await Effect.runPromise(createCrawler({ config }));
    const seen: string[] = [];
    const events = Effect.runFork(
      Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
        Effect.sync(() => {
          if (event.type === "page:fetched" || event.type === "page:failed") seen.push(event.url);
        }),
      ),
    );
    try {
      const crawlId = await Effect.runPromise(crawler.start(origin, origin));
      const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
      const urls = pages.map((p) => p.url);

      expect(urls).toContain(origin);
      expect(urls).toContain(`${origin}next`);
      expect(seen).toContain(`${origin}bad`);
    } finally {
      await Effect.runPromise(Fiber.interrupt(events));
    }
  });

  test("the plain fetcher records the same terminal error hop", async () => {
    const origin = site();
    const fetcher = createFetchDocumentFetcher();
    const result = await fetcher.fetch({ url: `${origin}bad`, timeoutMs: 5_000 });
    expect(result.status).toBe(302);
    expect(result.redirectChain?.endsInError).toBe(true);
  });
});
