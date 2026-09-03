// #1829 end-to-end: a rate-limited page must be excluded from page-level rule
// scoring the way a WAF challenge page already is.
//
// The unit tests in packages/rules cover the LINK rules, which read a status off
// a stored row. This covers the other half — the page rules that grade whatever
// the adapter puts in `parsedPages`. If a 429 page reaches that list, `soft-404`
// calls it a soft 404, `indexability` calls it unindexable and `http-to-https`
// grades a body nobody has actually seen. Only the adapter can prevent that, and
// only an end-to-end run through the real adapter proves it did.
//
// Driven through `runRulesOnStorage` and asserted on `ruleResultsMap`, not on a
// finished report: the report is assembled by a SECOND code path, so a report
// assertion can pass with the adapter fix deleted.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, type PreFetchedAssets } from "../src/adapter";

const BASE = "https://shop.example.com";

// Page rules that read a status code and would otherwise indict a throttled page.
const PAGE_RULES = ["crawl/soft-404", "crawl/indexability", "security/http-to-https"];
const LINK_RULE = "links/broken-links";

// `filterRules` defaults every rule to disabled, so the enable list is
// mandatory — `rules: {}` runs nothing and passes vacuously.
const CONFIG = {
  rule_options: {},
  rules: { enable: [...PAGE_RULES, LINK_RULE] },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function html(body: string): string {
  return `<!doctype html><html><head><title>Shop</title><meta name="description" content="a shop page with enough words to look like real content for the rules to grade"></head><body>${body}</body></html>`;
}

interface SeedPage {
  path: string;
  status: number;
  body?: string;
}

function pageRecord(crawlId: string, page: SeedPage): PageRecord {
  const url = `${BASE}${page.path}`;
  const body = page.body ?? html(`<h1>Page ${page.path}</h1><p>Some body copy.</p>`);
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: page.status,
    contentType: "text/html",
    sizeBytes: body.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${page.path}`,
    html: body,
    parsedData: null,
    headers: {
      contentType: "text/html",
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
      setCookie: null,
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
  } as unknown as PageRecord;
}

interface AuditResult {
  /** Pages the page-scope rules were actually run over. */
  gradedUrls: string[];
  /** Failing/warning page checks for one URL. */
  findingsFor: (url: string) => { name: string; status: string }[];
  checksFor: (ruleId: string) => { name: string; status: string; items?: unknown[] }[];
}

/** Store the given pages, then run the real rules over them via the real adapter. */
async function auditPages(pages: SeedPage[]): Promise<AuditResult> {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {
          pagesTotal: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      } as never);

      for (const page of pages) {
        yield* storage.upsertPage(crawlId, pageRecord(crawlId, page));
      }

      const stored = yield* storage.getPages(crawlId);
      const siteContext = yield* buildSiteContext(stored);
      const result = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);

      // `pageResults` is keyed by page URL, so its keys ARE the set of pages the
      // page rules were run over — the most direct statement of what was scored.
      const gradedUrls = [...result.pageResults.keys()];
      const findingsFor = (url: string) =>
        (result.pageResults.get(url) ?? []).filter(
          (c) => c.status === "fail" || c.status === "warn",
        );

      return {
        gradedUrls,
        findingsFor,
        checksFor: (ruleId: string) =>
          (result.ruleResultsMap.get(ruleId)?.checks ?? []) as {
            name: string;
            status: string;
            items?: unknown[];
          }[],
      } satisfies AuditResult;
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

// A body the page rules DO have something to say about (thin, no description,
// soft-404 wording), so "no finding" is a real exclusion rather than a page that
// happened to be clean.
const INDICTABLE_BODY =
  '<!doctype html><html><head><title>Page not found</title><meta name="robots" content="noindex"></head><body><h1>Page not found</h1><p>Sorry, this page does not exist.</p></body></html>';

describe("#1829 — rate-limited pages are excluded from page-level scoring", () => {
  test("the control: at status 200 that page is graded and indicted", async () => {
    // Establishes that the assertions below mean something. Without this an
    // exclusion bug and a rule that never fires look identical.
    const { gradedUrls, findingsFor } = await auditPages([
      { path: "/", status: 200 },
      { path: "/suspect", status: 200, body: INDICTABLE_BODY },
    ]);

    expect(gradedUrls).toContain(`${BASE}/suspect`);
    expect(findingsFor(`${BASE}/suspect`).length).toBeGreaterThan(0);
  });

  test("the same page at 429 is not graded at all", async () => {
    const { gradedUrls, findingsFor } = await auditPages([
      { path: "/", status: 200 },
      { path: "/suspect", status: 429, body: INDICTABLE_BODY },
    ]);

    // Still a real run — the healthy seed was graded.
    expect(gradedUrls).toContain(`${BASE}/`);
    expect(gradedUrls).not.toContain(`${BASE}/suspect`);
    expect(findingsFor(`${BASE}/suspect`)).toEqual([]);
  });

  test("a 430 page is excluded the same way", async () => {
    const { gradedUrls, findingsFor } = await auditPages([
      { path: "/", status: 200 },
      { path: "/suspect", status: 430, body: INDICTABLE_BODY },
    ]);

    expect(gradedUrls).toContain(`${BASE}/`);
    expect(gradedUrls).not.toContain(`${BASE}/suspect`);
    expect(findingsFor(`${BASE}/suspect`)).toEqual([]);
  });

  test("a 404 page is still in the corpus — only throttling is excused", async () => {
    // The exclusion must be narrow. A real 404 has to keep reaching the rules,
    // or this fix would hide genuine breakage along with the false positives.
    const { checksFor } = await auditPages([
      {
        path: "/",
        status: 200,
        body: html(`<a href="${BASE}/gone">gone</a><a href="${BASE}/throttled">slow</a>`),
      },
      { path: "/gone", status: 404, body: "Not Found" },
      { path: "/throttled", status: 429, body: "Too Many Requests" },
    ]);

    const brokenLinks = checksFor(LINK_RULE).find((c) => c.name === "broken-links");
    expect(brokenLinks?.status).toBe("fail");
    expect(brokenLinks?.items?.length).toBe(1);
  });

  test("the exclusion is surfaced as an info check rather than silently swallowed", async () => {
    const { checksFor } = await auditPages([
      { path: "/", status: 200 },
      { path: "/throttled", status: 429, body: "Too Many Requests" },
    ]);

    const notice = checksFor("crawl/rate-limited-pages").find(
      (c) => c.name === "Rate-limited pages",
    );
    expect(notice?.status).toBe("info");
  });
});
