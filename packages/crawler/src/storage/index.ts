import { Effect } from "effect";

import type { CrawlStorage } from "./types";

import { SQLiteStorage } from "./sqlite";
import { StorageError } from "./types";

export * from "./types";
export { SQLiteStorage, type ContentStoreAdapter } from "./sqlite";

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
