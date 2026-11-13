// `squirrel pages` controller (#701): reads the page map of a stored audit out of the project
// store. Everything is already stored by the crawl (the pages, their features, the link graph and
// the rule results), so nothing is fetched or recomputed.

import type { StoreIntegrityEvicted } from "@squirrelscan/core-contracts";

import { readPageMapRows } from "@squirrelscan/audit-engine/page-map-rows";
import { type PageMapRow } from "@squirrelscan/report/page-map";
import { Effect } from "effect";
import { existsSync } from "node:fs";

import type { CrawlMetadata } from "@/crawler/storage/types";

import {
  getProjectStoragePaths,
  isReportRenderable,
  reportUnavailableReason,
} from "@/controllers/report";
import {
  type Result,
  ok,
  err,
  commandError,
  ErrorCodes,
} from "@/controllers/types";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { checkStoreIntegrity } from "@/crawler/storage/eviction-notice";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

/** One audit's page map, with the audit it came from. */
export interface StoredPageMap {
  crawl: CrawlMetadata;
  rows: PageMapRow[];
  /** Set when page bodies of this audit are gone from the content store (#1667); absent when none are. */
  storeIntegrity?: StoreIntegrityEvicted;
}

/** The newest renderable audit matching `crawlId` (an id or prefix), in any project; the newest overall without one. */
async function findCrawl(
  crawlId: string | undefined
): Promise<
  Result<{ crawl: CrawlMetadata; dbPath: string; warnings: string[] }>
> {
  const warnings: string[] = [];
  const matches: Array<{ crawl: CrawlMetadata; dbPath: string }> = [];
  let sawUnrenderable: CrawlMetadata | undefined;
  for (const dbPath of getProjectStoragePaths()) {
    if (!existsSync(dbPath)) continue;
    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      await Effect.runPromise(storage.init());
      const crawls = await Effect.runPromise(storage.listCrawls());
      for (const crawl of crawls) {
        if (crawlId && !(crawl.id === crawlId || crawl.id.startsWith(crawlId)))
          continue;
        if (isReportRenderable(crawl)) matches.push({ crawl, dbPath });
        else sawUnrenderable ??= crawl;
      }
    } catch (error) {
      // One unreadable project must not hide the others, and must not hide itself either.
      warnings.push(`${dbPath}: ${String(error)}`);
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
  if (matches.length === 0) {
    if (warnings.length > 0) {
      return err(
        commandError(
          ErrorCodes.CRAWL_ERROR,
          `Could not read the page map: ${warnings.join("; ")}`
        )
      );
    }
    if (crawlId && sawUnrenderable) {
      return err(
        commandError(
          ErrorCodes.CRAWL_NOT_READY,
          `Audit ${reportUnavailableReason(sawUnrenderable)}: ${sawUnrenderable.id}`
        )
      );
    }
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        crawlId
          ? `No audit found matching "${crawlId}".`
          : 'No audit found. Run "squirrel audit <url>" first.'
      )
    );
  }
  matches.sort((a, b) => b.crawl.startedAt - a.crawl.startedAt);
  return ok({ ...matches[0]!, warnings });
}

/** Load the page map of audit `crawlId` (id or prefix), or the newest audit. */
export async function loadPageMap(
  crawlId?: string
): Promise<Result<StoredPageMap & { warnings: string[] }>> {
  const found = await findCrawl(crawlId);
  if (!found.ok) return found;
  const { crawl, dbPath, warnings } = found.data;
  const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
  try {
    await Effect.runPromise(storage.init());
    const rows = await Effect.runPromise(readPageMapRows(storage, crawl));
    // The rows come from the page data stored with the audit, but an evicted body is worth one line (#1667).
    const integrity = await checkStoreIntegrity(storage, crawl.id, "read");
    return ok({
      crawl,
      rows,
      warnings,
      ...(integrity.status === "evicted" ? { storeIntegrity: integrity } : {}),
    });
  } catch (error) {
    return err(
      commandError(
        ErrorCodes.CRAWL_ERROR,
        `Could not read the page map: ${String(error)}`
      )
    );
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
  }
}

/**
 * The two audits of a `--diff`, older first.
 *
 * Two ids name both sides (across sites if you like). One id names the newer side and the older
 * one is the audit of the same site before it; none compares the latest audit with the one
 * before it. The store holds every project, so "the two newest audits" would routinely be two
 * different sites, and diffing those reports one site's whole page set as added and the other's
 * as removed.
 */
export async function loadPageMapPair(
  crawlIds: readonly string[]
): Promise<
  Result<{ older: StoredPageMap; newer: StoredPageMap; warnings: string[] }>
> {
  if (crawlIds.length >= 2) {
    const a = await loadPageMap(crawlIds[0]);
    if (!a.ok) return a;
    const b = await loadPageMap(crawlIds[1]);
    if (!b.ok) return b;
    const [older, newer] =
      a.data.crawl.startedAt <= b.data.crawl.startedAt
        ? [a.data, b.data]
        : [b.data, a.data];
    return ok({
      older,
      newer,
      warnings: [...a.data.warnings, ...b.data.warnings],
    });
  }
  const newer = await loadPageMap(crawlIds[0]);
  if (!newer.ok) return newer;
  const previous = await findPreviousCrawl(newer.data.crawl);
  if (!previous.ok) return previous;
  const older = await loadPageMap(previous.data.id);
  if (!older.ok) return older;
  return ok({
    older: older.data,
    newer: newer.data,
    warnings: [...newer.data.warnings, ...older.data.warnings],
  });
}

/** The renderable audit of the same site that ran just before `crawl`. */
async function findPreviousCrawl(
  crawl: CrawlMetadata
): Promise<Result<CrawlMetadata>> {
  let best: CrawlMetadata | undefined;
  // The newest earlier audit that cannot be read (reclaimed, still running): named in the message
  // when it is the only earlier one, so "only one has been run" is never said wrongly.
  let skipped: CrawlMetadata | undefined;
  for (const dbPath of getProjectStoragePaths()) {
    if (!existsSync(dbPath)) continue;
    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      await Effect.runPromise(storage.init());
      for (const other of await Effect.runPromise(storage.listCrawls())) {
        if (
          other.baseUrl !== crawl.baseUrl ||
          other.startedAt >= crawl.startedAt
        )
          continue;
        if (!isReportRenderable(other)) {
          if (!skipped || other.startedAt > skipped.startedAt) skipped = other;
        } else if (!best || other.startedAt > best.startedAt) {
          best = other;
        }
      }
    } catch (error) {
      return err(
        commandError(
          ErrorCodes.CRAWL_ERROR,
          `Could not read the page map: ${dbPath}: ${String(error)}`
        )
      );
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
  if (!best && skipped) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        `The previous audit of ${crawl.baseUrl} (${skipped.id.slice(0, 8)}) ${reportUnavailableReason(skipped)}, so there is nothing to compare with. Run "squirrel audit ${crawl.baseUrl}" again, or name both audits.`
      )
    );
  }
  if (!best) {
    return err(
      commandError(
        ErrorCodes.CRAWL_NOT_FOUND,
        `Need two audits of ${crawl.baseUrl} to compare; only one has been run. Run "squirrel audit ${crawl.baseUrl}" again, or name both: squirrel pages --diff --crawl <older> --crawl <newer>`
      )
    );
  }
  return ok(best);
}
