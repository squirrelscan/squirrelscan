// One rule for a `--max-duration` cut, used by the live audit and the rebuilt report (#1662).

import type { AuditStatus, MaxDurationCut } from "@squirrelscan/core-contracts";

import { maxDurationReason } from "@squirrelscan/core-contracts/failure-reason";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport, withMaxDurationCut } from "@/reports/reconstruct";

const CUT: MaxDurationCut = {
  seconds: 30,
  unfetchedPages: 12,
  pagesNotEvaluated: 0,
  siteChecksCut: false,
};
const REASON = maxDurationReason(CUT);
const PARTIAL = {
  status: "partial",
  reason: REASON,
  reasonCode: "max_duration",
};

describe("withMaxDurationCut", () => {
  const table: Array<
    [string, AuditStatus | undefined, MaxDurationCut | undefined, string]
  > = [
    ["a completed run that was cut is partial", "completed", CUT, "cut"],
    ["a run with no status yet that was cut is partial", undefined, CUT, "cut"],
    [
      "a completed run that was not cut stays completed",
      "completed",
      undefined,
      "same",
    ],
    ["no status and no cut reads completed", undefined, undefined, "same"],
    ["a failed run keeps failed", "failed", CUT, "same"],
    ["a blocked run keeps blocked", "blocked", CUT, "same"],
    [
      "a run that is already partial keeps its own reason",
      "partial",
      CUT,
      "same",
    ],
  ];
  for (const [name, status, cut, expected] of table) {
    test(name, () => {
      const run = {
        status,
        reason: "carried reason",
        reasonCode: "timeout" as const,
      };
      const out = withMaxDurationCut(run, cut);
      if (expected === "cut") expect(out).toEqual(PARTIAL as typeof out);
      else
        expect(out).toEqual({
          status: status ?? "completed",
          reason: "carried reason",
          reasonCode: "timeout",
        });
    });
  }
});

describe("the same cut reads the same live and rebuilt from the store", () => {
  const SITE = "https://example.com";
  const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
    Effect.runPromise(Effect.orDie(effect));

  test("status, reason and code of the live override equal those of the rebuilt report", async () => {
    // Live: the audit builds its report, then applies the cut it measured.
    const live = withMaxDurationCut(
      { status: undefined as AuditStatus | undefined },
      CUT
    );

    // Rebuilt: the same cut, persisted in the crawl's scope, read back by `squirrel report`.
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await run(
      store.createCrawl({
        baseUrl: SITE,
        originalUrl: SITE,
        startedAt: 1,
        status: "analyzed",
        config: { maxPages: 5 },
        stats: {
          pagesTotal: 1,
          pagesFetched: 1,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
        scanScope: { maxDuration: CUT },
      } as never)
    );
    const html = "<html><head><title>One</title></head><body>One</body></html>";
    await run(
      store.upsertPage(crawlId, {
        url: `${SITE}/`,
        normalizedUrl: `${SITE}/`,
        finalUrl: `${SITE}/`,
        depth: 0,
        status: 200,
        contentType: "text/html",
        sizeBytes: html.length,
        loadTimeMs: 1,
        fetchedAt: 1,
        etag: null,
        lastModified: null,
        contentHash: "h",
        html,
        parsedData: null,
        headers: {},
        securityHeaders: {},
      } as never)
    );
    const rebuilt = await run(reconstructReport(store, crawlId));

    expect({
      status: rebuilt.status,
      reason: rebuilt.statusReason,
      reasonCode: rebuilt.statusReasonCode,
    }).toEqual({
      status: live.status,
      reason: live.reason,
      reasonCode: live.reasonCode,
    });
    expect(live).toEqual(PARTIAL as typeof live);
  });
});
