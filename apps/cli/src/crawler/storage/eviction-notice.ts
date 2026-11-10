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
  /** `squirrel pages` or `squirrel entities` reading a stored audit whose bodies were evicted since (#1667). */
  | { kind: "read"; evicted: number; stored: number; capBytes: number }
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
    case "read":
      return `Content store: ${count(notice.evicted)} of ${pages(notice.stored)} stored for this audit are no longer in the local content store, ${cap}. This output is built from the page data stored with the audit and does not read their HTML, but anything that needs it (re-running the rules with \`squirrel analyze\`) cannot see those pages. ${HINT}`;
    case "resume":
      return `Content store: ${count(notice.evicted)} of ${pages(notice.stored)} crawled before the interruption are no longer in the local content store, ${cap}, so this audit cannot read them. Run without --resume to fetch them again. ${HINT}`;
    case "refetched":
      return `Content store: ${pages(notice.evicted)} cached from an earlier audit were no longer in the local content store, ${cap}, so they were requested again in full instead of revalidated. ${HINT}`;
  }
}

/**
 * Whether a stored audit's page bodies are all still in the content store (#1667): `full`, or
 * `evicted` with how many of the stored bodies are gone. Derived from the census counts, so every
 * reader of a stored audit says the same thing.
 */
export type StoreIntegrity =
  | { status: "full" }
  | { status: "evicted"; evicted: number; stored: number };

export function deriveStoreIntegrity(counts: {
  evicted: number;
  stored: number;
}): StoreIntegrity {
  return counts.evicted > 0
    ? { status: "evicted", evicted: counts.evicted, stored: counts.stored }
    : { status: "full" };
}

/** The part of {@link StoreIntegrity} a report or export carries: present only when bodies are missing. */
export type EvictedStoreIntegrity = Extract<
  StoreIntegrity,
  { status: "evicted" }
>;

/**
 * Read a stored crawl's integrity without saying anything (#1667): the census of evicted bodies as a
 * {@link StoreIntegrity}. For a reader that picks one crawl out of several and warns only for it.
 * Never fails the caller: a census that cannot run says `full`, as it said nothing before.
 */
export async function readStoreIntegrity(
  storage: CrawlStorage,
  crawlId: string
): Promise<StoreIntegrity> {
  if (!(storage instanceof SQLiteStorage)) return { status: "full" };
  const counts = await Effect.runPromise(
    storage
      .countEvictedPageBodies(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed({ evicted: 0, stored: 0 })))
  );
  return deriveStoreIntegrity(counts);
}

/** Print the notice for `kind` when `integrity` says bodies are gone. */
export function warnStoreIntegrity(
  integrity: StoreIntegrity,
  kind: "report" | "resume" | "read"
): void {
  if (integrity.status !== "evicted") return;
  logger.warn(
    formatEvictedPagesNotice({
      kind,
      evicted: integrity.evicted,
      stored: integrity.stored,
      capBytes: getGlobalContentStore().getMaxBytes(),
    })
  );
}

/**
 * {@link readStoreIntegrity} and {@link warnStoreIntegrity} in one: the entry for a command that reads
 * one stored audit (#1667). A resume first protects the surviving bodies for the run (under its lease,
 * best effort), so the pages it skips as done stay put until the rules phase reads them.
 */
export async function checkStoreIntegrity(
  storage: CrawlStorage,
  crawlId: string,
  kind: "report" | "resume" | "read"
): Promise<StoreIntegrity> {
  if (storage instanceof SQLiteStorage && kind === "resume") {
    await Effect.runPromise(
      storage
        .retainPageBodies(crawlId)
        .pipe(Effect.catchAll(() => Effect.succeed(0)))
    );
  }
  const integrity = await readStoreIntegrity(storage, crawlId);
  warnStoreIntegrity(integrity, kind);
  return integrity;
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
  const integrity = await checkStoreIntegrity(storage, crawlId, kind);
  return integrity.status === "evicted" ? integrity.evicted : 0;
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
