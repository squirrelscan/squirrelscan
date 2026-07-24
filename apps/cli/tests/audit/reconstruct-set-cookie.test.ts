// reconstructReport strips Set-Cookie from each page's responseHeaders before
// the report is ever handed to the publish path (#973/#1035). Cookie values
// are crawl-session artifacts, not report content — the publish schema
// doesn't accept `setCookie`, so this strip is defense-in-depth: the bytes
// never ride the wire in the first place, regardless of whether a given
// publish path also happens to drop pages[] downstream.

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

// `PageAudit.responseHeaders` is typed WITHOUT `setCookie` — read via a loose
// cast so the assertion checks the raw runtime shape (proving the field is
// truly absent, not just hidden from the static type).
function setCookieOf(report: AuditReport): string | null | undefined {
  return (
    report.pages[0]?.responseHeaders as
      | { setCookie?: string | null }
      | undefined
  )?.setCookie;
}

describe("reconstructReport strips Set-Cookie from responseHeaders (#973/#1035)", () => {
  test("multi-cookie set-cookie is stripped, other headers survive", async () => {
    const { store, crawlId } = await freshCrawl([
      pageWithSetCookie(
        "session=abc123; Path=/; HttpOnly\nconsent=1; Path=/; Secure"
      ),
    ]);
    const report = await run(reconstructReport(store, crawlId, undefined));

    expect(setCookieOf(report)).toBeUndefined();
    expect(report.pages[0]?.responseHeaders?.server).toBe("nginx");
    expect(report.pages[0]?.responseHeaders?.contentType).toBe("text/html");
    await run(store.close());
  });

  test("single cookie is stripped too", async () => {
    const { store, crawlId } = await freshCrawl([
      pageWithSetCookie("session=abc123; HttpOnly"),
    ]);
    const report = await run(reconstructReport(store, crawlId, undefined));

    expect(setCookieOf(report)).toBeUndefined();
    await run(store.close());
  });

  test("no set-cookie: responseHeaders pass through unaffected", async () => {
    const { store, crawlId } = await freshCrawl([pageWithSetCookie(null)]);
    const report = await run(reconstructReport(store, crawlId, undefined));

    expect(setCookieOf(report)).toBeUndefined();
    expect(report.pages[0]?.responseHeaders?.server).toBe("nginx");
    await run(store.close());
  });
});
