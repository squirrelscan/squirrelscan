// The one guarded write of `crawls.status` (#1659, #1672).
//
// `SQLiteStorage.updateCrawl` and the Ctrl-C handler both write a crawl's status, and both must
// obey the transition table in core-contracts. The predicate lives here so they cannot disagree:
// the allowed-from list is a bound parameter, so the check and the write are one statement.

import type { Database } from "bun:sqlite";

import { CRAWL_STATUS_TRANSITIONS, type CrawlStatus } from "@squirrelscan/core-contracts";

/** The SQL condition on `status`, with the allowed-from list bound twice (`,a,b,`), or null for no status. */
export const CRAWL_STATUS_GUARD_SQL = "(? IS NULL OR instr(?, ',' || status || ',') > 0)";

/** The bound parameter for a write to `to`: the statuses the table lets it be written from. */
export function crawlStatusAllowedFrom(to: CrawlStatus): string {
  return `,${CRAWL_STATUS_TRANSITIONS[to].join(",")},`;
}

/**
 * Write `to` on crawl `id` if the table allows the move from its current status. Returns the rows
 * changed (0 for a missing crawl or a refused move). Synchronous, for a caller that cannot await
 * (a signal handler); the caller owns the connection.
 */
export function writeCrawlStatusGuarded(db: Database, id: string, to: CrawlStatus): number {
  const allowedFrom = crawlStatusAllowedFrom(to);
  const result = db
    .prepare(`UPDATE crawls SET status = ? WHERE id = ? AND ${CRAWL_STATUS_GUARD_SQL}`)
    .run(to, id, allowedFrom, allowedFrom);
  return Number(result.changes ?? 0);
}
