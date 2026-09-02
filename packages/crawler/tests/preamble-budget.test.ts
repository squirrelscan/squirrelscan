// squirrelscan/repo#1733 — the crawl preamble needs a budget as a WHOLE, not
// just a deadline per request.
//
// #1699 gave every root probe a deadline that survives its body read, which
// stopped a stalled body hanging the crawl forever. It left the sum untouched:
// the preamble is seven sequential stages carrying 15-30s deadlines apiece, so
// an origin that answers 200 on every root path and then stalls the body burned
// 150.3s across 28 requests before page 1 — the entire 120s crawl phase a quick
// cloud audit gets, on a site whose real pages serve perfectly well.
//
// The stalled-origin tests below fail against the pre-fix crawler by TIMING OUT
// rather than by asserting a wrong value: their whole point is wall clock. The
// slow-but-healthy tests are the other half of the bargain — a budget that
// quietly dropped probe data on normal sites would be a worse bug than the one
// fixed, so every response in those is deliberately slow. An instant-response
// "healthy" test passes under any budget, however brutal, and proves nothing.
//
// The sitemap WALK is not on this budget, and the split is the point: cutting
// the root probes short costs AX metadata, which degrades to unknown, while
// cutting the walk short costs PAGES. The walk runs on a progress window
// instead — it stops when it stops completing fetches, not when a clock runs
// out — so an honest site with many sitemaps keeps all of them.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { createCrawler, preambleBudgetMs } from "../src/core/crawler";
import { BUDGET_EXHAUSTED_ERROR } from "../src/deadline";
import {
  discoverSitemaps,
  SITEMAP_NOT_REACHED_ERROR,
  SITEMAP_WALK_WINDOW_MS,
  sitemapWalkWindowMs,
} from "../src/sitemaps";
import { WELL_KNOWN_PATHS } from "../src/well-known";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";

// Mirrors SITEMAP_FETCH_CONCURRENCY in src/sitemaps.ts (not exported).
const SITEMAP_FETCH_CONCURRENCY = 5;

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<a href="/one">one</a><a href="/two">two</a></body></html>`;

// The budget is min(45s, timeoutMs × 3), so a 500ms per-request timeout buys a
// 1500ms preamble — the same arithmetic production runs, three orders of
// magnitude faster. Every probe's OWN deadline (15-30s, fixed) is far larger,
// so nothing here can pass on per-request bounds alone.
const TIMEOUT_MS = 500;
const BUDGET_MS = preambleBudgetMs(TIMEOUT_MS);
const WALK_WINDOW_MS = sitemapWalkWindowMs(TIMEOUT_MS);

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 3,
  concurrency: 2,
  perHostConcurrency: 2,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: TIMEOUT_MS,
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

const REAL_PAGES = new Set(["/", "/one", "/two"]);

function htmlResponse(body = PAGE) {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

// 200 headers, then a body stream that is never closed. This is the daigo.ru
// shape: the probe cannot tell from the status line that it will never finish.
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

interface Origin {
  url: string;
  hits: Map<string, number>;
}

// Real pages serve normally; every root-probe path stalls its body. `idleTimeout: 0`
// so the server is never the thing that gives up — the client has to be.
function serveStallingProbes(): Origin {
  const hits = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      return REAL_PAGES.has(path) ? htmlResponse() : stalledBodyResponse();
    },
  });
  servers.push(server);
  // Trailing slash: seeded without it, `response.url` comes back normalized and
  // the seed probe reads that as a redirect, skipping the body read entirely.
  return { url: `http://localhost:${server.port}/`, hits };
}

interface CrawlOutcome {
  crawlId: string;
  crawler: Awaited<ReturnType<typeof Effect.runPromise<Awaited<ReturnType<typeof createCrawler>>>>>;
  pages: number;
  firstPageAfterMs: number | undefined;
  totalMs: number;
}

async function crawl(origin: string, config = CONFIG): Promise<CrawlOutcome> {
  const startedAt = Date.now();
  const crawler = await Effect.runPromise(createCrawler({ config }));

  let firstPageAfterMs: number | undefined;
  // `Stream.fromPubSub` never completes on its own, so this fiber has to be
  // interrupted or it outlives the test.
  const events = Effect.runFork(
    Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
      Effect.sync(() => {
        if (event.type === "page:fetched" && firstPageAfterMs === undefined) {
          firstPageAfterMs = Date.now() - startedAt;
        }
      }),
    ),
  );

  try {
    const crawlId = await Effect.runPromise(crawler.start(origin, origin));
    const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
    return {
      crawlId,
      crawler,
      pages: pages.length,
      firstPageAfterMs,
      totalMs: Date.now() - startedAt,
    };
  } finally {
    await Effect.runPromise(Fiber.interrupt(events));
  }
}

