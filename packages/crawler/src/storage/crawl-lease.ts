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

import {
  CRAWL_LEASE_BUSY_TIMEOUT_MS,
  CRAWL_LEASE_HEARTBEAT_MS,
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

/** How often to retry until the first beat lands (the crawl row may not exist yet). */
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
  let everBeat = false;

  const beat = (): boolean => {
    if (released || !db) return false;
    const id = options.getCrawlId();
    if (!id) return false;
    try {
      // Re-asserts ownership every beat, so a lease cleared by a stale sweep heals.
      const result = db
        .prepare(
          "UPDATE crawls SET owner_pid = ?, owner_host = ?, heartbeat_at = ? WHERE id = ?"
        )
        .run(pid, host, now(), id);
      if (Number(result.changes ?? 0) > 0) {
        held.add(id);
        return true;
      }
      return false;
    } catch {
      // SQLITE_BUSY past the 1 s timeout, or a DB without the columns: skip.
      return false;
    }
  };

  const schedule = (): void => {
    timer = setTimeout(
      () => {
        if (beat()) everBeat = true;
        if (!released) schedule();
      },
      everBeat ? heartbeatMs : Math.min(FIRST_BEAT_POLL_MS, heartbeatMs)
    );
    timer.unref?.();
  };

  if (beat()) everBeat = true;
  schedule();

  const release = (): void => {
    if (released) return;
    released = true;
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

  return { beat, release };
}

/**
 * Clear this process's lease on a crawl, synchronously and best-effort, for the
 * signal handler (which exits without running `finally` blocks).
 */
export function clearCrawlLease(
  dbPath: string,
  crawlId: string,
  pid: number = process.pid
): void {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readwrite: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${CRAWL_LEASE_BUSY_TIMEOUT_MS}`);
    db.prepare(
      "UPDATE crawls SET owner_pid = NULL, owner_host = NULL WHERE id = ? AND owner_pid = ?"
    ).run(crawlId, pid);
  } catch {
    // leaves a lease that goes stale on its own
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to do
    }
  }
}
