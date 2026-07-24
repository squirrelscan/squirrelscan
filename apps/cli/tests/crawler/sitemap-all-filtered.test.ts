// Regression test for issue #123: in quick mode, link discovery was gated on
// `sitemapUrlCount` (URLs *found*), so a sitemap of only robots-disallowed
// paths kept discovery OFF and an allowed seed could never reach the rest of
// the site. The fix gates on `sitemapPendingCount` (URLs that became pending
// after robots/scope filtering); 0 re-enables discovery.
//
// Full-flow harness: `crawler.start(url)` drives the real pipeline — redirect
// detection / robots.txt / sitemap discovery hit `globalThis.fetch` (mocked &
// restored per test); pages go through the injected `documentFetcher`.

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../../src/crawler/core";
import { createTestStorage } from "../../src/crawler/storage";

const ORIGIN = "https://example.test";
const SEED = `${ORIGIN}/`;
const ABOUT = `${ORIGIN}/about`;
const CONTACT = `${ORIGIN}/contact`;
// Sitemap lists only robots-disallowed paths (under /blog/).
const BLOG_1 = `${ORIGIN}/blog/post-1`;
const BLOG_2 = `${ORIGIN}/blog/post-2`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ROBOTS_TXT = ["User-agent: *", "Disallow: /blog/", ""].join("\n");

const SITEMAP_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `<url><loc>${BLOG_1}</loc></url>`,
  `<url><loc>${BLOG_2}</loc></url>`,
  "</urlset>",
].join("");

const html = (links: string[] = []): string =>
  `<!doctype html><html><head><title>t</title></head><body>${links
    .map((href) => `<a href="${href}">l</a>`)
    .join("")}</body></html>`;

// Mock the non-document fetches `start()` makes: redirect detection (GET
// seed), robots.txt, and sitemap discovery. `sitemapResponder(path)` serves a
// sitemap (or 404) for each common sitemap location the crawler probes.
function installFetchMock(opts: {
  robots: string;
  sitemapResponder: (path: string) => string | null;
  seedHtml: string;
}): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const { pathname } = new URL(url);

    const respond = (
      body: string,
      status = 200,
      contentType = "text/html"
    ): Response => {
      const res = new Response(body, {
        status,
        headers: { "content-type": contentType },
      });
      // `start()`'s redirect detection compares `response.url` to the request
      // URL to decide whether a redirect happened. A constructed Response has
      // an empty `.url`, which would read as a (false) redirect — pin it.
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return res;
    };

    if (pathname === "/robots.txt") {
      return respond(opts.robots, 200, "text/plain");
    }
    if (pathname.endsWith(".xml")) {
      const body = opts.sitemapResponder(pathname);
      return body === null
        ? respond("", 404)
        : respond(body, 200, "application/xml");
    }
    if (pathname === "/") {
      return respond(opts.seedHtml);
    }
    // Anything else (shouldn't be hit via globalThis.fetch in these tests).
    return respond("", 404);
  }) as typeof fetch;
}

function makeConfig() {
  return {
    maxPages: 50,
    concurrency: 4,
    perHostConcurrency: 2,
    delayMs: 0,
    perHostDelayMs: 0,
    timeoutMs: 5000,
    userAgent: "test",
    followRedirects: true,
    respectRobots: true,
    incremental: false,
    include: [] as string[],
    exclude: [] as string[],
    allowQueryParams: [] as string[],
    dropQueryPrefixes: [] as string[],
    allowedDomains: ["example.test"],
    breadthFirst: true,
    maxPrefixBudgetRatio: 0.25,
    coverageMode: "quick" as const,
    disableLinkDiscovery: true,
    sitemapUrlCount: 0,
    sitemapPendingCount: 0,
  };
}

/**
 * Document fetcher serving HTML per URL. The seed links to `seedLinks`;
 * every other URL is a terminal leaf with no links.
 */
function makePageFetcher(seedLinks: string[]): {
  fetcher: DocumentFetcher;
  fetched: string[];
} {
  const fetched: string[] = [];
  const fetcher: DocumentFetcher = {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      fetched.push(req.url);
      const body = req.url === SEED ? html(seedLinks) : html();
      return {
        url: req.url,
        finalUrl: req.url,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body,
        timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
        redirectChain: {
          sourceUrl: req.url,
          finalUrl: req.url,
          hops: [{ url: req.url, statusCode: 200, type: "http" as const }],
          chainLength: 0,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
      };
    },
  };
  return { fetcher, fetched };
}

