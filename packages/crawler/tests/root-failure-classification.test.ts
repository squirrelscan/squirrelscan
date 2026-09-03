// #1822 - the crawler must record WHY the entry URL could not be audited.
//
// Before this, every zero-page crawl ended with one string ("No pages were
// crawled"): the fetcher knew it was a dead socket, an expired certificate or a
// 403, and `deriveAuditStatusFromPages` never saw any of it. `CrawlStats
// .rootFailure` carries that classification out of the crawl, so the report,
// the failure email and Sentry can all branch on the cause.

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Stream } from "effect";

import type { CrawlStats } from "@squirrelscan/core-contracts";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";
import {
  applyStatusGuards,
  crawlErrorToFailureDetail,
  CrawlError,
  type CrawlFetcher,
} from "../src/fetcher";
import type { CrawlerConfig } from "../src/core/types";

const ORIGIN = "https://example.com";
const URL_ROOT = `${ORIGIN}/`;

describe("crawlErrorToFailureDetail (#1822)", () => {
  test("DNS: a resolver failure is named, not reported as a generic network error", () => {
    const detail = crawlErrorToFailureDetail(
      CrawlError.network(URL_ROOT, "getaddrinfo ENOTFOUND example.com"),
    );
    expect(detail.code).toBe("dns");
    expect(detail.host).toBe("example.com");
    expect(detail.source).toBe("entry");
  });

  test("DNS: an NXDOMAIN phrased by a different runtime classifies the same", () => {
    expect(
      crawlErrorToFailureDetail(CrawlError.network(URL_ROOT, "DNS lookup failed: NXDOMAIN")).code,
    ).toBe("dns");
  });

  test("TLS: the runtime message is kept but the doubled prefix is dropped", () => {
    const detail = crawlErrorToFailureDetail(CrawlError.tls(URL_ROOT, "certificate has expired"));
    expect(detail.code).toBe("tls");
    expect(detail.detail).toBe("certificate has expired");
  });

  test("connection: the ejconsultor.es case (socket closed after the handshake)", () => {
    // The exact message the failed production runs in #1822 carried.
    const detail = crawlErrorToFailureDetail(
      CrawlError.network(URL_ROOT, "The socket connection was closed unexpectedly"),
    );
    expect(detail.code).toBe("connection");
  });

  test("connection: refused and reset sockets classify alongside it", () => {
    expect(
      crawlErrorToFailureDetail(CrawlError.network(URL_ROOT, "connect ECONNREFUSED 10.0.0.1:443"))
        .code,
    ).toBe("connection");
    expect(crawlErrorToFailureDetail(CrawlError.network(URL_ROOT, "read ECONNRESET")).code).toBe(
      "connection",
    );
  });

  test("timeout: an aborted request is a timeout, not a connection failure", () => {
    expect(crawlErrorToFailureDetail(CrawlError.timeout(URL_ROOT)).code).toBe("timeout");
  });

  test("http_4xx: a refusal carries the status the guard saw", () => {
    const detail = crawlErrorToFailureDetail(CrawlError.blocked(URL_ROOT));
    expect(detail.code).toBe("http_4xx");
    expect(detail.status).toBe(403);
  });

  test("http_4xx: a rate limit is a 429 refusal, not a server error", () => {
    const detail = crawlErrorToFailureDetail(CrawlError.rateLimit(URL_ROOT, 30));
    expect(detail.code).toBe("http_4xx");
    expect(detail.status).toBe(429);
  });

  test("http_5xx: a server error keeps its status and stays attributed to the origin", () => {
    const detail = crawlErrorToFailureDetail(CrawlError.network(URL_ROOT, "Server error: 503", 503));
    expect(detail.code).toBe("http_5xx");
    expect(detail.status).toBe(503);
  });

  test("unknown: an unattributable message keeps its text rather than vanishing", () => {
    const detail = crawlErrorToFailureDetail(
      CrawlError.network(URL_ROOT, "something we have never seen"),
    );
    expect(detail.code).toBe("unknown");
    // "unknown" must never read as "nothing failed": the text still travels.
    expect(detail.detail).toBe("something we have never seen");
  });

  test("origin-influenced text is stripped and capped before it reaches a reason", () => {
    const esc = String.fromCharCode(27);
    const detail = crawlErrorToFailureDetail(
      CrawlError.tls(URL_ROOT, `bad${esc}[2Jcert ${"x".repeat(400)}`),
    );
    expect(detail.detail).not.toContain(esc);
    expect(detail.detail!.length).toBeLessThanOrEqual(120);
  });

  test("an absolute URL in a runtime message is reduced to its host", () => {
    // A reason is quoted in an email and a markdown report; the path and query
    // of a site-chosen URL have no business in either.
    const detail = crawlErrorToFailureDetail(
      CrawlError.network(URL_ROOT, "Failed to fetch https://evil.example/private?token=abc123"),
    );
    expect(detail.detail).toContain("evil.example");
    expect(detail.detail).not.toContain("/private");
    expect(detail.detail).not.toContain("token=abc123");
  });

  test("markdown and HTML structure characters are dropped from the detail", () => {
    const detail = crawlErrorToFailureDetail(
      CrawlError.network(URL_ROOT, "bad [link](https://evil.example) <img> `code` a|b"),
    );
    for (const char of ["[", "]", "<", ">", "`", "|"]) {
      expect(detail.detail).not.toContain(char);
    }
  });

  test("a sitemap URL's failure is marked as the weaker source", () => {
    expect(crawlErrorToFailureDetail(CrawlError.timeout(URL_ROOT), "sitemap").source).toBe(
      "sitemap",
    );
  });
});

