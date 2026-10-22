// #946 PR2: retirement USES the crawl lease. This is the code that deletes
// crawls, so every way it could delete a live one has a case here: the pure
// verdict (isCrawlAbandoned) as a matrix, then the storage listings and the
// in-transaction re-check on real rows.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";

import type { CrawlMetadata } from "../src/storage/types";
import {
  isCrawlAbandoned,
  isReadablePid,
  type LeaseCrawlRow,
  type LeaseEnv,
} from "../src/storage/crawl-liveness";
import { startCrawlLease } from "../src/storage/crawl-lease";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  CRAWL_LEASE_PID_TRUST_MS as DAY,
  CRAWL_LEASE_STALE_MS as STALE,
} from "../src/storage/types";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function env(over: Partial<LeaseEnv> = {}): LeaseEnv {
  return {
    now: () => NOW,
    hostname: () => "me",
    pidAlive: () => {
      throw new Error("pid probe was not expected");
    },
    ...over,
  };
}

function row(over: Partial<LeaseCrawlRow> = {}): LeaseCrawlRow {
  return {
    status: "crawled",
    heartbeat_at: NOW - 10 * MIN,
    owner_pid: 100,
    owner_host: "me",
    legacy_abandoned: 0,
    ...over,
  };
}

describe("isCrawlAbandoned: no usable lease keeps the #945 rule", () => {
  for (const legacy of [0, 1]) {
    const lease = { heartbeat_at: null, owner_pid: null, owner_host: null };
    test(`NULL lease (written by an older CLI), legacy=${legacy}`, () => {
      expect(isCrawlAbandoned(row({ ...lease, legacy_abandoned: legacy }), env())).toBe(
        legacy === 1
      );
    });
    test(`released lease (owner cleared, heartbeat kept), legacy=${legacy}`, () => {
      expect(
        isCrawlAbandoned(
          row({ owner_pid: null, owner_host: null, legacy_abandoned: legacy }),
          env()
        )
      ).toBe(legacy === 1);
    });
    test(`unreadable heartbeat (text), legacy=${legacy}`, () => {
      expect(
        isCrawlAbandoned(row({ heartbeat_at: "soon", legacy_abandoned: legacy }), env())
      ).toBe(legacy === 1);
    });
    test(`heartbeat more than a day in the future, legacy=${legacy}`, () => {
      expect(
        isCrawlAbandoned(
          row({ heartbeat_at: NOW + DAY + MIN, legacy_abandoned: legacy }),
          env()
        )
      ).toBe(legacy === 1);
    });
  }
});

describe("isCrawlAbandoned: a live lease is never abandoned", () => {
  test("fresh heartbeat beats the legacy rule (a later audit finished first)", () => {
    expect(
      isCrawlAbandoned(
        row({ heartbeat_at: NOW - (STALE - 1), legacy_abandoned: 1, status: "running" }),
        env()
      )
    ).toBe(false);
  });
  test("negative age (clock stepped back, heartbeat in the near future) is fresh", () => {
    expect(
      isCrawlAbandoned(
        row({ heartbeat_at: NOW + 3_600_000, legacy_abandoned: 1 }),
        env()
      )
    ).toBe(false);
  });
  test("stale heartbeat, same host, pid alive, under 24 h: live", () => {
    expect(
      isCrawlAbandoned(
        row({ heartbeat_at: NOW - 3_600_000, legacy_abandoned: 1 }),
        env({ pidAlive: (p) => p === 100 })
      )
    ).toBe(false);
  });
  test("pid alive is trusted for at most 24 h (pid reuse bound)", () => {
    expect(
      isCrawlAbandoned(
        row({ heartbeat_at: NOW - DAY - MIN }),
        env({ pidAlive: () => true })
      )
    ).toBe(true);
  });
  test("a different host is never pid-probed and is live until the stale window", () => {
    const probe = env({
      pidAlive: () => {
        throw new Error("must not probe a foreign pid");
      },
    });
    const other = { owner_host: "elsewhere", legacy_abandoned: 1 };
    expect(isCrawlAbandoned(row({ ...other, heartbeat_at: NOW - (STALE - MIN) }), probe)).toBe(
      false
    );
    expect(isCrawlAbandoned(row({ ...other, heartbeat_at: NOW - (STALE + MIN) }), probe)).toBe(
      true
    );
  });
  test("an unreadable owner (no pid, host only) is live until the stale window, never probed", () => {
    for (const bad of [null, 0, -1, 1.5, "12"]) {
      const r = (age: number) => row({ owner_pid: bad, heartbeat_at: NOW - age });
      expect(isCrawlAbandoned(r(STALE - MIN), env())).toBe(false);
      expect(isCrawlAbandoned(r(STALE + MIN), env())).toBe(true);
    }
    expect(isReadablePid(0)).toBe(false);
    expect(isReadablePid(-5)).toBe(false);
    expect(isReadablePid(4242)).toBe(true);
  });
});

