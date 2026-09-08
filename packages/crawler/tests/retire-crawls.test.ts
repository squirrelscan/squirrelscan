// #1912: retiring an old crawl's derived output must reclaim the space without
// taking anything the NEXT crawl reads.
//
// The dangerous direction is not "deletes too little". It is deleting the
// conditional-GET cache or the sub-resource records, which would turn every
// re-audit into a cold crawl and cost users far more than the disk they saved.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CheckResult, CrawlMetadata, PageRecord } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function pageRecord(url: string, fetchedAt: number, etag: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    fetchedAt,
    etag,
    lastModified: null,
    contentHash: etag,
    html: "<html></html>",
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag,
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
  } as PageRecord;
}

const check: CheckResult = { name: "c", status: "pass", message: "m" };

interface TwoCrawls {
  store: SQLiteStorage;
  old: string;
  recent: string;
}

/** Two crawls of the same two-page site, the second newer. */
async function twoCrawls(): Promise<TwoCrawls> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const meta = (startedAt: number): Omit<CrawlMetadata, "id"> => ({
    baseUrl: "https://e.test",
    startedAt,
    status: "completed",
    config: {} as CrawlMetadata["config"],
    stats: STATS,
  });
  const old = await run(store.createCrawl(meta(1_000)));
  const recent = await run(store.createCrawl(meta(2_000)));

  for (const [crawlId, at, tag] of [
    [old, 1_000, "v1"],
    [recent, 2_000, "v2"],
  ] as const) {
    for (const path of ["/a", "/b"]) {
      await run(store.upsertPage(crawlId, pageRecord(`https://e.test${path}`, at, tag)));
      await run(store.saveRuleResults(crawlId, `https://e.test${path}`, "seo/title", [check]));
    }
  }
  // A page only the OLD crawl ever saw.
  await run(store.upsertPage(old, pageRecord("https://e.test/gone", 1_000, "v1")));
  return { store, old, recent };
}

