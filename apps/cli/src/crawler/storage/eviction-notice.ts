// The one line a command prints when the content store's size cap has evicted
// pages it needed (#2342). Eviction used to be silent: a later report, a
// re-audit or a resumed crawl read a partial store and said nothing.

import { Effect } from "effect";

import type { CrawlStorage } from "@/crawler/storage/types";

import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { formatBytes } from "@/self/disk";
import { logger } from "@/utils/logger";

const HINT =
  "Raise [storage] content_store_max_bytes or SQUIRREL_CONTENT_STORE_MAX_BYTES to keep more.";

const count = (n: number) => n.toLocaleString("en-US");
const pages = (n: number) => `${count(n)} page${n === 1 ? "" : "s"}`;

export type EvictedPagesNotice =
  /** `squirrel report` over a stored audit whose bodies were evicted since. */
  | { kind: "report"; evicted: number; stored: number; capBytes: number }
  /** A resumed crawl whose earlier pages were evicted while it was paused. */
  | { kind: "resume"; evicted: number; stored: number; capBytes: number }
  /** A re-audit whose cached pages were evicted, and so fetched again. */
  | { kind: "refetched"; evicted: number; capBytes: number };

export function formatEvictedPagesNotice(notice: EvictedPagesNotice): string {
  // The census sees only that a body is gone, not why; the size cap is the one
  // thing that deletes them in normal use. The cap shown is the one in force
  // NOW, which need not be the one that evicted them.
  const cap = `most likely evicted by its size cap (now ${formatBytes(notice.capBytes)})`;
  switch (notice.kind) {
    case "report":
      return `Content store: ${count(notice.evicted)} of ${pages(notice.stored)} stored for this audit are no longer in the local content store, ${cap}. Findings are unaffected; anything rebuilt from page HTML is missing for them. ${HINT}`;
    case "resume":
      return `Content store: ${count(notice.evicted)} of ${pages(notice.stored)} crawled before the interruption are no longer in the local content store, ${cap}, so this audit cannot read them. Run without --resume to fetch them again. ${HINT}`;
    case "refetched":
      return `Content store: ${pages(notice.evicted)} cached from an earlier audit were no longer in the local content store, ${cap}, so they were requested again in full instead of revalidated. ${HINT}`;
  }
}

/**
 * Count a stored crawl's evicted page bodies and, if there are any, warn (#2342).
 * Used before a resume (the crawl skips those pages as done, so they would drop
 * out of the audit silently; the survivors are first protected for the run) and
 * when `squirrel report` renders a stored audit. Never fails the caller: a
 * census that cannot run says nothing.
 */
export async function warnEvictedPages(
  storage: CrawlStorage,
  crawlId: string,
  kind: "report" | "resume"
): Promise<number> {
  if (!(storage instanceof SQLiteStorage)) return 0;
  if (kind === "resume") {
    // Under the run's lease, so the pages the resume skips as done stay put
    // until the rules phase reads them. Best effort: a store that cannot be
    // touched leaves them as exposed as they were, and the census still runs.
    await Effect.runPromise(
      storage
        .retainPageBodies(crawlId)
        .pipe(Effect.catchAll(() => Effect.succeed(0)))
    );
  }
  const counts = await Effect.runPromise(
    storage
      .countEvictedPageBodies(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed({ evicted: 0, stored: 0 })))
  );
  if (counts.evicted === 0) return 0;
  logger.warn(
    formatEvictedPagesNotice({
      kind,
      ...counts,
      capBytes: getGlobalContentStore().getMaxBytes(),
    })
  );
  return counts.evicted;
}

/**
 * After a crawl: how many cached pages it found evicted and fetched again
 * instead of reusing (#2342). The refetch is the fix; the line is the only sign
 * the cap is too small for the sites being audited.
 */
export function warnRefetchedPages(storage: CrawlStorage): number {
  if (!(storage instanceof SQLiteStorage)) return 0;
  const evicted = storage.evictedCacheEntryCount();
  if (evicted === 0) return 0;
  logger.warn(
    formatEvictedPagesNotice({
      kind: "refetched",
      evicted,
      capBytes: getGlobalContentStore().getMaxBytes(),
    })
  );
  return evicted;
}
