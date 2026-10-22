// Record an interrupted crawl as `stopped` (#941).
//
// SIGINT/SIGTERM/SIGHUP used to finalize only the cloud run record, so a Ctrl-C
// left the crawl at `running`, indistinguishable from a `kill -9`. `stopped` is
// the state `--resume` already continues, and it says the interruption was
// seen. Runs inside a signal handler, so it is synchronous, best-effort and
// never throws: a failed write leaves the crawl exactly as it was before. The
// mark is best-effort: the 1 s busy timeout can lose it to a writer holding the
// lock, so nothing the user sees may claim it was recorded.

import { releaseActiveLeases } from "@squirrelscan/crawler";
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
 * Mark the crawl this process owns as `stopped`, if it is still `running`.
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
    const result = db
      .prepare(
        "UPDATE crawls SET status = 'stopped' WHERE id = ? AND status = 'running'"
      )
      .run(id);
    // `finally` blocks do not run on this path, so drop the crawl lease too
    // (#946). Separate from the status write: a failure here changes nothing.
    try {
      db.prepare(
        "UPDATE crawls SET owner_pid = NULL, owner_host = NULL WHERE id = ? AND owner_pid = ?"
      ).run(id, process.pid);
    } catch {
      // the lease goes stale on its own
    }
    return Number(result.changes ?? 0);
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
