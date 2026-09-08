// Migration 26 adds `idx_pages_url_recency` on pages(normalized_url, fetched_at).
//
// Two readers look up a page by normalized_url ALONE, and the primary key
// (crawl_id, normalized_url) cannot serve either: `getCachedPage`, once per url
// on every incremental re-audit, and the correlated "is there a newer row for
// this url" inside the retire delete, once per candidate row.
//
// The second is why this is not a nice-to-have. Automatic retention (#1912)
// runs after EVERY successful audit, and a correlated full scan is quadratic in
// the size of the pages table: measured at 4,000 / 10,000 / 40,000 rows the
// delete took 80 ms / 493 ms / 11,779 ms without the index and 9.5 ms / 29 ms /
// 61 ms with it. That is criterion 5 of the issue — the retention pass must not
// reintroduce a per-audit full scan.
//
// So the assertion here is the QUERY PLAN, not the timing: a timing test on a
// loaded machine proves nothing, and the index existing proves nothing either
// if the planner does not pick it.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlMetadata, PageRecord } from "@squirrelscan/core-contracts/storage";

import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

// The superseded-pages predicate, as the retire delete uses it. Duplicated
// here on purpose — it is private — and pinned to the implementation by the
// "removes exactly these rows" test below, so a change to one that is not made
// to the other fails rather than silently making this a test of nothing.
const SUPERSEDED = `
  SELECT p.rowid FROM pages p
  WHERE p.crawl_id IN (?)
    AND EXISTS (
      SELECT 1 FROM pages newer
      WHERE newer.normalized_url = p.normalized_url
        AND (newer.fetched_at, newer.rowid) > (p.fetched_at, p.rowid)
    )
`;

/**
 * The `OR` spelling the row value replaced. Kept so the equivalence is asserted
 * rather than argued: the two must select the same rows, ties included, or the
 * rewrite silently changed which page rows a retirement deletes.
 */
const SUPERSEDED_OR = `
  SELECT p.rowid FROM pages p
  WHERE p.crawl_id IN (?)
    AND EXISTS (
      SELECT 1 FROM pages newer
      WHERE newer.normalized_url = p.normalized_url
        AND (
          newer.fetched_at > p.fetched_at
          OR (newer.fetched_at = p.fetched_at AND newer.rowid > p.rowid)
        )
    )
`;

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

let dir: string;
let dbPath: string;

