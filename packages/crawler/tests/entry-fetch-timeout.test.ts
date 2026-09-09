// squirrelscan/repo#1699 (second failure mode) — an audit that rests on ONE
// fetch must not die on that fetch's first deadline, and when it does die the
// reason has to name the step and the deadline.
//
// The production shape: nuxt.daigo.ru's sitemap lists 449 urls, every one on
// the sister domain, so the frontier is the seed alone; the seed fetch ran
// through the cloud document fetcher under the cloud's 12s deadline, got one
// attempt, and its abort surfaced as `unknown` with the raw runtime text —
// "No pages were crawled from nuxt.daigo.ru: The operation was aborted."
//
// Bun origins here answer 200 with a large HTML body on every path (including
// the soft-404s), carry a sitemap of a few hundred cross-domain urls, and add a
// flat delay before every response. The per-request timeout is a few hundred
// ms so the crawl's deadlines fire the way they do in production, only faster.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import type { DocumentFetcher } from "@squirrelscan/fetchers";
import type { AuditFailureDetail } from "@squirrelscan/core-contracts";
import { auditFailureReasonText } from "@squirrelscan/core-contracts/failure-reason";

import { createCrawler, entryRetryTimeoutMs } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { crawlErrorToFailureDetail, fetchPage } from "../src/fetcher";

const TIMEOUT_MS = 400;

const BIG_PAGE = `<!doctype html><html><head><title>t</title></head><body>
<a href="/one">one</a><a href="/two">two</a>
${"<p>soft body padding so every response is a real download</p>\n".repeat(3_000)}
</body></html>`;

const CROSS_DOMAIN_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Array.from({ length: 300 }, (_, i) => `<url><loc>https://sister.example/page-${i}</loc></url>`).join("\n")}
</urlset>`;

// Quick mode, the cloud's shape: link discovery stays gated on the seed until
// the sitemap turns out to have contributed nothing (#123).
const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 5,
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
  coverageMode: "quick",
  disableLinkDiscovery: true,
};

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

interface Origin {
  url: string;
  hits: Map<string, number>;
}

// 200 on everything: the root and its pages, the sitemap, and a full HTML body
// for every probe path (llms.txt, .well-known/*, index.md) — the soft-404 shape.
function serveSlowSite(ttfbMs: number): Origin {
  const hits = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      await Bun.sleep(ttfbMs);
      if (path === "/robots.txt") {
        return new Response(`User-agent: *\nSitemap: ${new URL("/sitemap.xml", req.url)}\n`, {
          headers: { "content-type": "text/plain" },
        });
      }
      if (path === "/sitemap.xml") {
        return new Response(CROSS_DOMAIN_SITEMAP, {
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response(BIG_PAGE, { headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}/`, hits };
}

// What the cloud document fetcher looks like from the crawler when both the
// render and its plain fallback hit their deadline: one rejection carrying
// Bun's native abort, with no HTTP response ever produced.
function abortingFetcher(): DocumentFetcher & { calls: number } {
  const fetcher = {
    id: "cloud-render",
    calls: 0,
    capabilities: { jsRendering: true, cookies: false, screenshot: false },
    async fetch() {
      fetcher.calls++;
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  };
  return fetcher;
}

interface CrawlOutcome {
  pages: string[];
  warnings: Array<{ code: string; message: string }>;
  rootFailure: AuditFailureDetail | undefined;
  reason: string | undefined;
}

async function crawl(origin: string, config: Partial<CrawlerConfig>): Promise<CrawlOutcome> {
  const crawler = await Effect.runPromise(createCrawler({ config: { ...CONFIG, ...config } }));
  const warnings: CrawlOutcome["warnings"] = [];
  const events = Effect.runFork(
    Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
      Effect.sync(() => {
        if (event.type === "warning") warnings.push({ code: event.code, message: event.message });
      }),
    ),
  );
  try {
    const crawlId = await Effect.runPromise(crawler.start(origin, origin));
    const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
    const stats = await Effect.runPromise(crawler.storage.getStats(crawlId));
    const rootFailure = stats?.rootFailure;
    return {
      pages: pages.map((p) => p.url),
      warnings,
      rootFailure,
      reason: rootFailure ? auditFailureReasonText(rootFailure) : undefined,
    };
  } finally {
    await Effect.runPromise(Fiber.interrupt(events));
  }
}

describe("an abort from a document fetcher is a timeout, not an unknown failure (#1699)", () => {
  test("fetchPage names the fetcher and the deadline instead of the runtime's abort text", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        fetchPage("https://example.com/", {
          userAgent: "squirrel-test",
          timeoutMs: 12_000,
          followRedirects: true,
          fetcher: abortingFetcher(),
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left.type).toBe("timeout");
    expect(result.left.message).toBe("page fetch via cloud-render was aborted (deadline 12000ms)");

    // …and the reason line built from it is the timeout sentence with that
    // detail, classified as `timeout`, never the sentence the run shipped.
    const detail = crawlErrorToFailureDetail(result.left);
    expect(detail.code).toBe("timeout");
    expect(detail.detail).toBe("page fetch via cloud-render was aborted (deadline 12000ms)");
    const reason = auditFailureReasonText(detail);
    expect(reason).toBe(
      "No response from example.com within the request timeout: page fetch via cloud-render was aborted (deadline 12000ms)",
    );
    expect(reason).not.toContain("The operation was aborted");
  });
});