describe("isCrawlAbandoned: a dead lease", () => {
  const dead = env({ pidAlive: () => false });
  test("a killed `crawled` crawl is abandoned once stale, with no newer audit", () => {
    expect(
      isCrawlAbandoned(row({ status: "crawled", heartbeat_at: NOW - (STALE + MIN) }), dead)
    ).toBe(true);
  });
  // stopped / paused / failed are resumable: a dead or unreleased lease must
  // never retire them sooner than #945 (7 days), whoever the owner looks like.
  for (const status of ["stopped", "paused", "failed"]) {
    const owners: Array<[string, Partial<LeaseCrawlRow>, LeaseEnv]> = [
      ["dead same-host pid", {}, dead],
      ["other host", { owner_host: "elsewhere" }, env()],
      ["null owner pid", { owner_pid: null }, env()],
    ];
    for (const [label, over, e] of owners) {
      test(`${status}, 6 min stale, ${label}: the #945 verdict decides`, () => {
        const r = (legacy: number) =>
          row({ status, heartbeat_at: NOW - 6 * MIN, legacy_abandoned: legacy, ...over });
        expect(isCrawlAbandoned(r(0), e)).toBe(false);
        expect(isCrawlAbandoned(r(1), e)).toBe(true);
      });
    }
  }
  test("a killed RUNNING crawl (what --resume continues) waits 24 h", () => {
    const r = (age: number, legacy = 0) =>
      row({ status: "running", heartbeat_at: NOW - age, legacy_abandoned: legacy });
    expect(isCrawlAbandoned(r(23 * 60 * MIN), dead)).toBe(false);
    expect(isCrawlAbandoned(r(DAY), dead)).toBe(true);
    // never kept longer than #945 would have kept it
    expect(isCrawlAbandoned(r(10 * MIN, 1), dead)).toBe(true);
  });
});

// ---- storage level ---------------------------------------------------------

const paths: string[] = [];
function tempDbPath(): string {
  const p = join(tmpdir(), `sq-liveness-${randomUUID()}.db`);
  paths.push(p);
  return p;
}
afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        /* gone */
      }
    }
  }
});

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

async function openStore(
  clock: { t: number },
  alive: Set<number>
): Promise<{ s: SQLiteStorage; path: string }> {
  const path = tempDbPath();
  const s = new SQLiteStorage(path);
  await run(s.init());
  s.leaseEnv = {
    now: () => clock.t,
    hostname: () => "me",
    pidAlive: (p) => alive.has(p),
  };
  return { s, path };
}

async function mk(
  s: SQLiteStorage,
  startedAt: number,
  status: CrawlMetadata["status"]
): Promise<string> {
  return run(
    s.createCrawl({
      baseUrl: "https://e.test",
      startedAt,
      status,
      config: {} as CrawlMetadata["config"],
      stats: STATS,
    } as Omit<CrawlMetadata, "id">)
  );
}