describe("applyStatusGuards carries the status for classification (#1822)", () => {
  async function guard(status: number, body?: string, headers?: Record<string, string>) {
    const result = await Effect.runPromise(
      Effect.either(applyStatusGuards(URL_ROOT, status, new Headers(headers), body)),
    );
    return result._tag === "Left" ? result.left : null;
  }

  test("403 and 429 guards set the status they matched on", async () => {
    expect((await guard(403))?.status).toBe(403);
    expect((await guard(429))?.status).toBe(429);
  });

  test("a 5xx guard sets the status so it classifies as http_5xx", async () => {
    const error = await guard(502);
    expect(error?.status).toBe(502);
    expect(crawlErrorToFailureDetail(error!).code).toBe("http_5xx");
  });

  test("a Cloudflare challenge 503 stays a 4xx-shaped refusal, not a server error", async () => {
    const error = await guard(503, undefined, { "cf-mitigated": "challenge" });
    expect(error?.type).toBe("blocked");
    const detail = crawlErrorToFailureDetail(error!);
    expect(detail.code).toBe("http_4xx");
    expect(detail.detail).toContain("Cloudflare");
  });
});

// ----------------------------------------------------------------------------
// End to end: the classification has to survive the crawl loop and land on the
// persisted stats, which is the only thing the report builder reads.
// ----------------------------------------------------------------------------

const EMPTY_RESPONSE_HEADERS = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  expires: null,
  vary: null,
  etag: null,
  server: null,
  lastModified: null,
  link: null,
  serverTiming: null,
  age: null,
  xCache: null,
  cfCacheStatus: null,
  xVercelCache: null,
  altSvc: null,
  acceptRanges: null,
} as const;
const EMPTY_SECURITY_HEADERS = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
} as const;

const BASE_CONFIG: Partial<CrawlerConfig> = {
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 500,
  userAgent: "test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: true,
  coverageMode: "full",
  maxPages: 2,
};

/** A fetcher that always fails the way one real world origin does. */
function failingFetcher(error: CrawlError): CrawlFetcher {
  return () => Effect.fail(error);
}

/** A fetcher that answers every URL with 200 and the given HTML body. */
function htmlFetcher(body: string): CrawlFetcher {
  return (url) => statusFetcher(200, body)(url);
}

/** A fetcher that answers every URL with one status and an optional body. */
function statusFetcher(status: number, body = ""): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      yield* applyStatusGuards(url, status, new Headers(), body);
      return {
        url,
        finalUrl: url,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html" },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType: "text/html",
        body,
        sizeBytes: body.length,
        redirectChain: {
          sourceUrl: url,
          finalUrl: url,
          hops: [],
          chainLength: 0,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
        fetcherId: undefined,
        fallbackReason: undefined,
      };
    });
}

