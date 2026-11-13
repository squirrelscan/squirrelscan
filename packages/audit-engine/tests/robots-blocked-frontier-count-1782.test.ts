// `scanScope.robotsBlockedPages` (#1782): only frontier rows skipped as `robots_disallowed` count.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import { robotsBlockedFrontierCount } from "../src";

const BASE = "https://example.com";
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

describe("robotsBlockedFrontierCount", () => {
  test("counts /private/ URLs skipped by robots.txt, not other skips or other crawls", async () => {
    const storage = new SQLiteStorage(":memory:");
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const make = () =>
          storage.createCrawl({
            baseUrl: BASE,
            originalUrl: BASE,
            startedAt: Date.now(),
            status: "completed",
            config: {} as never,
            stats: STATS,
          });
        const crawlId = yield* make();
        const otherId = yield* make();
        const add = (id: string, path: string, status: "skipped" | "pending", reason?: string) =>
          storage.upsertFrontier(id, {
            normalizedUrl: `${BASE}${path}`,
            rawUrl: `${BASE}${path}`,
            depth: 1,
            priority: 0,
            status,
            source: "discovered",
            enqueuedAt: 1,
            retryCount: 0,
            ...(reason ? { reason } : {}),
          });
        yield* add(crawlId, "/private/a", "skipped", "robots_disallowed");
        yield* add(crawlId, "/private/b", "skipped", "robots_disallowed");
        yield* add(crawlId, "/excluded", "skipped", "excluded");
        yield* add(crawlId, "/queued", "pending");
        yield* add(otherId, "/private/c", "skipped", "robots_disallowed");
        return yield* robotsBlockedFrontierCount(storage, crawlId);
      }),
    );
    expect(count).toBe(2);
  });
});
