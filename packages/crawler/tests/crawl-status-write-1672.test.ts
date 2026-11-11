// The guarded synchronous status write the Ctrl-C handler uses (#1672) obeys the same transition table
// as `SQLiteStorage.updateCrawl` (same predicate, same bound list): for every (from, to) pair, the write
// changes the row exactly when the table lists the move. updateCrawl's own edges are in
// status-transitions-1659.test.ts.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CRAWL_STATUS_TRANSITIONS, canTransitionCrawl } from "@squirrelscan/core-contracts";

import { crawlStatusAllowedFrom, writeCrawlStatusGuarded } from "../src/storage";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { CrawlMetadata, CrawlStatus } from "../src/storage/types";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);
const STATS = { pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0 };
const STATUSES = Object.keys(CRAWL_STATUS_TRANSITIONS) as CrawlStatus[];

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-status-write-1672-"));
  dbPath = join(dir, "project.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seedAt(from: CrawlStatus): Promise<string> {
  const s = new SQLiteStorage(dbPath);
  await run(s.init());
  const id = await run(
    s.createCrawl({ baseUrl: "https://e.test", startedAt: 1, status: "running", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">),
  );
  await run(s.close());
  // Put the row at `from` directly: this test is about the write, not about reaching a status.
  const db = new Database(dbPath);
  db.prepare("UPDATE crawls SET status = ? WHERE id = ?").run(from, id);
  db.close();
  return id;
}

const statusOf = (id: string): string => {
  const db = new Database(dbPath);
  try {
    return (db.prepare("SELECT status FROM crawls WHERE id = ?").get(id) as { status: string }).status;
  } finally {
    db.close();
  }
};

describe("writeCrawlStatusGuarded", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = canTransitionCrawl(from, to);
      test(`${from} -> ${to} is ${legal ? "written" : "refused"}`, async () => {
        const id = await seedAt(from);
        const db = new Database(dbPath);
        try {
          expect(writeCrawlStatusGuarded(db, id, to)).toBe(legal ? 1 : 0);
        } finally {
          db.close();
        }
        expect(statusOf(id)).toBe(legal ? to : from);
      });
    }
  }

  test("a missing crawl changes nothing", async () => {
    await seedAt("running");
    const db = new Database(dbPath);
    try {
      expect(writeCrawlStatusGuarded(db, "nope", "stopped")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("the bound list is the table's own", () => {
    for (const to of STATUSES) {
      expect(crawlStatusAllowedFrom(to)).toBe(`,${CRAWL_STATUS_TRANSITIONS[to].join(",")},`);
    }
  });
});
