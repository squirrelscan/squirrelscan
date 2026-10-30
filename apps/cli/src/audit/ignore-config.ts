// `[[ignore]]` bookkeeping for an audit (#1262).

import type { IgnoreEntry } from "@squirrelscan/config";

import { Effect } from "effect";

import type { SQLiteStorage } from "@/crawler/storage/sqlite";

/**
 * A short stable fingerprint of the list, kept with the audit so the next one can
 * tell whether the list changed. Order matters (entry indexes appear in reports).
 */
export function ignoreFingerprint(entries: readonly IgnoreEntry[]): string {
  return Bun.hash(JSON.stringify(entries)).toString(16);
}

/**
 * The fingerprint the previous completed audit of this project ran with (`""` when
 * it had no `[[ignore]]` entries, `"disabled"` under `--no-ignore`) and whether it
 * was itself carrying rows recorded under an older list; `undefined` when there is no previous audit (or
 * it cannot be read), in which case nothing can be stale.
 */
export async function previousIgnoreFingerprint(
  storage: SQLiteStorage,
  currentCrawlId: string
): Promise<{ fingerprint: string; carriedStale: boolean } | undefined> {
  try {
    const crawls = await Effect.runPromise(storage.listCrawls(10));
    const previous = crawls.find(
      (c) =>
        c.id !== currentCrawlId &&
        (c.status === "analyzed" || c.status === "completed")
    );
    if (!previous) return undefined;
    return {
      fingerprint: previous.scanScope?.ignore?.fingerprint ?? "",
      carriedStale: previous.scanScope?.ignore?.carriedStale === true,
    };
  } catch {
    return undefined;
  }
}
