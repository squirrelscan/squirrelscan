// Crawl lease writer (#946).
//
// The process driving a crawl records its pid, host and a heartbeat on the
// `crawls` row, so liveness is written down rather than inferred from newer
// audits. This module only WRITES the lease; nothing reads it yet.
//
// The beat runs on its OWN connection with a 1 s busy timeout. The crawl
// writer's connection waits up to 15 s on a lock; a beat sharing that wait would
// stall the event loop behind a long foreign write. On SQLITE_BUSY the beat is
// skipped and the next one (15 s later) retries, against a 5 min stale window.
// The timer is unref'd so it never keeps the process alive.

import { Database } from "bun:sqlite";
import { hostname } from "node:os";

import { isPidAlive } from "./crawl-liveness";
import {
  CRAWL_LEASE_BUSY_TIMEOUT_MS,
  CRAWL_LEASE_HEARTBEAT_MS,
  CRAWL_LEASE_STALE_MS,
} from "./types";

export interface CrawlLeaseOptions {
  /** The project database file. `:memory:` and a missing file yield a no-op. */
  readonly dbPath: string;
  /** The crawl this process drives; null until the crawl row exists. */
  readonly getCrawlId: () => string | null;
  readonly heartbeatMs?: number;
  readonly pid?: number;
  readonly host?: string;
  readonly now?: () => number;
}

export interface CrawlLease {
  /** One beat now. True when written, false when skipped (no id, busy, error). */
  readonly beat: () => boolean;
  /** Stop beating and clear the owner. Idempotent; never throws. */
  readonly release: () => void;
}

const NOOP_LEASE: CrawlLease = { beat: () => false, release: () => {} };

/** Leases this process holds, so a signal handler can release them (see releaseActiveLeases). */
const activeLeases = new Set<CrawlLease>();

/**
 * Release every lease this process holds: stops the timers (so no beat can
 * re-assert a lease the signal path is clearing) and clears the owners. For the
 * signal handler, which runs while the heartbeat timers are still live.
 */
export function releaseActiveLeases(): void {
  for (const lease of [...activeLeases]) lease.release();
}

/** How often to poll for the crawl id while there is none yet (the row is created after the lease starts). */
const FIRST_BEAT_POLL_MS = 1000;

export function startCrawlLease(options: CrawlLeaseOptions): CrawlLease {
  if (!options.dbPath || options.dbPath === ":memory:") return NOOP_LEASE;
  const pid = options.pid ?? process.pid;
  const heartbeatMs = options.heartbeatMs ?? CRAWL_LEASE_HEARTBEAT_MS;
  const now = options.now ?? Date.now;

  let host: string;
  try {
    host = options.host ?? hostname();
  } catch {
    host = "unknown";
  }

  let db: Database | null = null;
  try {
    // Never create a database from the lease: a missing file is a no-op.
    db = new Database(options.dbPath, { readwrite: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${CRAWL_LEASE_BUSY_TIMEOUT_MS}`);
  } catch {
    try {
      db?.close();
    } catch {
      // nothing to do
    }
    return NOOP_LEASE;
  }

  const held = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  // Fast polling only while there is no crawl id; once it exists the cadence is
  // the heartbeat, also after a busy skip.
  let haveId = false;

  const beat = (): boolean => {
    if (released || !db) return false;
    const id = options.getCrawlId();
    if (!id) return false;
    haveId = true;
    try {
      // Compare-and-set: take the lease when it is free, ours, or stale, so two
      // processes on one crawl do not steal it from each other every beat, while
      // a resume still takes over a killed owner's lease. A stale sweep heals too.
      // PR 2 must design what a LIVE foreign owner means (the writer just yields).
      const t = now();
      const result = db
        .prepare(
          `UPDATE crawls SET owner_pid = ?, owner_host = ?, heartbeat_at = ?
           WHERE id = ? AND ((owner_pid IS NULL AND owner_host IS NULL) OR (owner_pid = ? AND owner_host = ?)
             OR heartbeat_at IS NULL OR heartbeat_at < ?)`
        )
        .run(pid, host, t, id, pid, host, t - CRAWL_LEASE_STALE_MS);
      if (Number(result.changes ?? 0) > 0) {
        held.add(id);
        return true;
      }
      return takeOverDeadOwner(id);
    } catch {
      // SQLITE_BUSY past the 1 s timeout, or a DB without the columns: skip.
      return false;
    }
  };

  // A resume right after a kill -9: the dead owner's heartbeat is still fresh,
  // so the CAS above yields. A same-host owner whose pid is gone is dead for
  // certain, so take over at once (CAS on the pid we just read). Caveat: the
  // pid probe only sees this machine's pid namespace, so two containers sharing
  // a host name and a database file cannot see each other's pids and would read
  // a live owner as dead. Not a supported setup (SQLite WAL needs one kernel);
  // the retirement side is bounded by the same 24 h cap.
  const takeOverDeadOwner = (id: string): boolean => {
    if (!db) return false;
    const owner = db
      .prepare("SELECT owner_pid, owner_host FROM crawls WHERE id = ?")
      .get(id) as { owner_pid: unknown; owner_host: unknown } | null;
    if (
      !owner ||
      owner.owner_host !== host ||
      typeof owner.owner_pid !== "number" ||
      owner.owner_pid === pid ||
      isPidAlive(owner.owner_pid)
    ) {
      return false;
    }
    const taken = db
      .prepare(
        "UPDATE crawls SET owner_pid = ?, owner_host = ?, heartbeat_at = ? WHERE id = ? AND owner_pid = ? AND owner_host = ?"
      )
      .run(pid, host, now(), id, owner.owner_pid, host);
    if (Number(taken.changes ?? 0) > 0) {
      held.add(id);
      return true;
    }
    return false;
  };

  const schedule = (): void => {
    timer = setTimeout(
      () => {
        beat();
        if (!released) schedule();
      },
      haveId ? heartbeatMs : Math.min(FIRST_BEAT_POLL_MS, heartbeatMs)
    );
    timer.unref?.();
  };

  beat();
  schedule();

  const release = (): void => {
    if (released) return;
    released = true;
    activeLeases.delete(lease);
    if (timer) clearTimeout(timer);
    try {
      if (db) {
        // Only clear what is still ours: a resume by another process re-took it.
        const clear = db.prepare(
          "UPDATE crawls SET owner_pid = NULL, owner_host = NULL WHERE id = ? AND owner_pid = ? AND owner_host = ?"
        );
        for (const id of held) clear.run(id, pid, host);
      }
    } catch {
      // A failed clear leaves a lease that goes stale on its own.
    } finally {
      try {
        db?.close();
      } catch {
        // nothing to do
      }
      db = null;
    }
  };

  const lease: CrawlLease = { beat, release };
  activeLeases.add(lease);
  return lease;
}
