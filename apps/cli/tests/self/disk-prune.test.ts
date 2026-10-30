// #1912: `self disk --prune` is the only thing in the CLI that deletes a user's
// audit history, so the parts that matter are the guards, not the deletion.
//
// The plan a user confirms on must be the real number, a dry run must leave the
// file untouched, and the reclaim must not take the conditional-GET cache the
// next crawl reads — losing that would cost far more than the disk it saved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  formatAge,
  lowDiskReason,
  planProjects,
  planProjectPrune,
  pruneExitCode,
  runPrunePlans,
  runProjectPrune,
} from "../../src/self/disk";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

let dir: string;
let dbPath: string;

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

function page(
  url: string,
  fetchedAt: number,
  etag: string,
  html = "<html></html>"
): PageRecord {
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
    html,
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

/** `audits` crawls of the same 3-page site, oldest first. */
async function project(audits: number): Promise<void> {
  const store = new SQLiteStorage(dbPath);
  await run(store.init());
  for (let i = 0; i < audits; i++) {
    const id = await run(
      store.createCrawl({
        baseUrl: "https://e.test",
        startedAt: 1_000 + i,
        status: "completed",
        config: {} as CrawlMetadata["config"],
        stats: STATS,
      } as Omit<CrawlMetadata, "id">)
    );
    for (const path of ["/a", "/b", "/c"]) {
      const url = `https://e.test${path}`;
      await run(store.upsertPage(id, page(url, 1_000 + i, `v${i}`)));
      await run(
        store.saveRuleResults(id, url, "seo/title", [
          { name: "title-present", status: "pass", message: "m" },
        ])
      );
    }
  }
  store.close?.();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-prune-"));
  mkdirSync(join(dir, "proj"), { recursive: true });
  dbPath = join(dir, "proj", "project.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("planProjectPrune", () => {
  test("nothing to plan when the project holds no more than the window", async () => {
    await project(2);
    expect(await planProjectPrune(dbPath, 2)).toBeNull();
    expect(await planProjectPrune(dbPath, 5)).toBeNull();
  });

  test("plans the audits outside the window, oldest first", async () => {
    await project(4);
    const plan = await planProjectPrune(dbPath, 2);
    expect(plan).not.toBeNull();
    expect(plan!.retiring).toHaveLength(2);
    expect(plan!.keeping).toBe(2);
    // Oldest first, so the listing reads chronologically.
    expect(plan!.retiring[0]!.startedAt).toBeLessThan(
      plan!.retiring[1]!.startedAt
    );
    expect(plan!.rows).toBeGreaterThan(0);
  });

  test("a crawl still building its report is planned around, not retired and not counted (#288)", async () => {
    await project(4);
    // The oldest audit is mid-build: stamped `building` an hour ago.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const oldest = (await run(store.listCrawls())).sort(
      (a, b) => a.startedAt - b.startedAt
    )[0]!;
    await run(store.setReportStatus(oldest.id, "building"));
    store.close?.();

    const plan = await planProjectPrune(dbPath, 2);
    expect(plan).not.toBeNull();
    expect(plan!.retiring.map((c) => c.id)).not.toContain(oldest.id);
    expect(plan!.skippedLive.map((c) => c.id)).toContain(oldest.id);
    expect(plan!.skippedLive.find((c) => c.id === oldest.id)?.status).toBe(
      "building"
    );
  });

  test("an already-retired project can still be rebuilt, and says so", async () => {
    // The state automatic retention leaves behind: the rows for the audits
    // outside the window are gone, and the file is still the size they made it.
    // Sized so the freed space clears the 1 MB floor without depending on it —
    // 40 pages of 32 KB per audit is over a megabyte an audit.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const html = "x".repeat(32 * 1024);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await run(
        store.createCrawl({
          baseUrl: "https://e.test",
          startedAt: 1_000 + i,
          status: "completed",
          config: {} as CrawlMetadata["config"],
          stats: STATS,
        } as Omit<CrawlMetadata, "id">)
      );
      ids.push(id);
      for (let p = 0; p < 40; p++) {
        const url = `https://e.test/p${p}`;
        await run(store.upsertPage(id, page(url, 1_000 + i, `v${i}`, html)));
      }
    }
    // Retire the oldest, as an audit's retention pass would: rows gone, file
    // not rebuilt.
    await run(store.retireCrawls([ids[0]!]));
    const stats = await run(store.databasePageStats());
    store.close?.();
    expect(stats.freelistPages * stats.pageSize).toBeGreaterThan(1024 * 1024);

    // Nothing beyond a window of 3 and nothing left to retire, but the space is
    // real and only a rebuild returns it, so the plan has to offer that.
    const plan = await planProjectPrune(dbPath, 3);
    expect(plan).not.toBeNull();
    expect(plan!.rows).toBe(0);
    expect(plan!.retiring).toHaveLength(0);
    expect(plan!.reclaimableBytes).toBeGreaterThan(1024 * 1024);

    // And running it actually returns the space.
    const result = await runProjectPrune(plan!);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  });

  test("audits an earlier pass already retired are not planned again", async () => {
    await project(4);
    await runProjectPrune((await planProjectPrune(dbPath, 2))!);
    // The same window a second time: the two beyond it are already retired.
    const again = await planProjectPrune(dbPath, 2);
    expect(again?.retiring ?? []).toHaveLength(0);
    expect(again?.rows ?? 0).toBe(0);
  });

  test("the kept count is audits you can still open, not rows in the table", async () => {
    await project(5);
    // Retire the three oldest, as an audit's retention or an earlier prune
    // would. Five audits are still LISTED; two can be opened.
    await runProjectPrune((await planProjectPrune(dbPath, 2))!);

    const plan = await planProjectPrune(dbPath, 1);
    expect(plan).not.toBeNull();
    expect(plan!.retiring).toHaveLength(1);
    // One left renderable afterwards, not four: counting the crawl rows would
    // describe a history the user does not have.
    expect(plan!.keeping).toBe(1);
  });

  test("an audit with nothing deletable left in it is still a retirement", async () => {
    // A crawl outside the window whose derived rows are already gone is still
    // stamped retired and still stops opening, so the plan has to carry it
    // rather than report a rows-only no-op.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      ids.push(
        await run(
          store.createCrawl({
            baseUrl: "https://e.test",
            startedAt: 1_000 + i,
            status: "completed",
            config: {} as CrawlMetadata["config"],
            stats: STATS,
          } as Omit<CrawlMetadata, "id">)
        )
      );
    }
    store.close?.();

    const plan = await planProjectPrune(dbPath, 1);
    expect(plan).not.toBeNull();
    expect(plan!.rows).toBe(0);
    expect(plan!.retiring).toHaveLength(1);

    await runProjectPrune(plan!);
    const after = new SQLiteStorage(dbPath);
    await run(after.init());
    const byId = new Map((await run(after.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(ids[0]!)?.retiredAt).toBeDefined();
    expect(byId.get(ids[1]!)?.retiredAt).toBeUndefined();
    after.close?.();
  });

  test("a missing database is not an error", async () => {
    expect(
      await planProjectPrune(join(dir, "nope", "project.db"), 1)
    ).toBeNull();
  });

  test("planning deletes nothing", async () => {
    await project(3);
    const before = statSync(dbPath).size;
    await planProjectPrune(dbPath, 1);
    expect(statSync(dbPath).size).toBe(before);

    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    expect((await run(store.listCrawls())).length).toBe(3);
    store.close?.();
  });
});