describe("retireCrawls", () => {
  test("removes the old crawl's checks and leaves the current crawl's alone", async () => {
    const { store, old, recent } = await twoCrawls();

    const preview = await run(store.previewRetireCrawls([old]));
    expect(preview.rowsByTable.rule_results).toBe(2);
    expect(preview.totalRows).toBeGreaterThan(0);

    const deleted = await run(store.retireCrawls([old]));
    expect(deleted).toBe(preview.totalRows);

    expect((await run(store.getRuleResultsByPage(old))).size).toBe(0);
    expect((await run(store.getRuleResultsByPage(recent))).size).toBe(2);
  });

  test("keeps the conditional-GET cache the next crawl reads", async () => {
    const { store, old, recent } = await twoCrawls();
    await run(store.retireCrawls([old]));

    // The newest row per url survives, so an incremental re-crawl still gets
    // its etag. This is the failure that would cost more than it saves.
    for (const path of ["/a", "/b"]) {
      const cached = await run(store.getCachedPage(`https://e.test${path}`));
      expect(cached?.etag).toBe("v2");
    }
    // A url only the retired crawl ever saw keeps its ONLY row: it is still the
    // freshest thing known about that page.
    const orphan = await run(store.getCachedPage("https://e.test/gone"));
    expect(orphan?.etag).toBe("v1");
  });

  test("drops only the superseded page rows", async () => {
    const { store, old, recent } = await twoCrawls();
    const preview = await run(store.previewRetireCrawls([old]));
    // /a and /b are superseded by the new crawl; /gone is not.
    expect(preview.supersededPages).toBe(2);

    await run(store.retireCrawls([old]));
    const remaining = await run(store.getPages(old));
    expect(remaining.map((p) => p.normalizedUrl)).toEqual([
      "https://e.test/gone",
    ]);
  });

  test("keeps the crawl row, so the audit is still listed", async () => {
    const { store, old, recent } = await twoCrawls();
    await run(store.retireCrawls([old]));
    const crawls = await run(store.listCrawls());
    expect(crawls.map((c) => c.id).sort()).toEqual([old, recent].sort());
  });

  test("retiring nothing is a no-op, not an error", async () => {
    const { store, old, recent } = await twoCrawls();
    expect(await run(store.previewRetireCrawls([]))).toEqual({
      rowsByTable: {},
      supersededPages: 0,
      totalRows: 0,
    });
    expect(await run(store.retireCrawls([]))).toBe(0);
    expect((await run(store.getRuleResultsByPage(old))).size).toBe(2);
  });

  test("the preview is exactly what the delete removes", async () => {
    const { store, old, recent } = await twoCrawls();
    const preview = await run(store.previewRetireCrawls([old, recent]));
    const deleted = await run(store.retireCrawls([old, recent]));
    // A user confirms on the preview, so it has to be the real number.
    expect(deleted).toBe(preview.totalRows);
  });

  test("refuses a crawl that is still running", async () => {
    const { store, old } = await twoCrawls();
    await run(store.updateCrawl(old, { status: "running" }));

    // A prune racing a live audit would delete its frontier mid-run.
    await expect(run(store.retireCrawls([old]))).rejects.toThrow();
    expect((await run(store.getRuleResultsByPage(old))).size).toBe(2);
  });

  test("keeps links and images, which the next crawl reads across crawls", async () => {
    const { store, old, recent } = await twoCrawls();
    await run(
      store.upsertLink(old, {
        href: "https://out.test/x",
        isInternal: false,
        status: 200,
        error: null,
        redirectTarget: null,
        checkedAt: 1_000,
      } as never)
    );
    // getLinksByPage joins links to link_appearances, so the page mapping has
    // to exist for the read that reuseCachedPage makes.
    await run(
      store.addLinkAppearance(old, {
        href: "https://out.test/x",
        pageUrl: "https://e.test/a",
        anchorText: "x",
        position: "body",
        rel: null,
        isNofollow: false,
      } as never)
    );
    await run(store.retireCrawls([old]));

    // getLinksByPage has no crawl_id filter and reuseCachedPage copies its
    // result into the next crawl, so retiring these would leave a reused page
    // with no links in the NEXT audit's report.
    const links = await run(store.getLinksByPage("https://e.test/a"));
    expect(links.length).toBeGreaterThan(0);
    void recent;
  });

  test("stamps retired_at on the crawls it retires, and only those", async () => {
    const { store, old, recent } = await twoCrawls();
    const at = 1_700_000_000_000;
    await run(store.retireCrawls([old], at));

    const byId = new Map(
      (await run(store.listCrawls())).map((c) => [c.id, c])
    );
    // The stamp is what lets `report` say "reclaimed on <date>" instead of
    // rebuilding an empty report from the pages that survive.
    expect(byId.get(old)?.retiredAt).toBe(at);
    expect(byId.get(recent)?.retiredAt).toBeUndefined();
  });

  test("the stamp and the deletes roll back together", async () => {
    // A crawl whose rows are gone but which still reads as renderable is the one
    // state worse than either end, so the two must not be separable. Asserting
    // the successful end state cannot show that — it holds either way. Failing
    // the transaction can: if the stamp were its own statement outside it, the
    // rollback would leave one of the two applied.
    const { store, old } = await twoCrawls();
    const db = (
      store as unknown as { getDb(): { transaction(fn: () => void): () => void } }
    ).getDb();

    expect(() =>
      db.transaction(() => {
        Effect.runSync(Effect.orDie(store.retireCrawls([old])));
        throw new Error("abort");
      })()
    ).toThrow("abort");

    const crawl = (await run(store.listCrawls())).find((c) => c.id === old);
    expect(crawl?.retiredAt).toBeUndefined();
    expect((await run(store.getRuleResultsByPage(old))).size).toBe(2);
  });

  test("on success both the stamp and the deletes are applied", async () => {
    const { store, old } = await twoCrawls();
    await run(store.retireCrawls([old]));

    const crawl = (await run(store.listCrawls())).find((c) => c.id === old);
    expect(crawl?.retiredAt).toBeGreaterThan(0);
    expect((await run(store.getRuleResultsByPage(old))).size).toBe(0);
  });

  test("an untouched crawl has no stamp", async () => {
    const { store, old, recent } = await twoCrawls();
    for (const c of await run(store.listCrawls())) {
      expect(c.retiredAt).toBeUndefined();
    }
    void old;
    void recent;
  });

  test("vacuum runs and leaves the data intact", async () => {
    const { store, old, recent } = await twoCrawls();
    await run(store.retireCrawls([old]));
    await run(store.vacuum());
    expect((await run(store.getRuleResultsByPage(recent))).size).toBe(2);
    expect((await run(store.getCachedPage("https://e.test/a")))?.etag).toBe("v2");
  });
});
