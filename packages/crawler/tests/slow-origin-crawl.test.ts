// #1699 — a slow origin must not wedge the crawl before it starts.
//
// `start()` resolves the seed's redirects before it emits `started`, and that
// probe's abort deadline used to be cleared as soon as the response HEADERS
// arrived, leaving the body read unbounded. An origin that answered 200 and
// then stalled or trickled its body parked `start()` there forever, so no
// `started` event ever reached the caller — which is exactly the condition the
// cloud runner reports as "Crawl phase wedged before any pages were collected".
//
// The two stalled-body tests fail against the pre-fix crawler by TIMING OUT,
// not by asserting a wrong value. The slow-on-every-response test is a guard
// rather than a reproduction: plain latency never wedged the crawl, only an
// unbounded body read did, and that distinction is the root cause.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<a href="/one">one</a><a href="/two">two</a></body></html>`;

// Short per-request timeout so the seed probe's deadline (min(10s, timeoutMs))
// is a few hundred ms — the same code path production runs at 10s.
const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 3,
  concurrency: 2,
  perHostConcurrency: 2,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 500,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
};

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(handler: (req: Request) => Response | Promise<Response>) {
  // idleTimeout: 0 — the server must never be the thing that gives up, or the
  // test would pass on the pre-fix crawler too.
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: handler });
  servers.push(server);
  // Trailing slash matters: seeded without it, `response.url` comes back
  // normalized, the seed probe reads that as a redirect and moves to the next
  // hop WITHOUT touching the body — which would skip the very read under test.
  return `http://localhost:${server.port}/`;
}

function htmlResponse(body = PAGE) {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

// 200 headers, then a body stream that is never closed.
function stalledBodyResponse() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<!doctype html><html><body>"));
      },
    }),
    { headers: { "content-type": "text/html" } },
  );
}

interface CrawlOutcome {
  startedAfterMs: number | undefined;
  pages: number;
  totalMs: number;
}

async function crawl(origin: string, config = CONFIG): Promise<CrawlOutcome> {
  const startedAt = Date.now();
  const crawler = await Effect.runPromise(createCrawler({ config }));

  let startedAfterMs: number | undefined;
  // `Stream.fromPubSub` never completes on its own, so this fiber has to be
  // interrupted or it outlives the test.
  const events = Effect.runFork(
    Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
      Effect.sync(() => {
        if (event.type === "started") startedAfterMs = Date.now() - startedAt;
      }),
    ),
  );

  try {
    const crawlId = await Effect.runPromise(crawler.start(origin, origin));
    const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
    return { startedAfterMs, pages: pages.length, totalMs: Date.now() - startedAt };
  } finally {
    await Effect.runPromise(Fiber.interrupt(events));
  }
}

describe("slow origin does not wedge the crawl (#1699)", () => {
  test("a root whose body stalls after the headers still starts and collects pages", async () => {
    let rootHits = 0;
    const origin = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/robots.txt") {
        return new Response("", { headers: { "content-type": "text/plain" } });
      }
      // Only the seed probe (the first hit on the root) stalls; the crawl's own
      // fetch of the root afterwards is healthy, so a crawl that gets past the
      // probe has real pages to collect.
      if (path === "/" && ++rootHits === 1) return stalledBodyResponse();
      return htmlResponse();
    });

    const out = await crawl(origin);

    expect(out.startedAfterMs).toBeDefined();
    // The probe gave up at its deadline instead of hanging on the body.
    expect(out.startedAfterMs!).toBeLessThan(5_000);
    expect(out.pages).toBeGreaterThan(0);
  });

  test("a root that trickles its body forever is bounded the same way", async () => {
    let rootHits = 0;
    const origin = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/robots.txt") {
        return new Response("", { headers: { "content-type": "text/plain" } });
      }
      if (path === "/" && ++rootHits === 1) {
        // A byte every 50ms, forever: never idle, so only a real time bound
        // ends it. `readBodyCapped`'s BYTE cap cannot.
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(50);
              controller.enqueue(new TextEncoder().encode("<!-- x -->"));
            },
          }),
          { headers: { "content-type": "text/html" } },
        );
      }
      return htmlResponse();
    });

    const out = await crawl(origin);

    expect(out.startedAfterMs).toBeDefined();
    expect(out.startedAfterMs!).toBeLessThan(5_000);
    expect(out.pages).toBeGreaterThan(0);
  });

  test("an origin that is slow on every response still collects pages", async () => {
    // Proportionally what daigo.ru looks like: a delay on every single response,
    // including all ~38 root probes the preamble issues before the first page.
    const origin = serve(async (req) => {
      await Bun.sleep(120);
      const path = new URL(req.url).pathname;
      if (path === "/robots.txt") {
        return new Response("", { headers: { "content-type": "text/plain" } });
      }
      return htmlResponse();
    });

    const out = await crawl(origin, { ...CONFIG, timeoutMs: 5_000 });

    expect(out.startedAfterMs).toBeDefined();
    expect(out.pages).toBeGreaterThan(0);
  });

  test("a hop that serves headers and then stalls still counts as resolved", async () => {
    // The seed meta-refreshes to /second, whose headers arrive before its body
    // stalls. /second demonstrably serves, so it — not the seed — is what the
    // probe resolves to. Banking the URL only after the body read would throw
    // that away and hand the crawl back the pre-redirect seed.
    const origin = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/") {
        return htmlResponse(
          `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=/second"></head><body>x</body></html>`,
        );
      }
      if (path === "/second") return stalledBodyResponse();
      return htmlResponse();
    });

    const crawler = await Effect.runPromise(createCrawler({ config: CONFIG }));
    const resolved = await Effect.runPromise(crawler.detectRedirects(origin));

    expect(resolved).toBe(`${origin}second`);
  });
});
