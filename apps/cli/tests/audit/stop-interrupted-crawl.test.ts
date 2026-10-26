// #941: Ctrl-C records the crawl as `stopped`, the state `--resume` continues.
// Runs in a signal handler, so it must be best-effort and scoped to crawls this
// process started.

import { startCrawlLease } from "@squirrelscan/crawler";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlMetadata } from "@/crawler/storage/types";

import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  registerOwnedCrawl,
  stopInterruptedCrawls,
} from "../../src/audit/stop-interrupted-crawl";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-stop-"));
  dbPath = join(dir, "project.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seed(): Promise<{ mine: string; other: string; done: string }> {
  const store = new SQLiteStorage(dbPath);
  await run(store.init());
  const make = (startedAt: number, status: CrawlMetadata["status"]) =>
    run(
      store.createCrawl({
        baseUrl: "https://e.test",
        startedAt,
        status,
        config: {} as CrawlMetadata["config"],
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
      } as Omit<CrawlMetadata, "id">)
    );
  const other = await make(1_000, "running");
  const done = await make(2_000, "analyzed");
  const mine = await make(5_000, "running");
  await run(store.close());
  return { mine, other, done };
}

const statusOf = (id: string): string => {
  const db = new Database(dbPath);
  try {
    return (
      db.prepare("SELECT status FROM crawls WHERE id = ?").get(id) as {
        status: string;
      }
    ).status;
  } finally {
    db.close();
  }
};

describe("stopInterruptedCrawls", () => {
  test("marks only the crawl this process owns, by id", async () => {
    const { mine, other, done } = await seed();
    registerOwnedCrawl(() => mine);
    expect(stopInterruptedCrawls(dbPath)).toBe(1);
    expect(statusOf(mine)).toBe("stopped");
    expect(statusOf(other)).toBe("running");
    expect(statusOf(done)).toBe("analyzed");
    // Already stopped: a second signal changes nothing.
    expect(stopInterruptedCrawls(dbPath)).toBe(0);
  });

  test("drops this process's crawl lease, and only this process's (#946)", async () => {
    const { mine } = await seed();
    const set = (pid: number) => {
      const db = new Database(dbPath);
      db.prepare(
        "UPDATE crawls SET owner_pid = ?, owner_host = 'h', heartbeat_at = 9 WHERE id = ?"
      ).run(pid, mine);
      db.close();
    };
    const ownerOf = () => {
      const db = new Database(dbPath);
      const row = db
        .prepare("SELECT owner_pid, heartbeat_at FROM crawls WHERE id = ?")
        .get(mine) as { owner_pid: number | null; heartbeat_at: number };
      db.close();
      return row;
    };
    registerOwnedCrawl(() => mine);

    set(process.pid + 1);
    stopInterruptedCrawls(dbPath);
    expect(ownerOf().owner_pid).toBe(process.pid + 1);

    set(process.pid);
    stopInterruptedCrawls(dbPath);
    expect(ownerOf()).toEqual({ owner_pid: null, heartbeat_at: 9 });
  });

  test("a live heartbeat cannot re-assert the lease after the signal path (#946)", async () => {
    const { mine } = await seed();
    const lease = startCrawlLease({
      dbPath,
      getCrawlId: () => mine,
      heartbeatMs: 10,
    });
    registerOwnedCrawl(() => mine);
    stopInterruptedCrawls(dbPath);
    await Bun.sleep(80);
    expect(lease.beat()).toBe(false);
    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT owner_pid FROM crawls WHERE id = ?")
      .get(mine) as { owner_pid: number | null };
    db.close();
    expect(row.owner_pid).toBeNull();
  });

  test("no owned crawl yet (still before the crawl started) is a no-op", async () => {
    await seed();
    registerOwnedCrawl(() => null);
    expect(stopInterruptedCrawls(dbPath)).toBe(0);
  });

  test("never throws: a missing or unreadable database is a no-op", () => {
    registerOwnedCrawl(() => "x");
    expect(stopInterruptedCrawls(join(dir, "nope.db"))).toBe(0);
    writeFileSync(dbPath, "not a database".repeat(50));
    expect(stopInterruptedCrawls(dbPath)).toBe(0);
  });
});