describe("sitemap all-filtered (issue #123)", () => {
  test("terminates cleanly and still crawls the seed when every sitemap URL is robots-disallowed", async () => {
    installFetchMock({
      robots: ROBOTS_TXT,
      sitemapResponder: (path) =>
        path === "/sitemap.xml" ? SITEMAP_XML : null,
      // Seed with no links: the only crawlable page is the seed itself.
      seedHtml: html(),
    });

    const storage = await Effect.runPromise(createTestStorage());
    try {
      const { fetcher, fetched } = makePageFetcher([]);
      const crawler = await Effect.runPromise(
        createCrawler({
          config: { ...makeConfig(), documentFetcher: fetcher },
          storage,
        })
      );

      // Must return (no hang). The crawl loop terminating cleanly is the
      // primary assertion — the test itself would time out on a regression.
      const crawlId = await Effect.runPromise(crawler.start(SEED));

      const pages = await Effect.runPromise(storage.getPages(crawlId));
      const pageUrls = pages.map((p) => p.normalizedUrl).sort();

      // Seed handled; no robots-disallowed /blog/ pages crawled.
      expect(pageUrls).toEqual([SEED]);
      expect(fetched).toEqual([SEED]);
      expect(crawler.isRunning).toBe(false);
    } finally {
      await Effect.runPromise(storage.close());
    }
  }, 30000);

  test("re-enables link discovery so allowed pages linked from the seed are crawled", async () => {
    installFetchMock({
      robots: ROBOTS_TXT,
      sitemapResponder: (path) =>
        path === "/sitemap.xml" ? SITEMAP_XML : null,
      // Seed links to two allowed pages (not in the sitemap).
      seedHtml: html([ABOUT, CONTACT]),
    });

    const storage = await Effect.runPromise(createTestStorage());
    try {
      const { fetcher, fetched } = makePageFetcher([ABOUT, CONTACT]);
      const crawler = await Effect.runPromise(
        createCrawler({
          config: { ...makeConfig(), documentFetcher: fetcher },
          storage,
        })
      );

      const crawlId = await Effect.runPromise(crawler.start(SEED));

      const pages = await Effect.runPromise(storage.getPages(crawlId));
      const pageUrls = pages.map((p) => p.normalizedUrl).sort();

      // The bug: only the seed is crawled (discovery stays off because the
      // sitemap "had" URLs). The fix: discovery re-enables, so the seed's
      // links are followed and the allowed pages are crawled.
      expect(pageUrls).toEqual([ABOUT, CONTACT, SEED].sort());
      expect([...fetched].sort()).toEqual([ABOUT, CONTACT, SEED].sort());
      // robots-disallowed pages never fetched.
      expect(fetched).not.toContain(BLOG_1);
      expect(fetched).not.toContain(BLOG_2);
    } finally {
      await Effect.runPromise(storage.close());
    }
  }, 30000);

  test("#790: respectRobots=false still discovers the robots.txt-declared sitemap and does not enforce Disallow", async () => {
    // A dedicated (non-common-location) sitemap path declared only via the
    // robots.txt `Sitemap:` directive — proves discovery reads it, not just
    // the common-location probe list.
    const CUSTOM_SITEMAP = `${ORIGIN}/custom/blog-sitemap.xml`;
    const robotsWithSitemap = [
      "User-agent: *",
      "Disallow: /blog/",
      `Sitemap: ${CUSTOM_SITEMAP}`,
      "",
    ].join("\n");

    installFetchMock({
      robots: robotsWithSitemap,
      sitemapResponder: (path) =>
        path === "/custom/blog-sitemap.xml" ? SITEMAP_XML : null,
      seedHtml: html(),
    });

    const storage = await Effect.runPromise(createTestStorage());
    try {
      const { fetcher, fetched } = makePageFetcher([]);
      const crawler = await Effect.runPromise(
        createCrawler({
          config: {
            ...makeConfig(),
            respectRobots: false,
            documentFetcher: fetcher,
          },
          storage,
        })
      );

      const crawlId = await Effect.runPromise(crawler.start(SEED));

      // robots.txt was still fetched and stored even with respectRobots off.
      const robotsTxt = await Effect.runPromise(storage.getRobotsTxt(crawlId));
      expect(robotsTxt?.exists).toBe(true);
      expect(robotsTxt?.sitemaps).toContain(CUSTOM_SITEMAP);

      const pages = await Effect.runPromise(storage.getPages(crawlId));
      const pageUrls = pages.map((p) => p.normalizedUrl).sort();

      // Disallow is NOT enforced: the robots-disallowed /blog/ sitemap pages
      // are crawled, unlike the respectRobots=true case above.
      expect(pageUrls).toEqual([BLOG_1, BLOG_2, SEED].sort());
      expect([...fetched].sort()).toEqual([BLOG_1, BLOG_2, SEED].sort());
    } finally {
      await Effect.runPromise(storage.close());
    }
  }, 30000);

  test("pre-existing path: no sitemap found keeps link discovery enabled", async () => {
    // Coverage completeness (not the regression): when no sitemap exists at
    // all, sitemapUrlCount === 0 and sitemapPendingCount === 0 — discovery has
    // always been enabled here. Guards against the fix accidentally narrowing
    // this happy path. robots allows everything (no Disallow).
    installFetchMock({
      robots: "User-agent: *\n",
      sitemapResponder: () => null, // every sitemap location 404s
      seedHtml: html([ABOUT, CONTACT]),
    });

    const storage = await Effect.runPromise(createTestStorage());
    try {
      const { fetcher, fetched } = makePageFetcher([ABOUT, CONTACT]);
      const crawler = await Effect.runPromise(
        createCrawler({
          config: { ...makeConfig(), documentFetcher: fetcher },
          storage,
        })
      );

      const crawlId = await Effect.runPromise(crawler.start(SEED));

      const pages = await Effect.runPromise(storage.getPages(crawlId));
      const pageUrls = pages.map((p) => p.normalizedUrl).sort();

      expect(pageUrls).toEqual([ABOUT, CONTACT, SEED].sort());
      expect([...fetched].sort()).toEqual([ABOUT, CONTACT, SEED].sort());
    } finally {
      await Effect.runPromise(storage.close());
    }
  }, 30000);
});
