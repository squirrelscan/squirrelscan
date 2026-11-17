// repo#3094: `squirrel report` rebuilds the audit from the store. The live audit stamps `render` after
// the crawl, so the rebuilt report has to read it back from the stored pages, or a rendered audit
// reads as one that rendered nothing.

import type {
  CrawlMetadata,
  PageRecord,
} from "@squirrelscan/core-contracts/storage";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { buildReportRender, createRenderTally } from "@/audit/render-summary";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(effect));
}

const STATS = {
  pagesTotal: 2,
  pagesFetched: 2,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function page(n: number, fetcherId?: string): PageRecord {
  const url = `${SITE}/page-${n}`;
  const html = `<html lang="en"><head><title>Page ${n}</title></head><body>Page ${n}</body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `page-${n}`,
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
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
    ...(fetcherId ? { fetcherId } : {}),
  };
}

async function store(
  rows: PageRecord[],
  scanScope?: CrawlMetadata["scanScope"]
) {
  const db = new SQLiteStorage(":memory:");
  await run(db.init());
  const crawlId = await run(
    db.createCrawl({
      baseUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      config: { maxPages: 5 } as CrawlMetadata["config"],
      stats: STATS,
    })
  );
  if (scanScope) await run(db.updateCrawl(crawlId, { scanScope }));
  for (const row of rows) await run(db.upsertPage(crawlId, row));
  return { db, crawlId };
}

describe("render block of a report rebuilt from the store (repo#3094)", () => {
  // An audit written before the block was saved has no scanScope.render: the block is guessed from
  // the stored pages, so its mode and counts are approximate and it never has a fallback reason.
  test("an old store with no saved block gets the approximate block", async () => {
    const { db, crawlId } = await store(
      [page(1, "cloud-render"), page(2, "fetch")],
      { origin: "cli", pagesCrawled: 2, capped: false }
    );
    const report = await run(reconstructReport(db, crawlId));
    expect(report.render).toEqual({
      requested: true,
      mode: "auto",
      pagesRendered: 1,
      pagesFetchedPlain: 1,
    });
    await run(db.close());
  });

  test("an audit that rendered nothing has no render block", async () => {
    const { db, crawlId } = await store([page(1, "fetch"), page(2)]);
    const report = await run(reconstructReport(db, crawlId));
    expect(report.render).toBeUndefined();
    await run(db.close());
  });
});

// Parity: the block the audit wrote is the block `squirrel report` rebuilds. The live block is built
// as the controller builds it (a tally of each page's fetcher, then buildReportRender) and saved in
// the scan scope the way the controller saves it; expected values below are literals.
describe("rebuilt render block equals the one the audit wrote (repo#3094)", () => {
  interface Case {
    name: string;
    fetchers: (string | undefined)[];
    requested: boolean;
    fetcherId: string | undefined;
    fallbackReason?: string;
    expected: unknown;
  }
  const cases: Case[] = [
    {
      name: "A: all, fell back after 1 of 3",
      fetchers: ["cloud-render", "fetch", "fetch"],
      requested: true,
      fetcherId: "cloud-render",
      fallbackReason: "balance ran out",
      expected: {
        requested: true,
        mode: "all",
        fallbackReason: "balance ran out",
        pagesRendered: 1,
        pagesFetchedPlain: 2,
      },
    },
    {
      name: "B: all rendered",
      fetchers: ["cloud-render", "cloud-render", "cloud-render"],
      requested: true,
      fetcherId: "cloud-render",
      expected: {
        requested: true,
        mode: "all",
        pagesRendered: 3,
        pagesFetchedPlain: 0,
      },
    },
    {
      name: "C: auto, every page a shell",
      fetchers: ["cloud-render", "cloud-render", "cloud-render"],
      requested: true,
      fetcherId: "hybrid-http-first",
      expected: {
        requested: true,
        mode: "auto",
        pagesRendered: 3,
        pagesFetchedPlain: 0,
      },
    },
    {
      name: "D: auto, mixed",
      fetchers: ["cloud-render", "fetch", "fetch"],
      requested: true,
      fetcherId: "hybrid-http-first",
      expected: {
        requested: true,
        mode: "auto",
        pagesRendered: 1,
        pagesFetchedPlain: 2,
      },
    },
    {
      name: "E: plain HTTP",
      fetchers: ["fetch", "fetch", undefined],
      requested: false,
      fetcherId: undefined,
      expected: {
        requested: false,
        mode: "http",
        pagesRendered: 0,
        pagesFetchedPlain: 3,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const tally = createRenderTally();
      for (const f of c.fetchers) tally.note(f);
      const { rendered, plain } = tally.counts();
      const live = buildReportRender({
        requested: c.requested,
        fetcherId: c.fetcherId,
        fallbackReason: c.fallbackReason,
        rendered,
        plain,
      });
      expect(live).toEqual(c.expected as typeof live);

      const rows = c.fetchers.map((f, i) => page(i + 1, f));
      const { db, crawlId } = await store(rows, {
        origin: "cli",
        pagesCrawled: rows.length,
        capped: false,
        render: live,
      });
      const report = await run(reconstructReport(db, crawlId));
      expect(report.render).toEqual(live);
      expect(report.render).toEqual(c.expected as typeof live);
      // the saved block is stored crawl data, not a new key under the report's scanScope
      expect(report.scanScope?.render).toBeUndefined();
      await run(db.close());
    });
  }
});
