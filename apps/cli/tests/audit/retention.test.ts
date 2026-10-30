// Automatic retention (#1912): an audit now deletes some of the user's audit
// history on its own, so the tests that matter are the ones about what it must
// NOT take.
//
// Three things would each be worse than the disk this saves: retiring the crawl
// that is still being written, retiring the page rows the next incremental
// re-audit reads (turning every re-audit into a cold crawl), and counting an
// audit nobody can open toward "the last 3 you can open".

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  auditMayRetire,
  formatRetentionNotice,
  retainRecentAudits,
  selectCrawlsToRetire,
} from "../../src/audit/retention";
import { getDefaultConfig } from "../../src/config";

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

const PATHS = ["/a", "/b", "/c"];

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

/** One audit of the same 3-page site: pages, rule results, and a crawl row. */
async function audit(
  store: SQLiteStorage,
  index: number,
  status: CrawlMetadata["status"] = "analyzed",
  reportStatus: string | null = "completed"
): Promise<string> {
  const id = await run(
    store.createCrawl({
      baseUrl: "https://e.test",
      startedAt: 1_000 + index,
      status,
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  if (reportStatus !== null) {
    await run(store.setReportStatus(id, reportStatus));
  }
  for (const path of PATHS) {
    const url = `https://e.test${path}`;
    await run(store.upsertPage(id, page(url, 1_000 + index, `v${index}`)));
    await run(
      store.saveRuleResults(id, url, "seo/title", [
        { name: "title-present", status: "pass", message: "m" },
      ])
    );
  }
  return id;
}

/** An audit whose page rows are big enough to move the freelist measurably. */
async function bigAudit(
  store: SQLiteStorage,
  index: number,
  pages: number
): Promise<string> {
  const html = "x".repeat(32 * 1024);
  const id = await run(
    store.createCrawl({
      baseUrl: "https://e.test",
      startedAt: 1_000 + index,
      status: "analyzed",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  for (let p = 0; p < pages; p++) {
    const url = `https://e.test/p${p}`;
    await run(
      store.upsertPage(id, page(url, 1_000 + index, `v${index}`, html))
    );
  }
  return id;
}

async function open(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(dbPath);
  await run(store.init());
  return store;
}

/** Finished audits whose report can still be rebuilt, i.e. which still have results. */
async function renderable(store: SQLiteStorage): Promise<string[]> {
  const crawls = await run(store.listCrawls());
  const out: string[] = [];
  for (const crawl of crawls) {
    if (crawl.retiredAt !== undefined) continue;
    if (crawl.status !== "completed" && crawl.status !== "analyzed") continue;
    const byPage = await run(store.getRuleResultsByPage(crawl.id));
    if (byPage.size > 0) out.push(crawl.id);
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-retention-"));
  mkdirSync(join(dir, "proj"), { recursive: true });
  dbPath = join(dir, "proj", "project.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("selectCrawlsToRetire", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `c${n - i}` }));

  test("keeps the newest `keep` and returns the rest", () => {
    // Newest first: c5 c4 c3 c2 c1.
    expect(
      selectCrawlsToRetire(ids(5), { keep: 3, currentCrawlId: "c5" })
    ).toEqual(["c2", "c1"]);
  });

  test("0 disables it, and so does anything below 0", () => {
    for (const keep of [0, -1, Number.NaN]) {
      expect(
        selectCrawlsToRetire(ids(9), { keep, currentCrawlId: "c9" })
      ).toEqual([]);
    }
  });

  test("never the crawl that just ran, even when the window says it should go", () => {
    // A window of 1 with the current audit sitting oldest: without the guard
    // this would delete the run whose report is about to be written.
    const candidates = [{ id: "newer" }, { id: "current" }];
    expect(
      selectCrawlsToRetire(candidates, { keep: 1, currentCrawlId: "current" })
    ).toEqual([]);
  });

  test("the window is over renderable audits, which is what the query hands it", () => {
    // listRetentionCandidates already drops retired, running and failed crawls,
    // so `keep` counts reports a user can actually open. The pair of tests in
    // `retainRecentAudits` below is what holds that end up.
    expect(
      selectCrawlsToRetire([{ id: "c3" }, { id: "c2" }, { id: "c1" }], {
        keep: 2,
        currentCrawlId: "c3",
      })
    ).toEqual(["c1"]);
  });
});

describe("retainRecentAudits", () => {
  test("keeps exactly `keep` renderable audits", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await audit(store, i));

    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: ids[4]!,
    });

    expect(outcome?.retired).toBe(2);
    // The newest three, and nothing else.
    expect((await renderable(store)).sort()).toEqual(
      [ids[2]!, ids[3]!, ids[4]!].sort()
    );
    store.close?.();
  });

  test("the retired audits are stamped, and only those", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await audit(store, i));
    await retainRecentAudits(store, { keep: 3, currentCrawlId: ids[3]! });

    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    // A number, not "not undefined": a `retired_at` the migration never added
    // reads back as undefined, so asserting on absence proves nothing.
    expect(typeof byId.get(ids[0]!)?.retiredAt).toBe("number");
    for (const id of ids.slice(1)) {
      expect(byId.get(id)?.retiredAt).toBeUndefined();
    }
    // Every audit is still LISTED — the history shrinking silently is the
    // failure this column exists to prevent.
    expect(byId.size).toBe(4);
    store.close?.();
  });

  test("does nothing when the project holds no more than the window", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await audit(store, i));

    expect(
      await retainRecentAudits(store, { keep: 3, currentCrawlId: ids[2]! })
    ).toBeNull();
    expect(await renderable(store)).toHaveLength(3);
    store.close?.();
  });

  test("does not run when disabled, whichever way it was disabled", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await audit(store, i));

    // `keep_audits = false` in TOML resolves to 0 through the schema.
    for (const keep of [0, -1]) {
      expect(
        await retainRecentAudits(store, { keep, currentCrawlId: ids[5]! })
      ).toBeNull();
    }
    expect(await renderable(store)).toHaveLength(6);
    store.close?.();
  });

  test("leaves a running crawl newer than every finished audit alone, and gives it no window slot", async () => {
    const store = await open();
    // Oldest to newest: four finished audits, then a crawl still running.
    const finished: string[] = [];
    for (let i = 0; i < 4; i++) finished.push(await audit(store, i));
    const running = await audit(store, 4, "running", null);

    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: finished[3]!,
    });

    // One finished audit went: the running crawl did not take a slot. It is
    // newer than every finished audit, so it may be live, and it stays whole.
    expect(outcome?.retired).toBe(1);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(running)?.retiredAt).toBeUndefined();
    expect(byId.get(finished[0]!)?.retiredAt).toBeDefined();
    expect((await run(store.getRuleResultsByPage(running))).size).toBe(3);
    store.close?.();
  });

  test("retires crawls from killed audits once a newer audit has finished, and they take no window slot (#941)", async () => {
    const store = await open();
    // The issue's repro: three audits killed after the crawl, then one that
    // completed. keep_audits = 1.
    const killed: string[] = [];
    killed.push(await audit(store, 0, "crawled", null));
    killed.push(await audit(store, 1, "running", null));
    killed.push(await audit(store, 2, "stopped", null));
    killed.push(await audit(store, 3, "paused", null));
    const failed = await audit(store, 4, "failed", null);
    const older = await audit(store, 5);
    const current = await audit(store, 6);

    const outcome = await retainRecentAudits(store, {
      keep: 1,
      currentCrawlId: current,
    });

    // 5 unfinished + the one older finished audit outside the window.
    expect(outcome?.retired).toBe(killed.length + 2);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    for (const id of [...killed, failed, older]) {
      expect(byId.get(id)?.retiredAt).toBeDefined();
    }
    expect(byId.get(current)?.retiredAt).toBeUndefined();
    expect(await renderable(store)).toEqual([current]);
    store.close?.();
  });

  test("an unfinished crawl older than a finished audit but active 5 minutes ago is kept (#941)", async () => {
    const store = await open();
    const overlapping = await audit(store, 0, "running", null);
    // A live overlapping audit just fetched a page.
    await run(
      store.upsertPage(
        overlapping,
        page("https://e.test/live", Date.now() - 5 * 60_000, "live")
      )
    );
    const current = await audit(store, 1);

    expect(
      await retainRecentAudits(store, { keep: 3, currentCrawlId: current })
    ).toBeNull();
    const crawl = (await run(store.listCrawls())).find(
      (c) => c.id === overlapping
    );
    expect(crawl?.retiredAt).toBeUndefined();
    expect((await run(store.getRuleResultsByPage(overlapping))).size).toBe(3);
    store.close?.();
  });

  test("a crawl that went live after the listing is skipped alone; the rest of the pass retires (#941)", async () => {
    const store = await open();
    const stale = await audit(store, 0, "running", null);
    const old = await audit(store, 1);
    await audit(store, 2);
    const abandoned = await run(store.listAbandonedCrawls());
    expect(abandoned.map((c) => c.id)).toEqual([stale]);

    // Between the listing and the write the crawl fetches a page: a live
    // audit. The same batch also holds an ordinary keep_audits retirement.
    await run(
      store.upsertPage(
        stale,
        page("https://e.test/live", Date.now() - 60_000, "live")
      )
    );
    const result = await run(
      store.retireCrawlsDetailed([stale, old], Date.now(), {
        allowAbandoned: true,
      })
    );
    expect(result.retired).toEqual([old]);
    expect(result.skipped).toEqual([stale]);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(stale)?.retiredAt).toBeUndefined();
    expect(byId.get(old)?.retiredAt).toBeDefined();
    store.close?.();
  });

  test("an audit that came back failed or blocked is not one of the three", async () => {
    const store = await open();
    // The downtime case: three good audits, then a week of the site being down
    // producing runs that finish and report `blocked`, then the recovery audit.
    // Counting the blocked runs would fill the window with them and delete
    // every audit from before the outage — the exact history you would open.
    const good: string[] = [];
    for (let i = 0; i < 3; i++) good.push(await audit(store, i));
    await audit(store, 3, "analyzed", "blocked");
    await audit(store, 4, "analyzed", "failed");
    const recovery = await audit(store, 5);

    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: recovery,
    });

    // The window is [recovery, good3, good2]; only the oldest good audit goes,
    // and the two that learned nothing are left out of the count entirely.
    expect(outcome?.retired).toBe(1);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(good[0]!)?.retiredAt).toBeDefined();
    expect(byId.get(good[1]!)?.retiredAt).toBeUndefined();
    expect(byId.get(good[2]!)?.retiredAt).toBeUndefined();
    store.close?.();
  });

  /** Record the crawl lease a running audit holds: a fresh heartbeat from this process. */
  function holdLease(id: string): void {
    const raw = new Database(dbPath);
    raw
      .query(
        "UPDATE crawls SET heartbeat_at = ?, owner_pid = ?, owner_host = ? WHERE id = ?"
      )
      .run(Date.now(), process.pid, hostname(), id);
    raw.close();
  }

  test("an audit still building its report is never retired", async () => {
    const store = await open();
    // Another process is between the `analyzed` stamp and its own report. It
    // reads as a finished audit to everything else, and retiring it there turns
    // a run that was going to succeed into "Audit data was reclaimed". Its owner
    // holds the crawl lease, which is what says it is alive (#288).
    const building = await audit(store, 0, "analyzed", "building");
    holdLease(building);
    const later: string[] = [];
    for (let i = 1; i < 5; i++) later.push(await audit(store, i));

    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: later[3]!,
    });

    expect(outcome?.retired).toBe(1);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(building)?.retiredAt).toBeUndefined();
    expect(byId.get(later[0]!)?.retiredAt).toBeDefined();
    store.close?.();
  });

  /** The build of this crawl began `hours` ago. */
  function buildingSince(id: string, hours: number): void {
    const raw = new Database(dbPath);
    raw
      .query("UPDATE crawls SET building_at = ? WHERE id = ?")
      .run(Date.now() - hours * 3_600_000, id);
    raw.close();
  }

  test("an audit killed while building its report is recovered by a later audit (#288)", async () => {
    const store = await open();
    // No owner and building for hours: the process died after the `analyzed`
    // stamp. It holds no slot of the window, and the audit that finds it, with
    // three newer audits to keep, retires it.
    const stuck = await audit(store, 0, "analyzed", "building");
    buildingSince(stuck, 7);
    const later: string[] = [];
    for (let i = 1; i < 4; i++) later.push(await audit(store, i));

    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: later[2]!,
    });

    expect(outcome?.retired).toBe(1);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(stuck)?.retiredAt).toBeDefined();
    for (const id of later) expect(byId.get(id)?.retiredAt).toBeUndefined();
    store.close?.();
  });

  test("a recovered audit inside the keep window is never retired (#288)", async () => {
    const store = await open();
    // `squirrel analyze` rebuilt this audit's report and left the sentinel on
    // purpose (#955): it is viewable. Only two audits follow it and keep is 3, so
    // it is inside the window, however long ago it started building.
    const rebuilt = await audit(store, 0, "analyzed", "building");
    buildingSince(rebuilt, 9);
    const later: string[] = [];
    for (let i = 1; i < 3; i++) later.push(await audit(store, i));

    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: later[1]!,
    });

    expect(outcome).toBeNull();
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(rebuilt)?.retiredAt).toBeUndefined();
    store.close?.();
  });

  test("an audit that has only just started building is left alone (#288)", async () => {
    const store = await open();
    // Its pages are ancient, but the build began an hour ago and its owner has no
    // heartbeat: nothing says it is dead, and a healthy audit looks exactly like this.
    const healthy = await audit(store, 0, "analyzed", "building");
    buildingSince(healthy, 1);
    const later: string[] = [];
    for (let i = 1; i < 5; i++) later.push(await audit(store, i));

    await retainRecentAudits(store, { keep: 3, currentCrawlId: later[3]! });

    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(healthy)?.retiredAt).toBeUndefined();
    store.close?.();
  });

  test("an audit from before the column existed is an ordinary audit", async () => {
    const store = await open();
    // NULL report_status means the crawl predates migration 27, not that it
    // failed. Treating those as ineligible would mean retention never touched
    // anything a user already had.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await audit(store, i, "analyzed", null));
    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: ids[4]!,
    });
    expect(outcome?.retired).toBe(2);
    store.close?.();
  });

  test("a failed crawl takes no window slot; one older than a finished audit is retired as abandoned (#941)", async () => {
    const store = await open();
    const failed = await audit(store, 0, "failed");
    const finished: string[] = [];
    for (let i = 1; i < 4; i++) finished.push(await audit(store, i));

    // Three finished audits and one failed one. Counting the failure would put
    // the oldest finished audit outside a window of 3: it must not, so only the
    // failed crawl itself goes, as an unfinished crawl no one can resume.
    const outcome = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: finished[2]!,
    });
    expect(outcome?.retired).toBe(1);
    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(byId.get(failed)?.retiredAt).toBeDefined();
    expect(await renderable(store)).toHaveLength(3);
    store.close?.();
  });

  test("the conditional-GET cache survives, so the next audit is not a cold crawl", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await audit(store, i));
    await retainRecentAudits(store, { keep: 3, currentCrawlId: ids[4]! });

    for (const path of PATHS) {
      const cached = await run(store.getCachedPage(`https://e.test${path}`));
      // v4 is the newest audit's etag. Anything older — or null — means the
      // next crawl refetches the whole site.
      expect(cached?.etag).toBe("v4");
    }
    store.close?.();
  });

  test("a url only the retired audit ever saw keeps its row", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await audit(store, i));
    // A page the first audit found and no later one did.
    await run(
      store.upsertPage(ids[0]!, page("https://e.test/gone", 1_000, "only"))
    );

    await retainRecentAudits(store, { keep: 3, currentCrawlId: ids[3]! });

    const cached = await run(store.getCachedPage("https://e.test/gone"));
    // Still the freshest thing known about that url, so it stays.
    expect(cached?.etag).toBe("only");
    store.close?.();
  });

  test("a second pass over the same project retires nothing", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await audit(store, i));

    const first = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: ids[4]!,
    });
    expect(first?.retired).toBe(2);
    expect(first?.firstRetirement).toBe(true);

    // Nothing new has been audited, so there is nothing outside the window.
    expect(
      await retainRecentAudits(store, { keep: 3, currentCrawlId: ids[4]! })
    ).toBeNull();

    // A sixth audit pushes exactly one more out, and it is no longer the first
    // time this project has retired anything.
    const sixth = await audit(store, 5);
    const second = await retainRecentAudits(store, {
      keep: 3,
      currentCrawlId: sixth,
    });
    expect(second?.retired).toBe(1);
    expect(second?.firstRetirement).toBe(false);
    store.close?.();
  });

  test("retiring ONE audit does not rewrite the file, however much it frees", async () => {
    const store = await open();
    // Three audits of the same pages, so retiring the oldest frees about a
    // third of the file — past the share threshold. Only the "more than one
    // audit" half of the guard stands between this and a rewrite.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await bigAudit(store, i, 30));

    const outcome = await retainRecentAudits(store, {
      keep: 2,
      currentCrawlId: ids[2]!,
    });
    expect(outcome?.retired).toBe(1);

    // The threshold really was exceeded, so this is not passing because there
    // was nothing to reclaim.
    const stats = await run(store.databasePageStats());
    expect(stats.freelistPages / stats.pageCount).toBeGreaterThan(0.25);

    // The steady state is exactly this: one audit out per audit in. Rewriting
    // here would mean rebuilding the whole database after every audit, forever.
    expect(outcome?.vacuumed).toBe(false);
    store.close?.();
  });

  test("retiring a backlog does rewrite the file, and the space comes back", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await bigAudit(store, i, 20));
    const before = await run(store.databasePageStats());

    // Retention switched on over a backlog, or the window lowered: more than
    // one audit goes at once, which is when the rewrite is worth its cost.
    const outcome = await retainRecentAudits(store, {
      keep: 1,
      currentCrawlId: ids[4]!,
    });

    expect(outcome?.retired).toBe(4);
    expect(outcome?.vacuumed).toBe(true);
    // Rewritten, so the file itself is smaller — not just its freelist bigger.
    const after = await run(store.databasePageStats());
    expect(after.pageCount).toBeLessThan(before.pageCount);
    expect(after.freelistPages).toBe(0);
    expect(outcome!.freedBytes).toBeGreaterThan(0);
    store.close?.();
  });

  test("a page an earlier retirement kept is collected once a later audit supersedes it", async () => {
    const store = await open();
    // /a is seen by every audit. /gone is seen ONLY by the first, so its row
    // survives that crawl's retirement: at the time it is the freshest record
    // of that url.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await audit(store, i));
    await run(
      store.upsertPage(ids[0]!, page("https://e.test/gone", 1_000, "old"))
    );
    await retainRecentAudits(store, { keep: 3, currentCrawlId: ids[3]! });
    expect((await run(store.getCachedPage("https://e.test/gone")))?.etag).toBe(
      "old"
    );

    // A later audit finds that url again. The kept row is now superseded, and
    // its crawl is already retired — so nothing would ever look at it again.
    const fifth = await audit(store, 4);
    await run(
      store.upsertPage(fifth, page("https://e.test/gone", 5_000, "fresh"))
    );
    await retainRecentAudits(store, { keep: 3, currentCrawlId: fifth });

    const rows = await run(store.getPageCount(ids[0]!));
    expect(rows).toBe(0);
    // And the url still resolves, to the newest record of it.
    expect((await run(store.getCachedPage("https://e.test/gone")))?.etag).toBe(
      "fresh"
    );
    store.close?.();
  });

  test("ties on started_at are broken by insert order, not by the query plan", async () => {
    const store = await open();
    // Two audits stamped in the same millisecond. Which one is "newer" has to
    // be decided the same way every time, or the wrong report gets deleted.
    const older = await audit(store, 0);
    const newer = await audit(store, 0);

    await retainRecentAudits(store, { keep: 1, currentCrawlId: newer });

    const byId = new Map((await run(store.listCrawls())).map((c) => [c.id, c]));
    expect(typeof byId.get(older)?.retiredAt).toBe("number");
    expect(byId.get(newer)?.retiredAt).toBeUndefined();
    store.close?.();
  });
});