function page(url: string, fetchedAt: number, etag: string): PageRecord {
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

async function crawlWith(
  store: SQLiteStorage,
  index: number,
  urls: string[]
): Promise<string> {
  const id = await run(
    store.createCrawl({
      baseUrl: "https://e.test",
      startedAt: 1_000 + index,
      status: "analyzed",
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
  for (const url of urls) {
    await run(store.upsertPage(id, page(url, 1_000 + index, `v${index}`)));
  }
  return id;
}

function planFor(sql: string, ...params: unknown[]): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>;
    return rows.map((r) => r.detail).join("\n");
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-url-index-"));
  dbPath = join(dir, "project.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("idx_pages_url_recency (#1912)", () => {
  test("the superseded-pages predicate seeks, it does not scan the table per row", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const first = await crawlWith(store, 0, ["https://e.test/a", "https://e.test/b"]);
    await crawlWith(store, 1, ["https://e.test/a", "https://e.test/b"]);
    store.close?.();

    const plan = planFor(SUPERSEDED, first);
    expect(plan).toContain("idx_pages_url_recency");
    // The failure mode this exists to stop: a correlated subquery re-reading
    // the whole pages table once per candidate row.
    expect(plan).not.toContain("SCAN newer");
    // And it must SEEK on recency, not just on the url. Seeking only the url
    // walks every version of that url per candidate row, which is the same
    // shape of defect one level down — it costs nothing on a site audited a few
    // times and is quadratic when retention is first switched on over a
    // backlog.
    expect(plan).toContain("fetched_at>?");
  });

  test("the row-value recency test selects the same rows as the OR it replaced", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    // Ties are the whole point: three crawls of one url at the SAME
    // fetched_at, one url a later crawl saw at an EARLIER time, and one url
    // only a single crawl ever saw.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await crawlWith(store, 0, []));
    for (const id of ids) {
      await run(store.upsertPage(id, page("https://e.test/tied", 5_000, id)));
    }
    await run(store.upsertPage(ids[0]!, page("https://e.test/back", 5_000, "a")));
    await run(store.upsertPage(ids[1]!, page("https://e.test/back", 4_000, "b")));
    await run(store.upsertPage(ids[2]!, page("https://e.test/only", 5_000, "c")));
    store.close?.();

    const db = new Database(dbPath, { readonly: true });
    try {
      for (const id of ids) {
        const rows = (sql: string) =>
          (db.prepare(sql).all(id) as Array<{ rowid: number }>)
            .map((r) => r.rowid)
            .sort((a, b) => a - b);
        expect(rows(SUPERSEDED)).toEqual(rows(SUPERSEDED_OR));
      }
    } finally {
      db.close();
    }
  });

  test("the predicate above removes exactly the rows retireCrawls removes", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const urls = ["https://e.test/a", "https://e.test/b", "https://e.test/c"];
    const first = await crawlWith(store, 0, [...urls, "https://e.test/only-old"]);
    await crawlWith(store, 1, urls);

    // What the duplicated predicate says should go.
    const db = new Database(dbPath);
    const expected = (db.prepare(SUPERSEDED).all(first) as Array<{ rowid: number }>)
      .length;
    db.close();
    // A url no later crawl saw is still the freshest record of it, so it stays:
    // 3 superseded, not 4.
    expect(expected).toBe(3);

    const before = await run(store.getPageCount(first));
    await run(store.retireCrawls([first]));
    const after = await run(store.getPageCount(first));
    expect(before - after).toBe(expected);
    store.close?.();
  });

  test("getCachedPage seeks by url too — the read on every incremental re-audit", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    await crawlWith(store, 0, ["https://e.test/a"]);
    store.close?.();

    const plan = planFor(
      "SELECT * FROM pages WHERE normalized_url = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1",
      "https://e.test/a"
    );
    expect(plan).toContain("idx_pages_url_recency");
    expect(plan).not.toContain("SCAN pages");
  });

  test("the index does not change which row a tie resolves to", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    // Same url, same fetched_at, two crawls. An index can reorder ties, so the
    // reader's explicit rowid tie-break has to be what decides it.
    const older = await crawlWith(store, 0, ["https://e.test/a"]);
    await run(
      store.upsertPage(older, page("https://e.test/a", 5_000, "older"))
    );
    const newer = await crawlWith(store, 0, []);
    await run(
      store.upsertPage(newer, page("https://e.test/a", 5_000, "newer"))
    );

    const cached = await run(store.getCachedPage("https://e.test/a"));
    expect(cached?.etag).toBe("newer");
    store.close?.();
  });

  test("the retired-page sweep seeks by crawl, it does not read every page row", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    const first = await crawlWith(store, 0, ["https://e.test/a"]);
    await crawlWith(store, 1, ["https://e.test/a"]);
    await run(store.retireCrawls([first]));
    store.close?.();

    // The shape this has to keep. Written as a join, SQLite drives the whole
    // thing from `pages` and reads every row in the table — live crawls
    // included — after every audit. Driven by a list of retired crawl ids
    // instead, it costs one probe per audit the project has ever retired,
    // forever. Driven by THIS crawl's urls it is bounded by the audit.
    const plan = planFor(
      `
      SELECT p.rowid FROM pages p
      WHERE p.normalized_url IN (
        SELECT normalized_url FROM pages WHERE crawl_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM pages newer
        WHERE newer.normalized_url = p.normalized_url
          AND (newer.fetched_at, newer.rowid) > (p.fetched_at, p.rowid)
      )
      AND (SELECT retired_at FROM crawls c WHERE c.id = p.crawl_id) IS NOT NULL
    `,
      first
    );
    expect(plan).toContain("idx_pages_url_recency");
    // Nothing here may read a whole table.
    expect(plan).not.toContain("SCAN p");
    expect(plan).not.toContain("SCAN pages");
    expect(plan).not.toContain("SCAN crawls");
  });

  test("collectSupersededPages takes only rows a newer one supersedes", async () => {
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    // A url only the first crawl saw: kept when that crawl is retired, because
    // it is still the freshest record of it.
    const first = await crawlWith(store, 0, [
      "https://e.test/a",
      "https://e.test/only",
    ]);
    await crawlWith(store, 1, ["https://e.test/a"]);
    await run(store.retireCrawls([first]));
    expect(await run(store.getPageCount(first))).toBe(1);
    // Nothing has superseded it yet, so a sweep must not take it.
    const second = await crawlWith(store, 1, ["https://e.test/a"]);
    expect(await run(store.collectSupersededPages(second))).toBe(0);
    expect(
      (await run(store.getCachedPage("https://e.test/only")))?.etag
    ).toBeDefined();

    // A later crawl sees it again: now the kept row is dead and the sweep is
    // the only thing that will ever look at it.
    const third = await crawlWith(store, 2, ["https://e.test/only"]);
    expect(await run(store.collectSupersededPages(third))).toBe(1);
    expect(await run(store.getPageCount(first))).toBe(0);
    expect(await run(store.getPageCount(third))).toBe(1);
    store.close?.();
  });

  test("a database written before migration 25 still opens", async () => {
    // A real database of the previous generation: everything migrations 1-24
    // built, and no `retired_at`. Made by taking a current one back rather than
    // hand-writing the table, so it has the other twenty-odd ALTER-added
    // columns a hand-written one would silently lack.
    const seed = new SQLiteStorage(dbPath);
    await run(seed.init());
    seed.close?.();
    const raw = new Database(dbPath);
    // The index has to go first: SQLite refuses to drop a column an index
    // names, which is itself a check that the index was created.
    raw.exec("DROP INDEX idx_crawls_retired");
    raw.exec("DROP INDEX idx_crawls_retention");
    raw.exec("ALTER TABLE crawls DROP COLUMN retired_at");
    raw.exec("DELETE FROM schema_version");
    raw.prepare("INSERT INTO schema_version (version) VALUES (24)").run();
    raw.close();

    // A CREATE INDEX naming that column from the SCHEMA string would throw
    // here, on every open, before the migration that adds it back could run.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    // Opened, migrated, and the column is there on the WRITE side, which is the
    // half that fails loudly when it is not.
    const id = await crawlWith(store, 0, []);
    await run(store.retireCrawls([id]));
    expect((await run(store.getCrawl(id)))?.retiredAt).toBeGreaterThan(0);
    store.close?.();
  });

  test("a database written before migration 26 gains the index when it is opened", async () => {
    // Build a project, then take it back to the v25 shape: index dropped,
    // version stamped at 25. That is exactly what an existing user's
    // project.db looks like.
    const store = new SQLiteStorage(dbPath);
    await run(store.init());
    await crawlWith(store, 0, ["https://e.test/a"]);
    store.close?.();

    const raw = new Database(dbPath);
    raw.exec("DROP INDEX IF EXISTS idx_pages_url_recency");
    raw.exec("DELETE FROM schema_version");
    raw.prepare("INSERT INTO schema_version (version) VALUES (25)").run();
    const stale = planFor(
      "SELECT * FROM pages WHERE normalized_url = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1",
      "https://e.test/a"
    );
    raw.close();
    // Precondition: without the index this really is a scan, so the assertion
    // below is about the migration rather than about the planner's mood.
    expect(stale).toContain("SCAN pages");

    const reopened = new SQLiteStorage(dbPath);
    await run(reopened.init());
    reopened.close?.();

    expect(
      planFor(
        "SELECT * FROM pages WHERE normalized_url = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1",
        "https://e.test/a"
      )
    ).toContain("idx_pages_url_recency");
  });
});