describe("the entry URL gets a second, relaxed-deadline fetch before the audit is given up (#1699)", () => {
  test("a slow origin whose TTFB beats the per-request deadline still yields its entry page", async () => {
    // Slower than the crawl's deadline, faster than the entry retry's.
    const origin = serveSlowSite(TIMEOUT_MS + 200);

    const out = await crawl(origin.url, {});

    expect(out.pages).toContain(origin.url);
    expect(out.warnings.map((w) => w.code)).toContain("entry-fetch-retried");
    const retry = out.warnings.find((w) => w.code === "entry-fetch-retried")!;
    expect(retry.message).toContain(`${entryRetryTimeoutMs(TIMEOUT_MS)}ms`);
  }, 30_000);

  test("a document fetcher that aborts the entry falls back to a plain fetch and collects pages", async () => {
    const origin = serveSlowSite(0);
    const fetcher = abortingFetcher();

    const out = await crawl(origin.url, { documentFetcher: fetcher });

    // The crawl reached its pages through the plain retry — the seed first, and
    // link discovery (re-enabled because the sitemap contributed nothing) after.
    expect(out.pages).toContain(origin.url);
    // Discovered pages still go through the aborting fetcher and fail; they
    // never get the retry, and their failure is recorded under `sitemap`, not
    // as the ENTRY's failure — the entry landed.
    expect(out.rootFailure?.source).not.toBe("entry");
    expect(out.warnings.filter((w) => w.code === "entry-fetch-retried")).toHaveLength(1);
  }, 30_000);

  test("a corpus already stored never pays the retry", async () => {
    const origin = serveSlowSite(0);
    let seen = 0;
    // Serves the seed, then aborts everything after it.
    const fetcher: DocumentFetcher = {
      id: "cloud-render",
      capabilities: { jsRendering: true, cookies: false, screenshot: false },
      async fetch(req) {
        if (seen++ > 0) throw new DOMException("The operation was aborted.", "AbortError");
        const res = await fetch(req.url);
        const body = await res.text();
        const now = Date.now();
        return {
          status: res.status,
          headers: { "content-type": "text/html" },
          body,
          finalUrl: req.url,
          redirectChain: {
            sourceUrl: req.url,
            finalUrl: req.url,
            hops: [{ url: req.url, statusCode: res.status, type: "http" as const }],
            chainLength: 0,
            isLoop: false,
            endsInError: false,
            httpsToHttp: false,
            httpToHttps: false,
          },
          timing: { startedAt: now, responseAt: now, finishedAt: now },
        };
      },
    };

    const out = await crawl(origin.url, { documentFetcher: fetcher });

    expect(out.pages).toContain(origin.url);
    expect(out.warnings.map((w) => w.code)).not.toContain("entry-fetch-retried");
  }, 30_000);

  test("when nothing at all can be fetched, the reason names the step and both deadlines", async () => {
    // Slower than the retry's deadline too: the entry is genuinely unreachable
    // inside any bound this crawl has.
    const origin = serveSlowSite(entryRetryTimeoutMs(TIMEOUT_MS) + 400);

    const out = await crawl(origin.url, { documentFetcher: abortingFetcher() });

    expect(out.pages).toEqual([]);
    expect(out.rootFailure?.code).toBe("timeout");
    expect(out.rootFailure?.host).toBe("localhost");
    expect(out.reason).toContain("within the request timeout");
    expect(out.reason).toContain(
      `entry page failed at ${TIMEOUT_MS}ms via cloud-render, then a ${entryRetryTimeoutMs(TIMEOUT_MS)}ms plain retry timed out`,
    );
    expect(out.reason).not.toContain("The operation was aborted");
  }, 30_000);
});

describe("preamble budget expiry degrades and says so (#1699)", () => {
  test("an origin that stalls every root probe still crawls, with one warning naming the budget", async () => {
    // 200 headers, then a body that never finishes — the shape that burns a
    // whole budget on the first probe. Real pages serve normally.
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<!doctype html><html><body>"));
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        return path === "/" || path === "/one" || path === "/two"
          ? new Response(BIG_PAGE, { headers: { "content-type": "text/html" } })
          : stalled();
      },
    });
    servers.push(server);

    const out = await crawl(`http://localhost:${server.port}/`, {
      coverageMode: "full",
      disableLinkDiscovery: false,
    });

    expect(out.pages.length).toBeGreaterThan(0);
    const exhausted = out.warnings.filter((w) => w.code === "preamble-budget-exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.message).toContain("preamble budget ran out");
    // Every other failure surface stays quiet: nothing here is a crawl failure.
    expect(out.rootFailure).toBeUndefined();
  }, 30_000);
});
