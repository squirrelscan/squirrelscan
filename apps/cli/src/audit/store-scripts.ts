// Opt-in storage of the first-party scripts a crawl fetched (#1255): the bytes
// the secret rules and technology detection already read, kept in the content
// store (deduplicated by hash, under its size cap) and indexed by URL so a corpus
// or research run can re-analyse the crawl later without fetching it again.

import type { PreFetchedAssets } from "@squirrelscan/audit-engine";
import type {
  SQLiteStorage,
  StoredScriptInput,
  StoredScriptSkipReason,
  StoredScriptsSummary,
} from "@squirrelscan/crawler/storage";

import { STORED_SCRIPT_LIMITS } from "@squirrelscan/utils/constants";
import { Effect } from "effect";

import type { Config } from "@/config";

import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { logger } from "@/utils/logger";

/** The script fetch limit for a run that stores scripts: `store_scripts_max_scripts`, clamped to 1..500. */
export function storedScriptFetchLimit(config: Config): number {
  return Math.min(
    STORED_SCRIPT_LIMITS.maxScriptsCeiling,
    Math.max(
      1,
      config.storage.store_scripts_max_scripts ??
        STORED_SCRIPT_LIMITS.maxScripts
    )
  );
}

/** The per-file and per-audit caps in force: `[storage]` over the defaults. */
export function storedScriptLimits(
  config: Config,
  contentStoreCapBytes: number
): { maxBytes: number; totalBytes: number } {
  const maxBytes =
    config.storage.store_scripts_max_bytes ?? STORED_SCRIPT_LIMITS.maxBytes;
  const totalBytes =
    config.storage.store_scripts_total_bytes ??
    Math.floor(contentStoreCapBytes * STORED_SCRIPT_LIMITS.totalFraction);
  return { maxBytes, totalBytes };
}

/** Same-site scripts the fetch phase pulled, plus the chunks pages preload, one entry per URL. */
export function scriptsToStore(
  assets: Pick<PreFetchedAssets, "scripts" | "preloadedScripts">
): StoredScriptInput[] {
  const byUrl = new Map<string, StoredScriptInput>();
  for (const script of [
    ...assets.scripts,
    ...(assets.preloadedScripts ?? []),
  ]) {
    if (byUrl.has(script.url)) continue;
    byUrl.set(script.url, {
      url: script.url,
      status: script.status,
      content: script.content,
      sizeBytes: script.sizeBytes,
      sourcePages: script.sourcePages,
      ...(script.finalUrl ? { finalUrl: script.finalUrl } : {}),
      ...(script.fetchSkipReason
        ? { fetchSkipReason: script.fetchSkipReason }
        : {}),
    });
  }
  return [...byUrl.values()];
}

/**
 * The warning for scripts that were referenced but not stored, one clause per
 * reason with its count and the setting or bound that applies (#1268).
 * Null when nothing was skipped.
 */
export function skippedScriptsWarning(
  byReason: StoredScriptsSummary["skippedByReason"],
  limits: { maxBytes: number; totalBytes: number }
): string | null {
  const clauses: string[] = [];
  const add = (reason: StoredScriptSkipReason, text: string): void => {
    const count = byReason[reason] ?? 0;
    if (count > 0) clauses.push(`${count} ${text}`);
  };
  add(
    "too-large",
    `over ${limits.maxBytes} bytes each (raise [storage] store_scripts_max_bytes)`
  );
  add(
    "total-cap",
    `past the ${limits.totalBytes} byte total (raise [storage] store_scripts_total_bytes)`
  );
  add(
    "memory-cap",
    `not fetched because ${STORED_SCRIPT_LIMITS.heldBytes} bytes of script text were already held (a fixed memory bound)`
  );
  add(
    "time-budget",
    `not fetched after ${STORED_SCRIPT_LIMITS.fetchTimeBudgetMs / 1000} seconds of script fetching (a fixed time bound)`
  );
  add("not-javascript", "a page served at a script URL");
  add("store-error", "that the content store could not write");
  if (clauses.length === 0) return null;
  const total = Object.values(byReason).reduce((sum, n) => sum + (n ?? 0), 0);
  return `${total} script(s) were not stored: ${clauses.join("; ")}`;
}

export async function storeFetchedScripts(opts: {
  storage: SQLiteStorage;
  crawlId: string;
  assets: Pick<
    PreFetchedAssets,
    "scripts" | "preloadedScripts" | "assetCapDropped"
  >;
  config: Config;
}): Promise<void> {
  try {
    const limits = storedScriptLimits(
      opts.config,
      getGlobalContentStore().getMaxBytes()
    );
    const summary = await Effect.runPromise(
      opts.storage.storeCrawlScripts(
        opts.crawlId,
        scriptsToStore(opts.assets),
        limits,
        {
          fetchLimit: storedScriptFetchLimit(opts.config),
          droppedByLimit: opts.assets.assetCapDropped?.scripts ?? 0,
        }
      )
    );
    logger.debug(
      `stored scripts: ${summary.stored} indexed, ${summary.distinct} distinct (${summary.distinctBytes} bytes), ${summary.skipped} skipped`
    );
    const dropped = opts.assets.assetCapDropped?.scripts ?? 0;
    if (dropped > 0) {
      logger.warn(
        `${dropped} script(s) the pages reference were not fetched (limit ${storedScriptFetchLimit(opts.config)} per audit); raise [storage] store_scripts_max_scripts to fetch and store more`
      );
    }
    const skippedWarning = skippedScriptsWarning(
      summary.skippedByReason,
      limits
    );
    if (skippedWarning) logger.warn(skippedWarning);
  } catch (error) {
    // A finished audit is never lost to an opt-in side store.
    logger.warn(
      `Could not store the fetched scripts: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
