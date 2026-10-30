// #289: page rows that retirement kept and a later audit superseded BEFORE
// automatic retention existed are collected once, by migration 39.
// #288: a crawl left stamped `building` by an interrupted audit is recovered
// by a later audit, and never while its owner is alive.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { hostname } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "../src/storage/types";
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

function page(url: string, fetchedAt: number): PageRecord {
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
    etag: `e${fetchedAt}`,
    lastModified: null,
    contentHash: `h${fetchedAt}`,
    html: "<html></html>",
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

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-retention-289-"));
  dbPath = join(dir, "project.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function open(): Promise<SQLiteStorage> {
  const s = new SQLiteStorage(dbPath);
  await run(s.init());
  return s;
}

async function crawl(
  s: SQLiteStorage,
  startedAt: number,
  urls: string[],
  reportStatus: string | null = "completed"
): Promise<string> {
  const id = await run(
    s.createCrawl({
      baseUrl: "https://e.test",
      startedAt,
      status: "analyzed",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  if (reportStatus !== null) await run(s.setReportStatus(id, reportStatus));
  for (const url of urls) await run(s.upsertPage(id, page(url, startedAt)));
  return id;
}

const rowsOf = (id: string): string[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT normalized_url AS u FROM pages WHERE crawl_id = ? ORDER BY u").all(id) as Array<{
        u: string;
      }>
    ).map((r) => r.u);
  } finally {
    db.close();
  }
};

describe("#289: the repair of rows superseded before automatic retention", () => {
  async function pre285State(): Promise<{ first: string }> {
    const s = await open();
    const first = await crawl(s, 1_000, ["https://e.test/a", "https://e.test/b", "https://e.test/c"]);
    // `self disk --prune` retired it, keeping all rows (each was the freshest).
    await run(s.retireCrawls([first], 1_500));
    // A later audit re-crawls /a and /b. Before #285 nothing collected what it superseded.
    await crawl(s, 2_000, ["https://e.test/a", "https://e.test/b"]);
    s.close?.();
    return { first };
  }

  test("init() never deletes: a big project's open is not a long transaction", async () => {
    const { first } = await pre285State();
    const s = await open();
    expect(rowsOf(first)).toEqual(["https://e.test/a", "https://e.test/b", "https://e.test/c"]);
    s.close?.();
  });

  test("the repair removes superseded rows, keeps the only copy, and runs once", async () => {
    const { first } = await pre285State();
    let s = await open();
    expect(await run(s.repairSupersededPagesOnce())).toBe(2);
    expect(rowsOf(first)).toEqual(["https://e.test/c"]);
    // Marked done: a later superseded row is not this repair's business.
    expect(await run(s.repairSupersededPagesOnce())).toBe(0);
    s.close?.();
    s = await open();
    await crawl(s, 3_000, ["https://e.test/c"]);
    expect(await run(s.repairSupersededPagesOnce())).toBe(0);
    expect(rowsOf(first)).toEqual(["https://e.test/c"]);
    s.close?.();
  });

  const cursor = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        db.query("SELECT done_at AS at FROM maintenance_marks WHERE name = 'superseded-pages-cursor'").get() as {
          at: number;
        } | null
      )?.at;
    } finally {
      db.close();
    }
  };
  const marked = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query("SELECT 1 FROM maintenance_marks WHERE name = 'superseded-pages'").get() !== null;
    } finally {
      db.close();
    }
  };

  test("it is chunked and resumable: a partial run leaves no marker, the next finishes", async () => {
    const { first } = await pre285State();
    const s = await open();
    // One pass of one row, then stop (a killed process looks the same).
    await run(s.repairSupersededPagesOnce({ chunk: 1, maxChunks: 1 }));
    expect(marked()).toBe(false);
    await run(s.repairSupersededPagesOnce({ chunk: 1 }));
    expect(rowsOf(first)).toEqual(["https://e.test/c"]);
    expect(marked()).toBe(true);
    s.close?.();
  });

  test("a cursor means a row that stays is examined once: many only copies cost chunks, not chunks squared", async () => {
    const s = await open();
    // 60 only-copy rows in a retired crawl, plus 3 that a later audit supersedes.
    const urls = Array.from({ length: 63 }, (_, i) => `https://e.test/p${String(i).padStart(2, "0")}`);
    const first = await crawl(s, 1_000, urls);
    await run(s.retireCrawls([first], 1_500));
    await crawl(s, 2_000, urls.slice(0, 3));
    s.close?.();

    let calls = 0;
    const seen: number[] = [];
    const store = await open();
    for (;;) {
      calls++;
      await run(store.repairSupersededPagesOnce({ chunk: 10, maxChunks: 1 }));
      const at = cursor();
      if (at !== undefined) seen.push(at);
      if (marked() || calls > 20) break;
    }
    // 63 rows at 10 per chunk is 7 examining passes plus the empty pass that marks it done;
    // an LIMIT-without-cursor repair would re-read the only copies on every pass.
    expect(calls).toBe(8);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // The cursor moved on every examining pass and stayed put on the empty one.
    expect(new Set(seen).size).toBe(7);
    expect(rowsOf(first)).toHaveLength(60);
    store.close?.();
  });

  test("a call is budgeted: with no time it does one chunk, and later calls finish", async () => {
    const s = await open();
    const urls = Array.from({ length: 30 }, (_, i) => `https://e.test/q${String(i).padStart(2, "0")}`);
    const first = await crawl(s, 1_000, urls);
    await run(s.retireCrawls([first], 1_500));
    await crawl(s, 2_000, urls);
    // budgetMs 0: one chunk of 10 rows per call.
    await run(s.repairSupersededPagesOnce({ chunk: 10, budgetMs: 0 }));
    expect(rowsOf(first)).toHaveLength(20);
    expect(marked()).toBe(false);
    for (let i = 0; i < 6 && !marked(); i++) await run(s.repairSupersededPagesOnce({ chunk: 10, budgetMs: 0 }));
    expect(rowsOf(first)).toHaveLength(0);
    expect(marked()).toBe(true);
    s.close?.();
  });

  test("the default chunk is 500 rows, so the write lock is held briefly", async () => {
    const s = await open();
    const urls = Array.from({ length: 1200 }, (_, i) => `https://e.test/d${String(i).padStart(4, "0")}`);
    const first = await crawl(s, 1_000, urls);
    await run(s.retireCrawls([first], 1_500));
    await crawl(s, 2_000, urls);
    await run(s.repairSupersededPagesOnce({ budgetMs: 0 }));
    expect(rowsOf(first)).toHaveLength(700);
    s.close?.();
  });

  test("a project that never retired anything loses nothing", async () => {
    const s = await open();
    const old = await crawl(s, 1_000, ["https://e.test/a"]);
    await crawl(s, 2_000, ["https://e.test/a"]);
    expect(await run(s.repairSupersededPagesOnce())).toBe(0);
    expect(rowsOf(old)).toEqual(["https://e.test/a"]);
    s.close?.();
  });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("#288: an interrupted report build is recovered, a live one never", () => {
  const raw = (fn: (db: Database) => void) => {
    const db = new Database(dbPath);
    fn(db);
    db.close();
  };
  const own = (id: string, heartbeatAgeMs: number, pid = process.pid, host = hostname()) =>
    raw((db) =>
      db
        .query("UPDATE crawls SET heartbeat_at = ?, owner_pid = ?, owner_host = ? WHERE id = ?")
        .run(Date.now() - heartbeatAgeMs, pid, host, id)
    );
  const buildingSince = (id: string, ageMs: number | null) =>
    raw((db) =>
      db
        .query("UPDATE crawls SET building_at = ? WHERE id = ?")
        .run(ageMs === null ? null : Date.now() - ageMs, id)
    );
  const interrupted = async (s: SQLiteStorage) => (await run(s.listInterruptedReports())).map((c) => c.id);

  test("the sentinel stamps building_at, and analyze's keepBuilding does not move it", async () => {
    const s = await open();
    const id = await crawl(s, 1_000, ["https://e.test/a"], "building");
    const stamp = () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (db.query("SELECT building_at AS b FROM crawls WHERE id = ?").get(id) as { b: number | null }).b;
      } finally {
        db.close();
      }
    };
    const first = stamp();
    expect(first).toBeGreaterThan(Date.now() - 60_000);
    await run(s.setReportStatus(id, "completed", { keepBuilding: true }));
    expect(stamp()).toBe(first);
    s.close?.();
  });

  test("building for more than 6 hours, a later audit completed, no owner: listed", async () => {
    const s = await open();
    const stuck = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(stuck, 7 * HOUR);
    await crawl(s, 2_000, ["https://e.test/a"]);
    expect(await interrupted(s)).toEqual([stuck]);
    s.close?.();
  });

  test("a healthy audit that has only just started building is not listed, whatever its pages' age", async () => {
    const s = await open();
    // Its pages are ancient (the crawl ended long ago); the build began an hour ago.
    const healthy = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(healthy, HOUR);
    await crawl(s, 2_000, ["https://e.test/a"]);
    expect(await interrupted(s)).toEqual([]);
    s.close?.();
  });

  test("a crawl stamped before building_at existed waits a week on its last activity", async () => {
    const s = await open();
    const legacy = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(legacy, null);
    await crawl(s, 2_000, ["https://e.test/a"]);
    // Its pages are from 1970 here, so the week has long passed.
    expect(await interrupted(s)).toEqual([legacy]);
    // ...but not when its last activity is recent.
    const recent = await crawl(s, Date.now() - 2 * DAY, ["https://e.test/b"], "building");
    buildingSince(recent, null);
    await crawl(s, Date.now() - DAY, ["https://e.test/b"]);
    expect(await interrupted(s)).toEqual([legacy]);
    s.close?.();
  });

  test("an owner pid that is alive on this host is live however old its heartbeat", async () => {
    const s = await open();
    const laptop = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(laptop, 3 * DAY);
    own(laptop, 3 * DAY); // closed over a weekend: the process is alive, its beats stopped
    await crawl(s, 2_000, ["https://e.test/a"]);
    expect(await interrupted(s)).toEqual([]);
    const out = await run(s.retireCrawlsDetailed([laptop], Date.now(), { allowAbandoned: true }));
    expect(out.skipped).toEqual([laptop]);
    s.close?.();
  });

  test("a fresh heartbeat from another host is live; a stale one is only trusted for the 6 hour clock", async () => {
    const s = await open();
    const fresh = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(fresh, 10 * HOUR);
    own(fresh, 60_000, 999_999, "other-container");
    const stale = await crawl(s, 1_100, ["https://e.test/a"], "building");
    buildingSince(stale, HOUR); // building for an hour: not yet
    own(stale, 30 * 60_000, 999_998, "other-container");
    const old = await crawl(s, 1_200, ["https://e.test/a"], "building");
    buildingSince(old, 8 * HOUR);
    own(old, 8 * HOUR, 999_997, "other-container");
    await crawl(s, 2_000, ["https://e.test/a"]);
    expect(await interrupted(s)).toEqual([old]);
    s.close?.();
  });

  test("a building crawl newer than every finished audit is never listed", async () => {
    const s = await open();
    await crawl(s, 1_000, ["https://e.test/a"]);
    const newest = await crawl(s, 2_000, ["https://e.test/a"], "building");
    buildingSince(newest, 9 * HOUR);
    expect(await interrupted(s)).toEqual([]);
    s.close?.();
  });

  test("the retirement re-checks inside its transaction: an interrupted one goes", async () => {
    const s = await open();
    const stuck = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(stuck, 7 * HOUR);
    await crawl(s, 2_000, ["https://e.test/b"]);
    const out = await run(s.retireCrawlsDetailed([stuck], Date.now(), { allowAbandoned: true }));
    expect(out.retired).toEqual([stuck]);
    s.close?.();
  });

  test("a prune plans around a building crawl that is still live", async () => {
    const s = await open();
    const building = await crawl(s, 1_000, ["https://e.test/a"], "building");
    buildingSince(building, HOUR);
    await crawl(s, 2_000, ["https://e.test/a"]);
    expect((await run(s.listLiveBuildingReports())).map((c) => c.id)).toEqual([building]);
    s.close?.();
  });

  test("the listing is bounded by the audits: its plan scans crawls and probes the per-crawl indexes", async () => {
    const s = await open();
    await crawl(s, 1_000, ["https://e.test/a"], "building");
    s.close?.();
    const sql = (SQLiteStorage as unknown as { interruptedReportSql(now: number): string }).interruptedReportSql(
      Date.now()
    );
    const db = new Database(dbPath, { readonly: true });
    try {
      const plan = (
        db.query(`EXPLAIN QUERY PLAN SELECT id, started_at FROM crawls WHERE ${sql}`).all() as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan).not.toMatch(/SCAN (pages|frontier)\b/);
      expect(plan).toMatch(/pages/);
    } finally {
      db.close();
    }
  });
});
