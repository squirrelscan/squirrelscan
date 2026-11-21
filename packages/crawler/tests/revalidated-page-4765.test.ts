// repo#4765: a revalidated page keeps its stored body and takes its headers
// from the response that revalidated it.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { FetchResult } from "../src/fetcher";
import type { PageRecord } from "../src/storage/types";

import { createConditionalRenderDocumentFetcher } from "../../fetchers/src/conditional-render";
import { createCrawler } from "../src/core/crawler";
import { revalidatedPage } from "../src/core/revalidated-page";
import { createTestStorage } from "../src/storage";

const NOINDEX = "noindex, nofollow";

function stored(): PageRecord {
  return {
    url: "https://shop.invalid/about",
    normalizedUrl: "https://shop.invalid/about",
    finalUrl: "https://shop.invalid/about",
    depth: 0,
    parentUrl: null,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 900,
    fetchedAt: 1,
    etag: '"v1"',
    lastModified: null,
    contentHash: "hash",
    html: "<html>stored</html>",
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentTypeCharset: "utf-8",
      contentEncoding: null,
      cacheControl: "max-age=0",
      vary: null,
      etag: '"v1"',
      server: "old",
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: "max-age=1",
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: NOINDEX,
    },
    fetcherId: "cloud-render",
  } as unknown as PageRecord; // parentUrl: null mirrors a stored row
}

function result(over: {
  status?: number;
  headers?: Partial<FetchResult["headers"]>;
  securityHeaders?: Partial<FetchResult["securityHeaders"]>;
  synthesizedNotModified?: boolean;
}): FetchResult {
  return {
    url: "https://shop.invalid/about",
    finalUrl: "https://shop.invalid/about",
    status: over.status ?? 304,
    loadTime: 5,
    headers: { ...over.headers } as FetchResult["headers"],
    securityHeaders: {
      ...over.securityHeaders,
    } as FetchResult["securityHeaders"],
    contentType: null,
    body: "",
    sizeBytes: 0,
    redirectChain: {
      sourceUrl: "https://shop.invalid/about",
      finalUrl: "https://shop.invalid/about",
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
    fetcherId: "fetch",
    synthesizedNotModified: over.synthesizedNotModified,
  };
}

describe("revalidatedPage", () => {
  test("a complete header set replaces the stored one: a dropped X-Robots-Tag is gone", () => {
    const page = revalidatedPage(stored(), {
      result: result({
        status: 200,
        headers: { contentType: "text/html; charset=utf-8", server: "new" },
        securityHeaders: { hsts: "max-age=2" },
      }),
      completeHeaders: true,
      lastModified: null,
      requestHeaders: { "user-agent": "ua" },
      now: 99,
    });
    expect(page.securityHeaders.xRobotsTag).toBeNull();
    expect(page.securityHeaders.hsts).toBe("max-age=2");
    expect(page.headers.server).toBe("new");
    expect(page.headers.etag).toBeNull();
    expect(page.etag).toBeNull();
    // The body and how it was produced are the stored copy's.
    expect(page.html).toBe("<html>stored</html>");
    expect(page.loadTimeMs).toBe(900);
    expect(page.fetcherId).toBe("cloud-render");
    expect(page.fetchedAt).toBe(99);
    expect(page.requestHeaders).toEqual({ "user-agent": "ua" });
  });

  test("an origin's 304 overlays what it resends and keeps what it omits (RFC 9111 4.3.4)", () => {
    const page = revalidatedPage(stored(), {
      result: result({
        headers: { etag: '"v1"', cacheControl: "max-age=60" },
        securityHeaders: { xRobotsTag: "index, follow" },
      }),
      completeHeaders: false,
      lastModified: null,
      requestHeaders: {},
      now: 99,
    });
    expect(page.securityHeaders.xRobotsTag).toBe("index, follow");
    expect(page.headers.cacheControl).toBe("max-age=60");
    // Omitted by the 304: kept.
    expect(page.securityHeaders.hsts).toBe("max-age=1");
    expect(page.headers.server).toBe("old");
    // A 304 has no body, so it says nothing about the content type.
    expect(page.headers.contentType).toBe("text/html");
    expect(page.headers.contentTypeCharset).toBe("utf-8");
    expect(page.etag).toBe('"v1"');
  });
});

// Through a real crawl: the conditional-render gate reuses a stored render when
// the source is unchanged by synthesizing a 304 from its plain-HTTP probe. That
// probe is a full 200, so its headers are the page's current set.
describe("conditional-render reuse takes the probe's headers (repo#4765)", () => {
  const ORIGIN = "http://shop.invalid";
  const BODY =
    "<!doctype html><html><head><title>About</title></head><body>nuts</body></html>";

  function response(
    url: string,
    headers: Record<string, string>,
    method?: string
  ): FetchResponse {
    return {
      url,
      finalUrl: url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
      body: BODY,
      timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
      ...(method ? { fetcherMethod: method } : {}),
      redirectChain: {
        sourceUrl: url,
        finalUrl: url,
        hops: [{ url, statusCode: 200, type: "http" as const }],
        chainLength: 0,
        isLoop: false,
        endsInError: false,
        httpsToHttp: false,
        httpToHttps: false,
      },
    };
  }

  test("render once with X-Robots-Tag, reuse after the site drops it: the reused page has none", async () => {
    let robots: string | null = NOINDEX;
    const siteHeaders = (): Record<string, string> =>
      robots ? { "x-robots-tag": robots } : {};
    let renders = 0;
    const gate = createConditionalRenderDocumentFetcher({
      http: {
        id: "fetch",
        capabilities: { jsRendering: false, cookies: true, screenshot: false },
        fetch: async (req) => response(req.url, siteHeaders()),
      } satisfies DocumentFetcher,
      render: {
        id: "cloud-render",
        capabilities: { jsRendering: true, cookies: false, screenshot: false },
        fetch: async (req) => {
          renders++;
          return response(req.url, siteHeaders(), "cloud-render");
        },
      } satisfies DocumentFetcher,
    });

    const storage = await Effect.runPromise(createTestStorage());
    const crawl = async () => {
      const crawler = await Effect.runPromise(
        createCrawler({
          storage,
          config: {
            maxPages: 1,
            concurrency: 1,
            perHostConcurrency: 1,
            delayMs: 0,
            perHostDelayMs: 0,
            timeoutMs: 5_000,
            userAgent: "squirrel-test",
            respectRobots: false,
            incremental: true,
            useCacheControl: false,
            allowedDomains: ["shop.invalid"],
            documentFetcher: gate,
          },
        })
      );
      const crawlId = await Effect.runPromise(
        crawler.start(`${ORIGIN}/`, `${ORIGIN}/`)
      );
      const stats = await Effect.runPromise(storage.getStats(crawlId));
      const [page] = await Effect.runPromise(storage.getPages(crawlId));
      return { stats, page };
    };

    const first = await crawl();
    expect(renders).toBe(1);
    expect(first.page?.securityHeaders.xRobotsTag).toBe(NOINDEX);

    robots = null;
    const second = await crawl();
    // Reused through the synthesized 304, no second render...
    expect(renders).toBe(1);
    expect(second.stats?.cacheHitsByReason?.["304"]).toBe(1);
    // ...and the header the site stopped sending is not on the page.
    expect(second.page?.securityHeaders.xRobotsTag).toBeNull();
    expect(second.page?.html).toBe(first.page?.html);

    await Effect.runPromise(storage.close());
  }, 30_000);
});
