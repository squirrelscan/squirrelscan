// repo#1082: a report rebuilt from the store (`squirrel report`, `squirrel report --publish`)
// restores the partial-audit marker saved with the crawl's scan scope, so the payload a
// marked report publishes carries it. A crawl saved without one gains none.

import type { CrawlMetadata, PartialAudit } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { slimForPublish } from "@/controllers/report/publish";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(effect));
}

const MARKER: PartialAudit = {
  include: ["core/*"],
  exclude: [],
  includedCategories: ["core"],
};

async function storedAudit(partialAudit?: PartialAudit) {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      config: { maxPages: 5 } as CrawlMetadata["config"],
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
    })
  );
  await run(
    store.updateCrawl(crawlId, {
      scanScope: {
        origin: "cli",
        pagesCrawled: 0,
        capped: false,
        ...(partialAudit ? { partialAudit } : {}),
      },
    })
  );
  return { store, crawlId };
}

describe("rebuilt report keeps the partial-audit marker (repo#1082)", () => {
  test("a marked crawl rebuilds with partialAudit and publishes it", async () => {
    const { store, crawlId } = await storedAudit(MARKER);
    const report = await run(reconstructReport(store, crawlId));
    expect(report.partialAudit).toEqual(MARKER);
    const payload = slimForPublish(report) as unknown as {
      partialAudit?: PartialAudit;
    };
    expect(payload.partialAudit).toEqual(MARKER);
  }, 30_000);

  test("an unmarked crawl rebuilds and publishes with no marker", async () => {
    const { store, crawlId } = await storedAudit();
    const report = await run(reconstructReport(store, crawlId));
    expect(report.partialAudit).toBeUndefined();
    expect(
      "partialAudit" in (slimForPublish(report) as unknown as object)
    ).toBe(false);
  }, 30_000);
});
