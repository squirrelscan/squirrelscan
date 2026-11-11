// Record an interrupted crawl as `stopped` (#941, #1672).
//
// SIGINT/SIGTERM/SIGHUP used to finalize only the cloud run record, so a Ctrl-C
// left the crawl at `running`, indistinguishable from a `kill -9`. `stopped` is
// the state `--resume` already continues, and it says the interruption was
// seen. The crawler's own `stop()` may have written `paused` first (it does,
// while the loop is live), so the write is allowed from `paused` as well as
// `running`: the transition table in core-contracts lists both as legal sources
// of `stopped`, and the write goes through the same guarded statement every
// other status write uses, never a status filter of its own (#1672). Runs
// inside a signal handler, so it is synchronous, best-effort and
// never throws: a failed write leaves the crawl exactly as it was before. The
// mark is best-effort: the 1 s busy timeout can lose it to a writer holding the
// lock, so nothing the user sees may claim it was recorded.

import {
  releaseActiveLeases,
  writeCrawlStatusGuarded,
} from "@squirrelscan/crawler";
import { Database } from "bun:sqlite";

let ownedCrawlId: () => string | null = () => null;

/**
 * Register how to read the id of the crawl THIS process is writing. The audit
 * controller points it at its crawler. Identity by id, not by start time: a
 * timestamp would also match an unrelated audit that started a moment later and
 * miss a resumed crawl.
 */
export function registerOwnedCrawl(getId: () => string | null): void {
  ownedCrawlId = getId;
}

/**
 * Mark the crawl this process owns as `stopped`, if the transition table allows
 * it from where the crawl is now (`running`, or the `paused` a `stop()` left).
 * Returns the number marked.
 */
export function stopInterruptedCrawls(dbPath: string): number {
  // First, so a heartbeat still on its timer cannot re-assert what is cleared
  // below (#946). Runs even with no owned crawl id.
  try {
    releaseActiveLeases();
  } catch {
    // best-effort
  }
  const id = ownedCrawlId();
  if (!id) return 0;
  let db: Database | undefined;
  try {
    // Never create a database from a signal handler: a missing file is a no-op.
    db = new Database(dbPath, { readwrite: true, create: false });
    db.exec("PRAGMA busy_timeout = 1000");
    const changed = writeCrawlStatusGuarded(db, id, "stopped");
    // `finally` blocks do not run on this path, so drop the crawl lease too
    // (#946). Separate from the status write: a failure here changes nothing.
    try {
      db.prepare(
        "UPDATE crawls SET owner_pid = NULL, owner_host = NULL WHERE id = ? AND owner_pid = ?"
      ).run(id, process.pid);
    } catch {
      // the lease goes stale on its own
    }
    return changed;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to do
    }
  }
}