function setLease(
  path: string,
  id: string,
  pid: number | null,
  host: string | null,
  hb: number | null
): void {
  const db = new Database(path);
  db.query(
    "UPDATE crawls SET owner_pid = ?, owner_host = ?, heartbeat_at = ? WHERE id = ?"
  ).run(pid, host, hb, id);
  db.close();
}

const HOUR = 3_600_000;

describe("retirement reads the lease", () => {
  test("overlapping audits: the later one finishes first, the earlier running crawl survives", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set([100]));
    // A: started 2 h ago, idle for 2 h by the #945 yardstick, but its process
    // beats. B: newer, finished. #945 alone would retire A.
    const a = await mk(s, NOW - 2 * HOUR, "running");
    const b = await mk(s, NOW - HOUR, "completed");
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([a]);

    setLease(path, a, 100, "me", NOW - 10_000);
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    expect((await run(s.listPossiblyLiveCrawls())).map((c) => c.id)).toEqual([a]);

    const result = await run(s.retireCrawlsDetailed([a], NOW, { allowAbandoned: true }));
    expect(result.retired).toEqual([]);
    expect(result.skipped).toEqual([a]);
    expect((await run(s.getCrawl(a)))?.retiredAt).toBeUndefined();
    expect(b).toBeTruthy();
    await run(s.close());
  });

  test("a killed newest crawl is retired with no newer finished audit; a live one never", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set());
    const old = await mk(s, NOW - 3 * HOUR, "analyzed");
    const killed = await mk(s, NOW - 2 * HOUR, "crawled");
    setLease(path, killed, 555, "me", NOW - 10 * MIN); // pid 555 is not alive

    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([killed]);
    const out = await run(s.retireCrawlsDetailed([killed], NOW, { allowAbandoned: true }));
    expect(out.retired).toEqual([killed]);
    expect((await run(s.getCrawl(killed)))?.retiredAt).toBe(NOW);
    expect((await run(s.getCrawl(old)))?.retiredAt).toBeUndefined();
    await run(s.close());
  });

  test("a killed RUNNING newest crawl waits 24 h of silence", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set());
    const id = await mk(s, NOW - 30 * HOUR, "running");
    setLease(path, id, 555, "me", NOW - 23 * HOUR);
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    clock.t = NOW + 2 * HOUR; // 25 h since the last beat
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([id]);
    await run(s.close());
  });

  test("re-checked inside the transaction: a beat that lands after the listing saves the crawl", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set());
    const id = await mk(s, NOW - 2 * HOUR, "crawled");
    setLease(path, id, 555, "me", NOW - 10 * MIN);
    const listed = await run(s.listAbandonedCrawls());
    expect(listed.map((c) => c.id)).toEqual([id]);

    setLease(path, id, 555, "me", NOW - 1_000); // another process beats now
    const out = await run(s.retireCrawlsDetailed([id], NOW, { allowAbandoned: true }));
    expect(out).toMatchObject({ retired: [], skipped: [id] });
    expect((await run(s.getCrawl(id)))?.retiredAt).toBeUndefined();
    await run(s.close());
  });

  test("a resumed crawl that re-took the lease is no longer abandoned", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set([777]));
    const id = await mk(s, NOW - 2 * HOUR, "crawled");
    setLease(path, id, 555, "me", NOW - 10 * MIN);
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([id]);
    setLease(path, id, 777, "me", NOW); // --resume took it over
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    await run(s.close());
  });

  test("another host's crawl, and one with an unreadable owner, are kept until the stale window", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set());
    const foreign = await mk(s, NOW - 2 * HOUR, "crawled");
    const garbled = await mk(s, NOW - 2 * HOUR, "crawled");
    const done = await mk(s, NOW - HOUR, "completed");
    setLease(path, foreign, 5, "elsewhere", NOW - 4 * MIN);
    setLease(path, garbled, null, "me", NOW - 4 * MIN);
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    clock.t = NOW + 2 * MIN; // 6 min since the beat: stale
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id).sort()).toEqual(
      [foreign, garbled].sort()
    );
    expect(done).toBeTruthy();
    await run(s.close());
  });

  test("NULL-lease crawls keep the #945 rule exactly", async () => {
    const clock = { t: NOW };
    const { s } = await openStore(clock, new Set());
    const old = await mk(s, NOW - 2 * HOUR, "running");
    await mk(s, NOW - HOUR, "completed");
    const newest = await mk(s, NOW - 20 * MIN, "crawled");
    expect((await run(s.listAbandonedCrawls())).map((c) => c.id)).toEqual([old]);
    expect((await run(s.listPossiblyLiveCrawls())).map((c) => c.id)).toEqual([newest]);
    await run(s.close());
  });

  test("a clock step backwards never makes a lease look dead", async () => {
    const clock = { t: NOW };
    const { s, path } = await openStore(clock, new Set());
    const id = await mk(s, NOW - 2 * HOUR, "crawled");
    await mk(s, NOW - HOUR, "completed");
    setLease(path, id, 555, "me", NOW);
    clock.t = NOW - 6 * HOUR;
    expect(await run(s.listAbandonedCrawls())).toEqual([]);
    await run(s.close());
  });
});

