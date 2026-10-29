import { Effect } from "effect";

import type { CrawlStorage } from "./types";

import { SQLiteStorage } from "./sqlite";
import { StorageError } from "./types";

export * from "./types";
export {
  startCrawlLease,
  releaseActiveLeases,
  type CrawlLease,
  type CrawlLeaseClaim,
  type CrawlLeaseOptions,
} from "./crawl-lease";
export {
  isCrawlAbandoned,
  isPidAlive,
  REAL_LEASE_ENV,
  type LeaseCrawlRow,
  type LeaseEnv,
} from "./crawl-liveness";
export {
  SQLiteStorage,
  type ContentStoreAdapter,
  type StoredScriptInput,
  type StoredScriptRecord,
  type StoredScriptsFetchSummary,
  type StoredScriptSkipReason,
  type StoredScriptsSummary,
} from "./sqlite";

export function createTestStorage(): Effect.Effect<
  CrawlStorage,
  StorageError,
  never
> {
  return Effect.gen(function* () {
    const storage = new SQLiteStorage(":memory:");
    yield* storage.init();
    return storage;
  });
}