describe("auditMayRetire", () => {
  test("a completed or partial audit may retire; a failed or blocked one may not", () => {
    expect(auditMayRetire(undefined)).toBe(true);
    expect(auditMayRetire("completed")).toBe(true);
    // Partial is a real audit with real findings on the pages it reached.
    expect(auditMayRetire("partial")).toBe(true);
    // These two exit nonzero and mean "we learned nothing about this site".
    // Retiring on them would let a week of downtime delete the history you
    // would use to find out when it broke.
    expect(auditMayRetire("failed")).toBe(false);
    expect(auditMayRetire("blocked")).toBe(false);
  });
});

describe("the default window", () => {
  test("is three, and it is on", () => {
    expect(getDefaultConfig().storage.keep_audits).toBe(3);
  });
});

describe("formatRetentionNotice", () => {
  test("says what went and where the space went, and teaches the knob once", () => {
    expect(
      formatRetentionNotice({
        retired: 1,
        freedBytes: 99_857_203,
        vacuumed: false,
        firstRetirement: true,
        keep: 3,
      })
    ).toBe(
      "Retired 1 older audit and freed 95.2 MB inside project.db for the next audit; keep more with [storage] keep_audits (now 3)"
    );
  });

  test("says only what happened when the deletes freed less than a page", () => {
    expect(
      formatRetentionNotice({
        retired: 1,
        freedBytes: 0,
        vacuumed: false,
        firstRetirement: false,
        keep: 3,
      })
    ).toBe("Retired 1 older audit");
  });

  test("drops the hint once the user has seen it, and pluralizes", () => {
    expect(
      formatRetentionNotice({
        retired: 4,
        freedBytes: 5_242_880,
        vacuumed: true,
        firstRetirement: false,
        keep: 1,
      })
    ).toBe("Retired 4 older audits and reclaimed 5.0 MB");
  });
});