describe("retire transaction", () => {
  test("a heartbeat committing mid-retire cannot fail it with SQLITE_BUSY_SNAPSHOT: the write lock is taken first", async () => {
    const path = tempDbPath();
    const s = new SQLiteStorage(path);
    await run(s.init());
    const id = await mk(s, NOW - 2 * HOUR, "crawled");
    await mk(s, NOW - HOUR, "completed");
    setLease(path, id, 555, "me", NOW - 10 * MIN);
    let beatBlocked = false;
    s.leaseEnv = {
      now: () => NOW,
      hostname: () => "me",
      // Runs inside the retire transaction: try to commit a heartbeat from
      // another connection right now, without waiting.
      pidAlive: () => {
        const other = new Database(path);
        try {
          other.exec("PRAGMA busy_timeout = 0");
          other.query("UPDATE crawls SET heartbeat_at = ? WHERE id = ?").run(NOW, id);
        } catch {
          beatBlocked = true;
        } finally {
          other.close();
        }
        return false;
      },
    };
    const out = await run(s.retireCrawlsDetailed([id], NOW, { allowAbandoned: true }));
    expect(beatBlocked).toBe(true);
    expect(out.retired).toEqual([id]);
    await run(s.close());
  });
});

describe("a resume takes over a killed owner's lease at once", () => {
  test("same-host dead pid: the next beat claims it without waiting out the stale window", async () => {
    const path = tempDbPath();
    const s = new SQLiteStorage(path);
    await run(s.init());
    const id = await mk(s, Date.now(), "running");
    const child = Bun.spawn(["true"]);
    await child.exited;
    const { hostname } = await import("node:os");
    setLease(path, id, child.pid, hostname(), Date.now()); // fresh beat from a dead process

    const lease = startCrawlLease({ dbPath: path, getCrawlId: () => id });
    const db = new Database(path, { readonly: true });
    const owner = db.query("SELECT owner_pid FROM crawls WHERE id = ?").get(id) as {
      owner_pid: number;
    };
    db.close();
    expect(owner.owner_pid).toBe(process.pid);
    lease.release();
    await run(s.close());
  });

  test("a live foreign pid is not taken over", async () => {
    const path = tempDbPath();
    const s = new SQLiteStorage(path);
    await run(s.init());
    const id = await mk(s, Date.now(), "running");
    const { hostname } = await import("node:os");
    setLease(path, id, process.ppid, hostname(), Date.now());
    const lease = startCrawlLease({ dbPath: path, getCrawlId: () => id });
    expect(lease.beat()).toBe(false);
    lease.release();
    await run(s.close());
  });
});
