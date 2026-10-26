// Crawl lease writer and resume gate (#946, #1026).
//
// The process driving a crawl records its pid, host and a heartbeat on the
// `crawls` row, so liveness is written down rather than inferred from newer
// audits. A resume must claim the lease before it starts writing the crawl.
//
// The beat runs on its OWN connection with a 1 s busy timeout. The crawl
// writer's connection waits up to 15 s on a lock; a beat sharing that wait would
// stall the event loop behind a long foreign write. On SQLITE_BUSY the beat is
// skipped and the next one (15 s later) retries, against a 5 min stale window.
// The timer is unref'd so it never keeps the process alive.

import { Database } from "bun:sqlite";
import { hostname } from "node:os";

import { isPidAlive, isReadablePid } from "./crawl-liveness";
import {
  CRAWL_LEASE_BUSY_TIMEOUT_MS,
  CRAWL_LEASE_HEARTBEAT_MS,
  CRAWL_LEASE_PID_TRUST_MS,
  CRAWL_LEASE_STALE_MS,
} from "./types";

export interface CrawlLeaseOptions {
  /** The project database file. `:memory:` yields a no-op; a missing file cannot be claimed. */
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
  /** Atomically claim a specific crawl before resuming it. */
  readonly claim: (crawlId: string) => CrawlLeaseClaim;
  /** Stop beating and clear the owner. Idempotent; never throws. */
  readonly release: () => void;
}

export type CrawlLeaseClaim =
  | { readonly acquired: true }
  | {
      readonly acquired: false;
      readonly ownerPid?: number;
      readonly ownerHost?: string;
    };

const ACQUIRED: CrawlLeaseClaim = { acquired: true };
const NOOP_LEASE: CrawlLease = {
  beat: () => false,
  // Non-file stores cannot be shared by two CLI processes, so there is no
  // competing writer to reject and resume keeps its previous behavior.
  claim: () => ACQUIRED,
  release: () => {},
};
const UNAVAILABLE_LEASE: CrawlLease = {
  beat: () => false,
  claim: () => ({ acquired: false }),
  release: () => {},
};

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
    // Never create a database from the lease: a missing file cannot be claimed.
    db = new Database(options.dbPath, { readwrite: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${CRAWL_LEASE_BUSY_TIMEOUT_MS}`);
  } catch {
    try {
      db?.close();
    } catch {
      // nothing to do
    }
    return UNAVAILABLE_LEASE;
  }

  const held = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  // Fast polling only while there is no crawl id; once it exists the cadence is
  // the heartbeat, also after a busy skip.
  let haveId = false;

  const claim = (id: string): CrawlLeaseClaim => {
    if (released || !db) return { acquired: false };
    try {
      // First claim only a free lease or one already held by this process.
      const t = now();
      const result = db
        .prepare(
          `UPDATE crawls SET owner_pid = ?, owner_host = ?, heartbeat_at = ?
           WHERE id = ? AND ((owner_pid IS NULL AND owner_host IS NULL) OR (owner_pid = ? AND owner_host = ?))`
        )
        .run(pid, host, t, id, pid, host);
      if (Number(result.changes ?? 0) > 0) {
        held.add(id);
        return ACQUIRED;
      }

      const owner = db
        .prepare(
          "SELECT owner_pid, owner_host, heartbeat_at FROM crawls WHERE id = ?"
        )
        .get(id) as {
        owner_pid: unknown;
        owner_host: unknown;
        heartbeat_at: unknown;
      } | null;
      if (!owner) return { acquired: false };

      const heartbeatAge =
        typeof owner.heartbeat_at === "number" &&
        Number.isFinite(owner.heartbeat_at)
          ? t - owner.heartbeat_at
          : null;
      // A suspended same-host process may miss heartbeats while it still owns
      // the SQLite writer. Match the retirement liveness rule: trust its live
      // pid for up to 24 hours instead of stealing at the five-minute boundary.
      if (
        owner.owner_host === host &&
        isReadablePid(owner.owner_pid) &&
        heartbeatAge !== null &&
        heartbeatAge < CRAWL_LEASE_PID_TRUST_MS &&
        isPidAlive(owner.owner_pid)
      ) {
        return {
          acquired: false,
          ownerPid: owner.owner_pid,
          ownerHost: host,
        };
      }

      const sameHostDead =
        owner.owner_host === host &&
        isReadablePid(owner.owner_pid) &&
        !isPidAlive(owner.owner_pid);
      const stale =
        heartbeatAge === null || heartbeatAge >= CRAWL_LEASE_STALE_MS;
      if (sameHostDead || stale) {
        // Compare every owner field we read so a heartbeat or a different
        // claimant between SELECT and UPDATE wins instead of being overwritten.
        const taken = db
          .prepare(
            `UPDATE crawls SET owner_pid = ?, owner_host = ?, heartbeat_at = ?
             WHERE id = ? AND owner_pid IS ? AND owner_host IS ? AND heartbeat_at IS ?`
          )
          .run(
            pid,
            host,
            t,
            id,
            owner.owner_pid,
            owner.owner_host,
            owner.heartbeat_at
          );
        if (Number(taken.changes ?? 0) > 0) {
          held.add(id);
          return ACQUIRED;
        }
      }

      return {
        acquired: false,
        ...(typeof owner?.owner_pid === "number"
          ? { ownerPid: owner.owner_pid }
          : {}),
        ...(typeof owner?.owner_host === "string"
          ? { ownerHost: owner.owner_host }
          : {}),
      };
    } catch {
      // SQLITE_BUSY past the 1 s timeout, or a DB without the columns: do not
      // resume without proving this process is the sole writer.
      return { acquired: false };
    }
  };

  const beat = (): boolean => {
    if (released || !db) return false;
    const id = options.getCrawlId();
    if (!id) return false;
    haveId = true;
    return claim(id).acquired;
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

  const lease: CrawlLease = { beat, claim, release };
  activeLeases.add(lease);
  return lease;
}