describe("crawl preamble budget (squirrelscan/repo#1733)", () => {
  test("an origin whose root probes stall still reaches its pages inside the budget", async () => {
    const origin = serveStallingProbes();

    const out = await crawl(origin.url);

    expect(out.pages).toBeGreaterThan(0);
    expect(out.firstPageAfterMs).toBeDefined();
    // Bounded by the root-probe budget PLUS the sitemap walk's own progress
    // window (one dead chunk, since this origin completes nothing), not by the
    // sum of every probe's deadline. Still ~50x under the ~180s that sum costs.
    expect(out.firstPageAfterMs!).toBeLessThan((BUDGET_MS + WALK_WINDOW_MS) * 2);
  }, 30_000);

  test("stages after the budget is spent are skipped, not merely deadlined", async () => {
    const origin = serveStallingProbes();

    await crawl(origin.url);

    // robots.txt is the first budgeted stage and it stalls, so it consumes the
    // whole budget on its own. Every optional AX probe downstream must then
    // issue NO request at all — a request that was merely given a short deadline
    // would still show up here, which is exactly how per-request bounds differ
    // from a phase budget.
    expect(origin.hits.get("/robots.txt") ?? 0).toBeGreaterThan(0);
    expect(origin.hits.get("/llms.txt") ?? 0).toBe(0);
    expect(origin.hits.get("/index.md") ?? 0).toBe(0);
    expect(origin.hits.get("/.well-known/mcp.json") ?? 0).toBe(0);

    // Sitemap discovery is the exception, and deliberately so: truncating it
    // costs PAGES rather than AX metadata, so it runs on its own progress
    // window instead of the root probes' budget and still gets its attempt.
    expect(origin.hits.get("/sitemap.xml") ?? 0).toBeGreaterThan(0);
  }, 30_000);

  test("probes cut short by the budget still store their unreachable result", async () => {
    const origin = serveStallingProbes();

    const out = await crawl(origin.url);
    const read = <T>(effect: Effect.Effect<T, unknown, never>) =>
      Effect.runPromise(effect as Effect.Effect<T, never, never>);

    // Every probe's row is still written. A budget that dropped rows instead of
    // storing an "unreachable" shape would silently blank AX data in reports.
    const [robots, llms, markdown, wellKnown, agentAccess, rsl] = await Promise.all([
      read(out.crawler.storage.getRobotsTxt(out.crawlId)),
      read(out.crawler.storage.getLlmsTxt(out.crawlId)),
      read(out.crawler.storage.getMarkdownProbe(out.crawlId)),
      read(out.crawler.storage.getWellKnownProbe(out.crawlId)),
      read(out.crawler.storage.getAgentAccess(out.crawlId)),
      read(out.crawler.storage.getRsl(out.crawlId)),
    ]);

    expect(robots).not.toBeNull();
    expect(robots!.exists).toBe(false);
    // …and WHY, so crawl/robots-txt can tell this apart from a confirmed 404
    // instead of reporting "No robots.txt found" for a file it never reached.
    expect(robots!.error).toBeTruthy();
    expect(llms).not.toBeNull();
    expect(llms!.llmsTxt.exists).toBe(false);
    expect(markdown).not.toBeNull();
    expect(markdown!.servesMarkdown).toBe(false);
    expect(rsl).not.toBeNull();
    expect(rsl!.licenseUrls).toEqual([]);

    // The skipped probes carry the full path/identity list with the budget
    // reason recorded, the same shape an unreachable host produces.
    expect(wellKnown!.probes).toHaveLength(WELL_KNOWN_PATHS.length);
    for (const probe of wellKnown!.probes) {
      expect(probe.status).toBe(0);
      expect(probe.error).toBe(BUDGET_EXHAUSTED_ERROR);
    }
    expect(agentAccess!.probes).toHaveLength(3);
    for (const probe of agentAccess!.probes) {
      expect(probe.error).toBe(BUDGET_EXHAUSTED_ERROR);
    }
  }, 30_000);

  test("a SLOW but healthy origin loses no probe data to the budget", async () => {
    // The guard on the tradeoff: the budget must only ever bite an origin that
    // is actually burning wall clock. Every response here is deliberately slow
    // — instant responses would pass no matter how tight the budget was, and so
    // could not tell a working budget from one that starves honest origins.
    // Seven sequential stages at LATENCY_MS each still fit inside the budget.
    const LATENCY_MS = 80;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        await Bun.sleep(LATENCY_MS);
        const path = new URL(req.url).pathname;
        if (path === "/robots.txt") {
          return new Response("User-agent: *\nSitemap: /sitemap.xml\n", {
            headers: { "content-type": "text/plain" },
          });
        }
        if (path === "/llms.txt") {
          return new Response("# Site\n", { headers: { "content-type": "text/plain" } });
        }
        if (path === "/sitemap.xml") {
          return new Response(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
              `<url><loc>http://localhost:${server.port}/one</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        }
        if (REAL_PAGES.has(path)) return htmlResponse();
        return new Response("nope", { status: 404 });
      },
    });
    servers.push(server);

    const out = await crawl(`http://localhost:${server.port}/`);
    const read = <T>(effect: Effect.Effect<T, unknown, never>) =>
      Effect.runPromise(effect as Effect.Effect<T, never, never>);

    expect(out.pages).toBeGreaterThan(0);

    const robots = await read(out.crawler.storage.getRobotsTxt(out.crawlId));
    const llms = await read(out.crawler.storage.getLlmsTxt(out.crawlId));
    const wellKnown = await read(out.crawler.storage.getWellKnownProbe(out.crawlId));
    const sitemaps = await read(out.crawler.storage.getSitemaps(out.crawlId));

    expect(robots!.exists).toBe(true);
    // No recorded reason: the fetch completed, so nothing downstream has cause
    // to treat this crawl's robots.txt as unconfirmed.
    expect(robots!.error ?? null).toBeNull();
    expect(llms!.llmsTxt.exists).toBe(true);
    // Real 404s, not budget skips: the probes all ran.
    for (const probe of wellKnown!.probes) {
      expect(probe.error).not.toBe(BUDGET_EXHAUSTED_ERROR);
    }
    expect(sitemaps.length).toBeGreaterThan(0);
  }, 30_000);
});

// robots.txt declaring far more sitemaps than one chunk holds, so the walk
// needs many chunks and its progress window is what decides where it stops.
function robotsDeclaring(origin: string, count: number) {
  return {
    exists: true,
    url: `${origin}/robots.txt`,
    content: null,
    sizeBytes: 0,
    sitemaps: Array.from({ length: count }, (_, i) => `${origin}/s${i}.xml`),
    rules: [],
    errors: [],
  };
}

const EMPTY_SITEMAP = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';

describe("sitemap walk progress window (squirrelscan/repo#1733)", () => {
  test("a slow but HEALTHY walk runs to completion and loses no sitemaps", async () => {
    // The reason the walk is not on the root probes' budget. Each fetch here is
    // slower than a whole budget's worth of time, but every one SUCCEEDS, and a
    // site with many legitimate sitemaps must not silently lose the pages they
    // list. Under a fixed preamble budget this walk is cut off partway.
    const RESPONSE_MS = 120;
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch() {
        requests++;
        await Bun.sleep(RESPONSE_MS);
        return new Response(EMPTY_SITEMAP, { headers: { "content-type": "application/xml" } });
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;

    const result = await Effect.runPromise(
      discoverSitemaps(origin, robotsDeclaring(origin, 60), "squirrel-test", {
        maxUrls: 10_000,
        walkWindowMs: WALK_WINDOW_MS,
      }),
    );

    // Every declared sitemap plus the common locations was actually fetched:
    // completing a chunk earns a fresh window, so honest slowness never runs out.
    expect(requests).toBeGreaterThanOrEqual(60);
    expect(result.all.length).toBeGreaterThanOrEqual(60);
    expect(result.truncated).toBe(false);
  }, 30_000);

  test("a STALLED walk stops after roughly one chunk and says so", async () => {
    // The mirror case. Nothing comes back at all, so no chunk earns a fresh
    // window and the walk gives up almost immediately instead of running 68
    // entry points to their individual deadlines. The window is checked per
    // CHUNK, which is what stops the rest of a level being chunked and awaited
    // just to record a skip.
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        requests++;
        return stalledBodyResponse();
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;

    const startedAt = Date.now();
    const result = await Effect.runPromise(
      discoverSitemaps(origin, robotsDeclaring(origin, 60), "squirrel-test", {
        maxUrls: 10_000,
        walkWindowMs: WALK_WINDOW_MS,
      }),
    );
    const elapsed = Date.now() - startedAt;

    // Roughly one chunk of five, not all 68.
    expect(requests).toBeGreaterThan(0);
    expect(requests).toBeLessThan(20);
    expect(elapsed).toBeLessThan(WALK_WINDOW_MS * 4);

    // AC3: nothing vanishes. Every entry point the walk never reached is still
    // recorded, and the result says absence was never established — which is
    // what stops crawl/sitemap-exists reporting "No XML sitemap found".
    expect(result.truncated).toBe(true);
    expect(result.failed.length).toBeGreaterThanOrEqual(60);
    expect(
      result.failed.some((failure) => failure.error === SITEMAP_NOT_REACHED_ERROR),
    ).toBe(true);
  }, 30_000);

  test("a fast 404 counts as progress, so a mixed level is not cut short", async () => {
    // Keying the re-arm off `success` punished a real shape: one quick 404
    // alongside four stalled bodies is a RESPONSIVE origin the walk is getting
    // through, but the chunk finds no sitemap, so the window died after one
    // round and 5 of 68 candidates were ever visited. Only a chunk where
    // nothing came back at all should burn the window.
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        // One in five answers immediately (404); the rest never finish.
        if (requests++ % SITEMAP_FETCH_CONCURRENCY === 0) {
          return new Response("nope", { status: 404 });
        }
        return stalledBodyResponse();
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;

    const result = await Effect.runPromise(
      discoverSitemaps(origin, robotsDeclaring(origin, 60), "squirrel-test", {
        maxUrls: 10_000,
        walkWindowMs: WALK_WINDOW_MS,
        // Generous hard stop: the window, not the cap, is what is under test.
        walkTotalMs: WALK_WINDOW_MS * 40,
      }),
    );

    // It kept going well past the first chunk. Without the fix this stops at 5.
    expect(requests).toBeGreaterThan(SITEMAP_FETCH_CONCURRENCY * 4);
    expect(result.failed.length).toBeGreaterThan(SITEMAP_FETCH_CONCURRENCY);
  }, 60_000);

  test("a slow-drip origin cannot re-arm the window forever", async () => {
    // The progress window on its own is gameable. An origin that answers ONE
    // request per chunk instantly and stalls the other four spends a whole
    // window per chunk and re-arms it every time, so "is making progress" stays
    // true indefinitely. Progress separates a stall from honest slowness; only
    // the hard stop separates honest slowness from a deliberate slow drip.
    let served = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        // One in five completes; the rest never finish their body.
        if (served++ % SITEMAP_FETCH_CONCURRENCY === 0) {
          return new Response(EMPTY_SITEMAP, { headers: { "content-type": "application/xml" } });
        }
        return stalledBodyResponse();
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;

    const startedAt = Date.now();
    const result = await Effect.runPromise(
      discoverSitemaps(origin, robotsDeclaring(origin, 400), "squirrel-test", {
        maxUrls: 10_000,
        walkWindowMs: WALK_WINDOW_MS,
        walkTotalMs: WALK_WINDOW_MS * 3,
      }),
    );
    const elapsed = Date.now() - startedAt;

    // Bounded by the hard stop rather than by the origin's willingness to drip.
    // Without it this runs for 408 entry points x one window each.
    expect(elapsed).toBeLessThan(WALK_WINDOW_MS * 8);
    // And it says it did not finish, so no consumer reads this as "no sitemap".
    expect(result.truncated).toBe(true);
  }, 60_000);
});

describe("sitemapWalkWindowMs / walk hard stop", () => {
  test("scales the progress window down with a tighter per-request timeout", () => {
    expect(sitemapWalkWindowMs(30_000)).toBe(SITEMAP_WALK_WINDOW_MS);
    expect(sitemapWalkWindowMs(500)).toBe(1_500);
    expect(sitemapWalkWindowMs(0)).toBe(3);
  });

  test("a hard stop shorter than the window is honored, not widened to it", async () => {
    // Silently raising a configured cap to the window length is how a bound
    // stops being one. The nearer of the two wins.
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => stalledBodyResponse() });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;

    const startedAt = Date.now();
    await Effect.runPromise(
      discoverSitemaps(origin, robotsDeclaring(origin, 60), "squirrel-test", {
        maxUrls: 10_000,
        walkWindowMs: 2_000,
        walkTotalMs: 200,
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 30_000);
});

describe("preambleBudgetMs", () => {
  test("caps at the ceiling and scales down with a tighter per-request timeout", () => {
    // Default crawl (30s per request): the 45s ceiling binds, NOT 30 × 3.
    expect(preambleBudgetMs(30_000)).toBe(45_000);
    expect(preambleBudgetMs(60_000)).toBe(45_000);
    // A config asking for snappy requests gets a proportionally snappy preamble.
    expect(preambleBudgetMs(10_000)).toBe(30_000);
    expect(preambleBudgetMs(500)).toBe(1_500);
    // Degenerate timeouts must not produce a zero or negative budget, which
    // would skip the preamble outright rather than bounding it.
    expect(preambleBudgetMs(0)).toBe(3);
    expect(preambleBudgetMs(-1)).toBe(3);
  });
});
