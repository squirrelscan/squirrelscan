// Set-Cookie must never reach a report (#973/#1035). Cookie values are
// crawl-session artifacts, not report content.
//
// The report used to carry each page's `responseHeaders` with Set-Cookie
// stripped out of it. Since #1938 it carries no response headers at all —
// nothing read them — so the guarantee is now structural rather than a strip
// that could be forgotten. These tests assert the stronger property: the
// header is not on the page in any form.

import type { PageRecord } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { AuditReport } from "@/types";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(eff));
}

async function freshCrawl(pages: PageRecord[]): Promise<{
  store: SQLiteStorage;
  crawlId: string;
}> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      seedUrl: SITE,
      originalUrl: SITE,
      startedAt: Date.now(),
      status: "analyzed",
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 30000,
        userAgent: "test",
        followRedirects: true,
        respectRobots: false,
        incremental: false,
        include: [],
        exclude: [],
        allowQueryParams: [],
        dropQueryPrefixes: [],
        allowedDomains: [],
      },
      stats: {
        pagesTotal: pages.length,
        pagesFetched: pages.length,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      },
    })
  );
  for (const page of pages) await run(store.upsertPage(crawlId, page));
  return { store, crawlId };
}

function pageWithSetCookie(setCookie: string | null): PageRecord {
  return {
    url: SITE,
    normalizedUrl: SITE,
    finalUrl: SITE,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 0,
    loadTimeMs: 0,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: null,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: "nginx",
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
      setCookie,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  };
}

/**
 * The whole page, as JSON, so the assertion sees the runtime shape rather than
 * the static type. A cookie hiding under a field the type does not declare
 * would still be a leak.
 */
function pageJson(report: AuditReport): string {
  return JSON.stringify(report.pages[0] ?? {});
}

describe("reconstructReport never carries Set-Cookie (#973/#1035)", () => {
  test("a multi-cookie header reaches no part of the page", async () => {
    const { store, crawlId } = await freshCrawl([
      pageWithSetCookie(
        "session=abc123; Path=/; HttpOnly\nconsent=1; Path=/; Secure"
      ),
    ]);
    const report = await run(reconstructReport(store, crawlId, undefined));

    const json = pageJson(report);
    expect(json).not.toContain("session=abc123");
    expect(json).not.toContain("consent=1");
    expect(json.toLowerCase()).not.toContain("setcookie");
    expect(report.pages[0]?.url).toBe(SITE);
    await run(store.close());
  });

  test("a single cookie reaches no part of the page", async () => {
    const { store, crawlId } = await freshCrawl([
      pageWithSetCookie("session=abc123; HttpOnly"),
    ]);
    const report = await run(reconstructReport(store, crawlId, undefined));

    expect(pageJson(report)).not.toContain("session=abc123");
    await run(store.close());
  });

  test("response headers are not carried at all, cookie or no cookie", async () => {
    // Since #1938 the guarantee is structural: nothing read `responseHeaders`,
    // so the report stopped carrying them and there is no strip left to forget.
    const { store, crawlId } = await freshCrawl([pageWithSetCookie(null)]);
    const report = await run(reconstructReport(store, crawlId, undefined));

    expect(report.pages[0]?.responseHeaders).toBeUndefined();
    await run(store.close());
  });
});
