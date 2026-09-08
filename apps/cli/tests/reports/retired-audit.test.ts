// A reclaimed audit must refuse to render rather than render nothing (#1912).
//
// `self disk --prune` deletes a crawl's rule results and leaves its crawl row
// and some of its pages. Without a retirement stamp the report path finds a
// `completed` crawl, reads zero checks, and assembles a confident report with no
// findings — which reads as "this audit was clean". That is a wrong answer, and
// it is worse than the disk it saved, so every render path has to refuse.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import { pickLatestAnalyzeReadyCrawl } from "@/controllers/analyze";
import {
  isReportRenderable,
  reportUnavailableReason,
} from "@/controllers/report";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";
import { retiredAuditReason } from "@/reports/retired";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const STATS = {
  pagesTotal: 1,
  pagesFetched: 1,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function page(url: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 20,
    loadTimeMs: 1,
    fetchedAt: 1_000,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: "<html><head><title>t</title></head><body>b</body></html>",
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
  } as PageRecord;
}

/** Two audits of the same page; the older one is then reclaimed. */
async function twoAudits(): Promise<{
  store: SQLiteStorage;
  old: string;
  recent: string;
}> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const make = async (startedAt: number): Promise<string> => {
    const id = await run(
      store.createCrawl({
        baseUrl: "https://e.test",
        startedAt,
        status: "completed",
        config: {} as CrawlMetadata["config"],
        stats: STATS,
      } as Omit<CrawlMetadata, "id">)
    );
    await run(store.upsertPage(id, page("https://e.test/a")));
    await run(
      store.saveRuleResults(id, "https://e.test/a", "seo/title", [
        { name: "title-present", status: "fail", message: "no title" },
      ])
    );
    return id;
  };
  const old = await make(1_000);
  const recent = await make(2_000);
  return { store, old, recent };
}

describe("a reclaimed audit refuses to render (#1912)", () => {
  test("reconstructReport fails instead of building an empty report", async () => {
    const { store, old } = await twoAudits();
    await run(store.retireCrawls([old], 1_700_000_000_000));

    // The dangerous outcome is a RESOLVED promise carrying a clean report.
    const result = await Effect.runPromise(
      Effect.either(reconstructReport(store, old, undefined))
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("data was reclaimed on 2023-11-14");
      expect(result.left.message).toContain(old);
    }
    await run(store.close());
  });

  test("the audit that was kept still renders", async () => {
    const { store, old, recent } = await twoAudits();
    await run(store.retireCrawls([old], 1_700_000_000_000));

    const report = await run(reconstructReport(store, recent, undefined));
    expect(report.pages.length).toBeGreaterThan(0);
    await run(store.close());
  });

  test("the gate every CLI path shares refuses it, with the same words", async () => {
    const { store, old, recent } = await twoAudits();
    await run(store.retireCrawls([old], 1_700_000_000_000));

    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    const retired = byId.get(old)!;
    const kept = byId.get(recent)!;

    // `report <id>`, `--diff` and `--regression-since` all resolve through this,
    // so one check covers the three of them.
    expect(isReportRenderable(retired)).toBe(false);
    expect(isReportRenderable(kept)).toBe(true);
    expect(reportUnavailableReason(retired)).toBe(
      retiredAuditReason(1_700_000_000_000)
    );
    await run(store.close());
  });

  test("a not-yet-analyzed audit keeps its own reason", async () => {
    // Retirement must not swallow the pre-existing readiness messages.
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const id = await run(
      store.createCrawl({
        baseUrl: "https://e.test",
        startedAt: 1_000,
        status: "running",
        config: {} as CrawlMetadata["config"],
        stats: STATS,
      } as Omit<CrawlMetadata, "id">)
    );
    const crawl = (await run(store.getCrawl(id)))!;
    expect(isReportRenderable(crawl)).toBe(false);
    expect(reportUnavailableReason(crawl)).toBe("still in progress");
    await run(store.close());
  });

  test("a prune that commits mid-read is still refused", async () => {
    // The metadata check happens once, before the page and rule-result reads.
    // Another process pruning in that window would otherwise let this return a
    // confident empty report built from pre-retirement metadata.
    const { store, old } = await twoAudits();

    let retired = false;
    const realGetPages = store.getPages.bind(store);
    (store as unknown as { getPages: typeof store.getPages }).getPages = ((
      ...args: Parameters<typeof realGetPages>
    ) => {
      if (!retired) {
        retired = true;
        Effect.runSync(
          Effect.orDie(store.retireCrawls([old], 1_700_000_000_000))
        );
      }
      return realGetPages(...args);
    }) as typeof store.getPages;

    const result = await Effect.runPromise(
      Effect.either(reconstructReport(store, old, undefined))
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("data was reclaimed on");
    }
    await run(store.close());
  });

  test("analyze refuses a reclaimed audit rather than re-scoring it", async () => {
    // `analyze` keeps its own status gate, and retirement does not change the
    // status, so without its own test this path re-runs the rules over whatever
    // pages survived and reports "Analysis complete".
    const { store, old, recent } = await twoAudits();
    await run(store.retireCrawls([old], 1_700_000_000_000));

    const crawls = await run(store.listCrawls());
    const retired = crawls.find((c) => c.id === old)!;
    const kept = crawls.find((c) => c.id === recent)!;

    expect(pickLatestAnalyzeReadyCrawl([retired])).toBeNull();
    // And it is not simply skipping everything: the kept audit is still chosen.
    expect(pickLatestAnalyzeReadyCrawl([retired, kept])?.id).toBe(recent);
    await run(store.close());
  });

  test("the date is the day the data was reclaimed", () => {
    expect(retiredAuditReason(Date.UTC(2026, 8, 8))).toBe(
      "data was reclaimed on 2026-09-08"
    );
  });
});