describe("runProjectPrune", () => {
  test("retires the planned audits and returns the space", async () => {
    await project(4);
    const plan = (await planProjectPrune(dbPath, 1))!;
    const result = await runProjectPrune(plan);

    // The count a user confirmed on is the count that was deleted.
    expect(result.rows).toBe(plan.rows);
    // VACUUM plus a WAL checkpoint, so the saving is on the filesystem rather
    // than moved into the -wal beside it.
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  });

  test("keeps the newest page per url, so the next crawl still has its cache", async () => {
    await project(4);
    await runProjectPrune((await planProjectPrune(dbPath, 1))!);

    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    for (const path of ["/a", "/b", "/c"]) {
      const cached = await run(store.getCachedPage(`https://e.test${path}`));
      // v3 is the newest audit's etag; anything older means a cold re-crawl.
      expect(cached?.etag).toBe("v3");
    }
    // The kept audit is still fully renderable.
    const crawls = await run(store.listCrawls());
    expect((await run(store.getRuleResultsByPage(crawls[0]!.id))).size).toBe(3);
    // And every audit is still listed.
    expect(crawls).toHaveLength(4);
    store.close?.();
  });
});

/** Add one crawl of the 3-page site, whatever its state. */
async function addCrawl(
  at: number,
  status: CrawlMetadata["status"],
  pageAt: number = at
): Promise<string> {
  const store = new SQLiteStorage(dbPath);
  await run(store.init());
  const id = await run(
    store.createCrawl({
      baseUrl: "https://e.test",
      startedAt: at,
      status,
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  for (const path of ["/a", "/b", "/c"]) {
    const url = `https://e.test${path}`;
    await run(store.upsertPage(id, page(url, pageAt, `v${at}`)));
    await run(
      store.saveRuleResults(id, url, "seo/title", [
        { name: "title-present", status: "pass", message: "m" },
      ])
    );
  }
  store.close?.();
  return id;
}

describe("abandoned crawls (#941)", () => {
  test("3 killed + 4 finished crawls retire cleanly and the prune succeeds", async () => {
    await project(4); // started_at 1000..1003, all completed
    const killed = [
      await addCrawl(500, "crawled"),
      await addCrawl(600, "running"),
      await addCrawl(700, "stopped"),
    ];

    const plan = (await planProjectPrune(dbPath, 1))!;
    // 3 finished audits fall outside --keep 1; the killed ones are listed apart.
    expect(plan.retiring).toHaveLength(3);
    expect(plan.abandoned.map((c) => c.id).sort()).toEqual([...killed].sort());
    expect(plan.abandoned.map((c) => c.status).sort()).toEqual([
      "crawled",
      "running",
      "stopped",
    ]);
    expect(plan.skippedLive).toHaveLength(0);
    // They took no slot: the newest finished audit is the one kept.
    expect(plan.keeping).toBe(1);

    const [outcome] = await runPrunePlans([{ name: "proj", plan }]);
    expect(outcome!.status).not.toBe("failed");
    expect(pruneExitCode([outcome!])).toBe(0);

    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    for (const id of killed) expect(byId.get(id)?.retiredAt).toBeDefined();
    expect(await run(store.listAbandonedCrawls())).toEqual([]);
    store.close?.();
  });

  test("a retired abandoned crawl does not hold a window slot on the next prune", async () => {
    // finished@300, abandoned@200, finished@100, keep 2: pruning twice must
    // retire nothing inside the window.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    await run(store.close());
    const oldest = await addCrawl(100, "analyzed");
    await addCrawl(200, "running");
    await addCrawl(300, "analyzed");

    const first = (await planProjectPrune(dbPath, 2))!;
    expect(first.retiring).toEqual([]);
    expect(first.abandoned).toHaveLength(1);
    await runProjectPrune(first);

    const second = await planProjectPrune(dbPath, 2);
    expect(second?.retiring ?? []).toEqual([]);
    const check = new SQLiteStorage(dbPath);
    await run(check.init());
    const crawl = (await run(check.listCrawls())).find((c) => c.id === oldest);
    expect(crawl?.retiredAt).toBeUndefined();
    await run(check.close());
  });

  test("a crawl newer than the newest finished audit is skipped with its status, never retired", async () => {
    await project(3);
    const live = await addCrawl(5_000, "running");

    const plan = (await planProjectPrune(dbPath, 1))!;
    expect(plan.skippedLive.map((c) => c.id)).toEqual([live]);
    expect(plan.skippedLive[0]!.status).toBe("running");
    expect(plan.abandoned).toEqual([]);

    await runProjectPrune(plan);
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const crawl = (await run(store.listCrawls())).find((c) => c.id === live);
    expect(crawl?.retiredAt).toBeUndefined();
    expect((await run(store.getRuleResultsByPage(live))).size).toBe(3);
    store.close?.();
  });

  test("an orphan with activity in the last 30 minutes is skipped with its last activity, a 31-minute-idle one is retired", async () => {
    await project(3);
    const fresh = await addCrawl(100, "running", Date.now() - 5 * 60_000);
    const idle = await addCrawl(200, "running", Date.now() - 31 * 60_000);

    const plan = (await planProjectPrune(dbPath, 3))!;
    expect(plan.skippedLive.map((c) => c.id)).toEqual([fresh]);
    expect(plan.skippedLive[0]!.lastActivityAt).toBeGreaterThan(
      Date.now() - 6 * 60_000
    );
    expect(plan.abandoned.map((c) => c.id)).toEqual([idle]);

    await runProjectPrune(plan);
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(fresh)?.retiredAt).toBeUndefined();
    expect(byId.get(idle)?.retiredAt).toBeDefined();
    await run(store.close());
  });

  test("a project with only a live crawl plans as skipped-only, not as work", async () => {
    await project(1);
    await addCrawl(5_000, "crawled");
    const plan = (await planProjectPrune(dbPath, 3))!;
    expect(plan.skippedLive).toHaveLength(1);
    expect(plan.retiring).toHaveLength(0);
    // Nothing actionable: running the plans touches nothing and reports nothing.
    expect(
      await runPrunePlans([{ name: "proj", plan }], async () => {
        throw new Error("must not run");
      })
    ).toEqual([]);
  });

  test("dry-run planning deletes nothing", async () => {
    await project(2);
    const killed = await addCrawl(100, "running");
    await planProjectPrune(dbPath, 1);
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const crawl = (await run(store.listCrawls())).find((c) => c.id === killed);
    expect(crawl?.retiredAt).toBeUndefined();
    expect((await run(store.getRuleResultsByPage(killed))).size).toBe(3);
    store.close?.();
  });

  test("a crawl that went live between plan and run is skipped, and the rest of the project still retires", async () => {
    await project(3);
    const stale = await addCrawl(100, "running");
    const plan = (await planProjectPrune(dbPath, 1))!;
    expect(plan.abandoned.map((c) => c.id)).toEqual([stale]);
    expect(plan.retiring).toHaveLength(2);

    // The crawl fetches a page after the plan was made.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    await run(
      store.upsertPage(stale, page("https://e.test/live", Date.now(), "live"))
    );
    await run(store.close());

    const outcomes = await runPrunePlans([{ name: "proj", plan }]);
    expect(outcomes[0]!.status).not.toBe("failed");
    expect(pruneExitCode(outcomes)).toBe(0);

    const check = new SQLiteStorage(dbPath);
    await run(check.init());
    const byId = new Map((await run(check.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(stale)?.retiredAt).toBeUndefined();
    for (const c of plan.retiring)
      expect(byId.get(c.id)?.retiredAt).toBeDefined();
    await run(check.close());
  });

  test("a failed crawl newer than the newest finished audit holds no --keep slot and is skipped", async () => {
    await project(3);
    const failed = await addCrawl(5_000, "failed");
    const plan = (await planProjectPrune(dbPath, 3))!;
    // All three finished audits stay: the failed crawl takes no slot.
    expect(plan.retiring).toEqual([]);
    expect(plan.keeping).toBe(3);
    expect(plan.skippedLive.map((c) => c.id)).toEqual([failed]);
  });
});

describe("prune across projects (#941)", () => {
  test("one project that fails to plan or run does not stop the rest", async () => {
    // Real databases for good projects; a garbage file for the bad one.
    await project(3);
    const good1 = dbPath;
    const bad = join(dir, "bad", "project.db");
    mkdirSync(join(dir, "bad"), { recursive: true });
    await Bun.write(bad, "this is not a sqlite database".repeat(100));
    mkdirSync(join(dir, "zlast"), { recursive: true });
    dbPath = join(dir, "zlast", "project.db");
    await project(3);
    const good2 = dbPath;

    const { plans, failed } = await planProjects(
      [
        { name: "a-good", dbPath: good1 },
        { name: "bad", dbPath: bad },
        { name: "zlast", dbPath: good2 },
      ],
      1
    );
    expect(plans.map((p) => p.name)).toEqual(["a-good", "zlast"]);
    expect(failed.map((f) => f.name)).toEqual(["bad"]);
    expect(failed[0]!.reason).toMatch(/could not plan/);

    // A run failure in the first project still lets the second one run.
    let calls = 0;
    const outcomes = await runPrunePlans(plans, async (plan) => {
      calls++;
      if (calls === 1) throw new Error("database is locked");
      return runProjectPrune(plan);
    });
    expect(outcomes.map((o) => [o.name, o.status])).toEqual([
      ["a-good", "failed"],
      ["zlast", "ok"],
    ]);
    expect(outcomes[0]!.reason).toBe("database is locked");
    expect(pruneExitCode([...outcomes, ...failed])).toBe(1);
  });

  test("exit code: 0 for ok and skipped, 1 only when a project failed", () => {
    const o = (status: "ok" | "skipped" | "failed") => ({
      name: "p",
      status,
      bytesBefore: 0,
      bytesAfter: 0,
    });
    expect(pruneExitCode([])).toBe(0);
    expect(pruneExitCode([o("ok"), o("skipped")])).toBe(0);
    expect(pruneExitCode([o("ok"), o("failed")])).toBe(1);
  });

  test("a run that skips the rebuild for low disk still retires and is a skip", async () => {
    await project(3);
    const plan = (await planProjectPrune(dbPath, 1))!;
    const outcomes = await runPrunePlans(
      [{ name: "proj", plan }],
      async (p) => ({
        rows: p.rows,
        bytesBefore: p.bytesBefore,
        bytesAfter: p.bytesBefore,
        vacuumSkipped: "not enough free disk to rebuild",
      })
    );
    expect(outcomes[0]!.status).toBe("skipped");
    expect(pruneExitCode(outcomes)).toBe(0);
  });

  test("lowDiskReason compares free space with the file plus a margin", async () => {
    await project(1);
    expect(lowDiskReason(dbPath, 0)).toMatch(/not enough free disk/);
    expect(lowDiskReason(dbPath, 10 * 1024 * 1024 * 1024)).toBeUndefined();
    // Free space that cannot be read does not block the rebuild.
    expect(lowDiskReason(dbPath, undefined)).toBeUndefined();
  });

  test("formatAge is coarse", () => {
    const now = 10 * 24 * 3_600_000;
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatAge(now - 5 * 3_600_000, now)).toBe("5h");
    expect(formatAge(now - 3 * 24 * 3_600_000, now)).toBe("3d");
  });
});
