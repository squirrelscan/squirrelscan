// Smart audits — finding merge / supplant logic (#110), Effect/CrawlStorage wrapper.
//
// Persists per-page finding state across audits so a PARTIAL re-audit never
// inflates the score: re-crawled pages get fresh evidence, un-crawled pages
// carry their last-known findings forward indefinitely, and pages that 404/410
// this run have their findings staled.
//
// All of this is gated upstream behind the `smart_audits` config flag — this
// module is never invoked when the flag is off, so behavior is unchanged.
//
// The actual state machine lives in `./merge-core` (pure, dependency-free) so
// the API's Promise wrapper (`./merge-promise`) shares EXACTLY the same logic.
// This file just loads prior state via the Effect `CrawlStorage` and delegates.

import { Effect } from "effect";

import type { CrawlStorage, StorageError } from "@squirrelscan/core-contracts";

import { computeMerge, type FlatFinding, type MergedState } from "./merge-core";

// Re-export the pure helpers + types so existing `@squirrelscan/audit-engine`
// consumers (CLI, tests) keep importing them from here unchanged.
export {
  computeMerge,
  fingerprint,
  findingKey,
  flattenChecks,
} from "./merge-core";
export type {
  ComputeMergeInput,
  FlatFinding,
  MergedFinding,
  MergedState,
} from "./merge-core";

export interface MergeInput {
  store: CrawlStorage;
  siteKey: string;
  crawlId: string;
  /** Normalized URLs successfully (re-)crawled this run — fresh evidence. */
  crawledUrls: Set<string>;
  /** Findings produced this run, flattened from CheckResults. */
  freshFindings: FlatFinding[];
  /** Normalized URLs that returned 404/410 this run (page gone). */
  removedUrls: Set<string>;
  /** Rule severity lookup (ruleId -> severity) for surfacing carried findings. */
  severityByRule: Map<string, string>;
  /** Real per-page HTTP status (normalizedUrl -> status) for site_pages. */
  statusByUrl: Map<string, number>;
}

/**
 * Merge this run's fresh findings against the persisted site store. Loads prior
 * OPEN findings + site pages via `CrawlStorage`, then runs the pure
 * {@link computeMerge}. The carry hot-path only needs OPEN findings — it never
 * scans resolved/stale history (which only grows; compaction is #197).
 */
export function mergeFindings(
  input: MergeInput
): Effect.Effect<MergedState, StorageError, never> {
  const { store, siteKey, ...rest } = input;
  return Effect.gen(function* () {
    const priorFindings = yield* store.getFindings(siteKey, ["open"]);
    const priorPages = yield* store.getSitePages(siteKey);
    return computeMerge({
      ...rest,
      siteKey,
      priorFindings,
      priorPages,
      now: Date.now(),
    });
  });
}
