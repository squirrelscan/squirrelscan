// The `--rule-cache off|cold|warm` arm of the template fan-out bench (#1971).

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  armCacheStore,
  armEnv,
  countRuleCacheRows,
  parseRuleCacheArm,
  prepareArmCache,
} from "../../scripts/lib/rule-cache-arm";

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function withCopy<T>(
  fn: (db: string, storage: SQLiteStorage, crawlId: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-rule-cache-arm-"));
  dirs.push(dir);
  const db = join(dir, "probe.db");
  const storage = new SQLiteStorage(db);
  await run(storage.init());
  const crawlId = await run(
    storage.createCrawl({
      baseUrl: "http://x.test",
      startedAt: 1,
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
    })
  );
  try {
    return await fn(db, storage, crawlId);
  } finally {
    await run(storage.close());
  }
}

const seed = (storage: SQLiteStorage, crawlId: string) =>
  run(
    storage.savePageRuleCacheBatch(crawlId, [
      { normalizedUrl: "http://x.test/a", cacheKey: "k1", payload: "{}" },
    ])
  );

describe("--rule-cache parsing", () => {
  test("accepts off, cold and warm", () => {
    expect(parseRuleCacheArm("off")).toBe("off");
    expect(parseRuleCacheArm("cold")).toBe("cold");
    expect(parseRuleCacheArm("warm")).toBe("warm");
  });

  test("rejects anything else", () => {
    for (const bad of ["", "on", "COLD", "warm ", "1", "hot"]) {
      expect(parseRuleCacheArm(bad)).toBeNull();
    }
  });
});

describe("the arm uses the real kill switch", () => {
  test("off disables the store, cold and warm enable it", async () => {
    await withCopy(async (_db, storage, crawlId) => {
      expect(armCacheStore("off", storage, crawlId)).toBeUndefined();
      expect(armCacheStore("cold", storage, crawlId)).toBeDefined();
      expect(armCacheStore("warm", storage, crawlId)).toBeDefined();
    });
  });

  test("an ambient SQUIRREL_RULE_CACHE cannot change the arm", () => {
    expect(armEnv("off", {}).SQUIRREL_RULE_CACHE).toBe("off");
    expect(
      armEnv("cold", { SQUIRREL_RULE_CACHE: "off" }).SQUIRREL_RULE_CACHE
    ).toBeUndefined();
    expect(
      armEnv("warm", { SQUIRREL_RULE_CACHE: "0" }).SQUIRREL_RULE_CACHE
    ).toBeUndefined();
  });
});

describe("cache state before a run", () => {
  test("cold empties a populated cache before every run", async () => {
    await withCopy(async (db, storage, crawlId) => {
      for (let i = 0; i < 2; i++) {
        await seed(storage, crawlId);
        expect(countRuleCacheRows(db)).toBe(1);
        let filled = false;
        await prepareArmCache("cold", db, async () => {
          filled = true;
        });
        expect(countRuleCacheRows(db)).toBe(0);
        expect(filled).toBe(false);
      }
    });
  });

  test("warm populates an empty cache once and keeps it", async () => {
    await withCopy(async (db, storage, crawlId) => {
      let fills = 0;
      const fill = async () => {
        fills++;
        await seed(storage, crawlId);
      };
      expect(countRuleCacheRows(db)).toBe(0);
      await prepareArmCache("warm", db, fill);
      await prepareArmCache("warm", db, fill);
      expect(fills).toBe(1);
      expect(countRuleCacheRows(db)).toBe(1);
    });
  });

  test("off leaves the cache untouched and never fills it", async () => {
    await withCopy(async (db, storage, crawlId) => {
      let filled = false;
      await prepareArmCache("off", db, async () => {
        filled = true;
      });
      expect(filled).toBe(false);
      expect(countRuleCacheRows(db)).toBe(0);
      await seed(storage, crawlId);
      await prepareArmCache("off", db, async () => {});
      expect(countRuleCacheRows(db)).toBe(1);
    });
  });
});
