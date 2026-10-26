// #844: `squirrel analyze` re-runs the rules over a stored crawl. It used to
// insert its results beside the previous run's, so a crawl analyzed twice held
// two copies of every check and `squirrel report` showed the old items. Now
// each analyze replaces the crawl's results.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CheckResult } from "@/types";

import { saveAnalyzeRuleResults } from "@/controllers/analyze";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const PAGE = "https://example.com/";

function results(message: string) {
  const check = (name: string): CheckResult => ({
    name,
    status: "warn",
    message,
  });
  return {
    pageRuleResults: new Map([
      [PAGE, new Map([["core/meta-title", [check("core/meta-title")]]])],
    ]),
    siteRuleResults: new Map([["links/broken-links", [check("broken-links")]]]),
  };
}

async function storedCrawl(): Promise<{
  storage: SQLiteStorage;
  crawlId: string;
}> {
  const storage = new SQLiteStorage(":memory:");
  const crawlId = await Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      return yield* storage.createCrawl({
        baseUrl: "https://example.com",
        seedUrl: PAGE,
        originalUrl: PAGE,
        startedAt: Date.now(),
        status: "analyzed",
        config: {} as never,
        stats: {} as never,
      } as never);
    })
  );
  return { storage, crawlId };
}

describe("analyze replaces the crawl's rule results (#844)", () => {
  test("a second analyze leaves one set, the second run's", async () => {
    const { storage, crawlId } = await storedCrawl();
    try {
      await saveAnalyzeRuleResults(storage, crawlId, results("first run"));
      await saveAnalyzeRuleResults(storage, crawlId, results("second run"));

      // What `squirrel report` reads.
      const stored = await Effect.runPromise(storage.getRuleResults(crawlId));
      expect(stored).toHaveLength(2);
      expect(stored.map((c) => c.message)).toEqual([
        "second run",
        "second run",
      ]);
      expect(stored.map((c) => c.name).sort()).toEqual([
        "broken-links",
        "core/meta-title",
      ]);
    } finally {
      await Effect.runPromise(storage.close());
    }
  });

  test("the plain batch insert analyze used before appends a second copy", async () => {
    const { storage, crawlId } = await storedCrawl();
    try {
      const batch = new Map([
        [
          PAGE,
          [
            {
              ruleId: "core/meta-title",
              checks: [
                {
                  name: "core/meta-title",
                  status: "warn" as const,
                  message: "x",
                },
              ],
            },
          ],
        ],
      ]);
      await Effect.runPromise(storage.saveRuleResultsBatch(crawlId, batch));
      await Effect.runPromise(storage.saveRuleResultsBatch(crawlId, batch));
      expect(
        await Effect.runPromise(storage.getRuleResults(crawlId))
      ).toHaveLength(2);
      await Effect.runPromise(
        storage.saveRuleResultsBatch(crawlId, batch, { replace: true })
      );
      expect(
        await Effect.runPromise(storage.getRuleResults(crawlId))
      ).toHaveLength(1);
    } finally {
      await Effect.runPromise(storage.close());
    }
  });

  test("a replace that fails part way keeps the previous results", async () => {
    const { storage, crawlId } = await storedCrawl();
    try {
      await saveAnalyzeRuleResults(storage, crawlId, results("first run"));
      // A BigInt cannot be serialized, so the second check's insert throws after
      // the delete and the first insert already ran inside the transaction.
      const broken = results("second run");
      broken.siteRuleResults.set("links/broken-links", [
        {
          name: "broken-links",
          status: "warn",
          message: "second run",
          items: [{ id: 1n }] as never,
        },
      ]);
      await expect(
        saveAnalyzeRuleResults(storage, crawlId, broken)
      ).rejects.toBeDefined();
      const stored = await Effect.runPromise(storage.getRuleResults(crawlId));
      expect(stored.map((c) => c.message)).toEqual(["first run", "first run"]);
    } finally {
      await Effect.runPromise(storage.close());
    }
  });

  test("a run that produced fewer checks does not leave the earlier ones behind", async () => {
    const { storage, crawlId } = await storedCrawl();
    try {
      await saveAnalyzeRuleResults(storage, crawlId, results("first run"));
      await saveAnalyzeRuleResults(storage, crawlId, {
        pageRuleResults: new Map(),
        siteRuleResults: new Map(),
      });
      expect(await Effect.runPromise(storage.getRuleResults(crawlId))).toEqual(
        []
      );
    } finally {
      await Effect.runPromise(storage.close());
    }
  });
});