/** Stub the root probes (robots.txt, llms.txt, sitemaps) so they cost nothing. */
function withStubbedRootProbes<T>(robotsBody: string, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const isRobots = url.endsWith("/robots.txt");
    const res = new Response(isRobots ? robotsBody : "", {
      status: isRobots ? 200 : 404,
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return Promise.resolve(res);
  }) as typeof globalThis.fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function runCrawl(
  fetcher: CrawlFetcher,
  config: Partial<CrawlerConfig> = {},
): Promise<CrawlStats | null> {
  const program = Effect.gen(function* () {
    const storage = yield* createTestStorage();
    const crawler = yield* createCrawler({
      fetcher,
      storage,
      config: { ...BASE_CONFIG, ...config },
    });
    const drain = yield* Stream.runDrain(
      crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
    ).pipe(Effect.fork);
    yield* Effect.yieldNow();
    yield* crawler.start(ORIGIN).pipe(Effect.timeout(Duration.seconds(10)), Effect.either);
    const crawlId = crawler.currentCrawlId!;
    yield* Effect.ignore(drain.await);
    return yield* storage.getStats(crawlId).pipe(Effect.orElseSucceed(() => null));
  });
  return Effect.runPromise(program);
}

describe("the classification reaches CrawlStats (#1822)", () => {
  test("a dead socket on the entry URL is recorded as a connection failure", async () => {
    const stats = await withStubbedRootProbes("", () =>
      runCrawl(
        failingFetcher(
          CrawlError.network(URL_ROOT, "The socket connection was closed unexpectedly"),
        ),
      ),
    );
    expect(stats?.pagesFetched).toBe(0);
    expect(stats?.rootFailure?.code).toBe("connection");
    expect(stats?.rootFailure?.host).toBe("example.com");
    expect(stats?.rootFailure?.source).toBe("entry");
  });

  test("a 404 entry URL is a stored page, and is still recorded as a 4xx failure", async () => {
    // 404 passes applyStatusGuards, so it never reaches the fetch error path:
    // it is stored as a page and the stats are the only place the class lands.
    const stats = await withStubbedRootProbes("", () => runCrawl(statusFetcher(404)));
    expect(stats?.rootFailure?.code).toBe("http_4xx");
    expect(stats?.rootFailure?.status).toBe(404);
  });

  test("a 403 entry URL keeps its blocked accounting AND records the class", async () => {
    const stats = await withStubbedRootProbes("", () => runCrawl(statusFetcher(403)));
    // #792's signal is untouched, so the run still classifies as `blocked`.
    expect(stats?.pagesBlocked).toBe(1);
    expect(stats?.rootFailure?.code).toBe("http_4xx");
    expect(stats?.rootFailure?.status).toBe(403);
  });

  test("later successful page stores cannot erase a recorded failure", async () => {
    // `updateStats` is a read-modify-write and the storage merge is a plain
    // spread of the whole stats object, so before #1822's in-memory authority a
    // worker holding a stale read wrote its own (empty) rootFailure back over a
    // recorded one. Here one sub-page 500s and several more succeed AFTER it,
    // each running its own read-modify-write at concurrency 4.
    const links = ["/p0", "/p1", "/p2", "/p3", "/p4"];
    const anchors = links.map((h) => `<a href="${ORIGIN}${h}">${h}</a>`).join("");
    const fetcher: CrawlFetcher = (url) => {
      if (url === `${ORIGIN}/p0`) {
        return Effect.fail(CrawlError.network(url, "Server error: 500", 500));
      }
      const body = url === URL_ROOT ? `<!doctype html><html><body>${anchors}</body></html>` : "";
      return htmlFetcher(body)(url);
    };
    const stats = await withStubbedRootProbes("", () =>
      runCrawl(fetcher, { maxPages: 10, concurrency: 4, disableLinkDiscovery: false }),
    );
    // The successful stores ran, and the one failure is still on the row.
    expect(stats?.pagesFetched).toBeGreaterThan(1);
    expect(stats?.rootFailure?.code).toBe("http_5xx");
    expect(stats?.rootFailure?.status).toBe(500);
  });

  test("a robots.txt that disallows the seed is recorded before any fetch", async () => {
    const stats = await withStubbedRootProbes("User-agent: *\nDisallow: /", () =>
      runCrawl(statusFetcher(200), { respectRobots: true }),
    );
    expect(stats?.rootFailure?.code).toBe("robots");
    expect(stats?.rootFailure?.host).toBe("example.com");
  });
});
