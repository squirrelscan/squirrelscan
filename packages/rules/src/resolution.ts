// Build the unsampled publish resolution signal (#1185).
//
// Runs in BOTH publish producers — the CLI (`slimForPublish`) and the cloud
// container (worker-agent `truncateReportForPublish`) — over the PRE-sample
// `ruleResults`, before #1167's `sampleChecksForPublish` clips `pages[]`. The
// server merge consumes the signal to resolve findings on pages crawled clean
// this run regardless of sampling; see core-contracts/resolution.ts for the
// contract semantics.
//
// Worker-clean like fold.ts: core-contracts + utils/url only, no rule runtime.

import type { CheckResult, ResolutionSignal } from "@squirrelscan/core-contracts";
import { RESOLUTION_SIGNAL_LIMITS } from "@squirrelscan/core-contracts/limits";
import { resolutionCheckKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { normalizeUrl } from "@squirrelscan/utils/url";

/**
 * Build the resolution signal from a report's pre-sample rule results + the
 * crawled page URLs (`report.pages[].url`, which publish drops).
 *
 * Key-emission contract (the server treats an ABSENT key as "no signal, never
 * resolve"): a `ruleId|checkName` key is emitted for every check class that
 * produced page-attributable EVALUATED checks this run — `pageUrl` checks and
 * folded aggregates (`details.aggregated` + `pages[]`) with status
 * pass/warn/fail. Genuine site-scope checks (no pageUrl, not aggregated) never
 * become per-page findings, so they emit nothing; `skipped` checks didn't
 * evaluate, so they emit nothing either.
 *
 * Every bound degrades safely server-side: a hash set clipped by the fold's
 * page cap or this builder's own budget is listed in `truncated` (absence
 * becomes non-authoritative → today's carry behavior); keys past `maxChecks`
 * are dropped entirely (absent key → today's behavior).
 *
 * Returns undefined when there is nothing to signal (no crawled pages and no
 * page-attributable checks) so empty reports add zero payload.
 */
export function buildResolutionSignal(
  ruleResults: Record<string, { checks: CheckResult[] }>,
  crawledPageUrls: string[],
): ResolutionSignal | undefined {
  const limits = RESOLUTION_SIGNAL_LIMITS;
  // Insertion-ordered so the budget clips deterministically (report order).
  const failing = new Map<string, Set<string>>();
  const truncated = new Set<string>();
  // Pages that produced an EVALUATED (pass/warn/fail) result for each key,
  // keyed by NORMALIZED URL rather than by hash. Build-time only — shipped as
  // its complement against `crawledUrls` (see `notEvaluated` below), which is
  // empty for the overwhelmingly common case of a check that ran on every
  // crawled page.
  //
  // Subtracting by URL, not by hash, is what keeps a hash collision in the
  // SAFE direction. If a not-evaluated page collided with an evaluated one and
  // the complement were computed on hashes, the not-evaluated page would
  // silently drop out of `notEvaluated` and could then be resolved. By URL it
  // stays in, and the collision instead makes the *other* page carry too —
  // over-carry, never a wrong resolve.
  const evaluated = new Map<string, Set<string>>();
  // The same page URL recurs across many checks/rules; normalizeUrl (URL
  // parsing) dominates the build cost, so memoize per unique URL.
  const normalizeCache = new Map<string, string>();
  const normalized = (url: string): string => {
    let norm = normalizeCache.get(url);
    if (norm === undefined) {
      norm = normalizeUrl(url);
      normalizeCache.set(url, norm);
    }
    return norm;
  };
  const hashCache = new Map<string, string>();
  const urlHash = (url: string): string => {
    const norm = normalized(url);
    let hash = hashCache.get(norm);
    if (hash === undefined) {
      hash = resolutionUrlHash(norm);
      hashCache.set(norm, hash);
    }
    return hash;
  };

  for (const [ruleId, rule] of Object.entries(ruleResults)) {
    for (const check of rule.checks) {
      if (check.status !== "pass" && check.status !== "warn" && check.status !== "fail") continue;
      const aggregated = check.details?.aggregated === true;
      const pageUrls = check.pageUrl
        ? [check.pageUrl]
        : aggregated && check.pages && check.pages.length > 0
          ? check.pages
          : null;
      if (!pageUrls) continue; // genuine site-scope check — never a page finding

      const key = resolutionCheckKey(ruleId, check.name);
      let set = failing.get(key);
      if (!set) {
        if (failing.size >= limits.maxChecks) continue; // dropped key = no signal (safe)
        set = new Set<string>();
        failing.set(key, set);
        evaluated.set(key, new Set<string>());
      }
      // Positive evaluation evidence. A page-scope rule can `skipped` one page
      // (perf/ttfb with no timing data) while passing another, and a rule can
      // emit no check at all for a page it doesn't apply to — in both cases the
      // page is absent from `failing` without being clean, so absence alone
      // must never resolve.
      const ev = evaluated.get(key)!;
      for (const url of pageUrls) ev.add(normalized(url));
      if (check.status !== "pass") {
        for (const url of pageUrls) {
          // Past the per-check cap the budget pass below clips to at most the
          // cap anyway — stop hashing (cap+1 is enough to prove truncation).
          // The overshoot to cap+1 is REQUIRED, not an off-by-one: the budget
          // pass detects truncation by `set.size > budget`, so a set stopped at
          // exactly the cap would look complete and be treated as authoritative
          // — resolving pages that were merely clipped.
          if (set.size > limits.maxHashesPerCheck) break;
          set.add(urlHash(url));
        }
        // The source pages[] was already clipped upstream (fold page cap /
        // byte-budget backstop stamp details.pagesTruncated) → the set is
        // incomplete, so absence from it must not resolve.
        const pagesTruncated = check.details?.pagesTruncated;
        if (
          typeof pagesTruncated === "number" &&
          !check.pageUrl &&
          pagesTruncated > (check.pages?.length ?? 0)
        ) {
          truncated.add(key);
        }
      }
    }
  }

  // Enforce the per-check and whole-signal hash budgets. An over-budget set is
  // CLIPPED to what fits (deterministic prefix — insertion order follows the
  // report) and marked truncated: kept hashes still prove "still failing"
  // (positive carry evidence), while the truncated marker makes absence
  // non-authoritative server-side. Clipping (vs emptying) also keeps the
  // signal byte-FLAT in crawl size, preserving the #1167 O(rules × cap)
  // publish-payload invariant.
  let totalHashes = 0;
  for (const [key, set] of failing) {
    const budget = Math.min(limits.maxHashesPerCheck, limits.maxHashesTotal - totalHashes);
    if (set.size > budget) {
      const kept = [...set].slice(0, Math.max(0, budget));
      set.clear();
      for (const hash of kept) set.add(hash);
      truncated.add(key);
    }
    totalHashes += set.size;
  }

  const crawledUrls = crawledPageUrls.slice(0, limits.maxCrawledUrls);
  if (crawledUrls.length === 0 && failing.size === 0) return undefined;

  // Per-key complement: crawled pages that produced NO evaluated result for
  // this check (rule skipped them, or didn't apply to them). The server must
  // not resolve on these — absence from `failing` isn't evidence of clean.
  // Emitted as the complement because it is empty for a check that ran
  // everywhere, keeping the common case free.
  // Deduped by normalized URL (not by hash) — see `evaluated` above for why
  // hash identity must not decide membership here.
  const crawledNormalized: string[] = [];
  const seenCrawled = new Set<string>();
  for (const url of crawledUrls) {
    const norm = normalized(url);
    if (!seenCrawled.has(norm)) {
      seenCrawled.add(norm);
      crawledNormalized.push(norm);
    }
  }
  const notEvaluated: Record<string, string[]> = {};
  if (crawledPageUrls.length > limits.maxCrawledUrls) {
    // The crawled list itself was clipped, so no complement can be trusted —
    // every key loses resolve authority (falls back to pre-#1185 carry).
    for (const key of failing.keys()) truncated.add(key);
  } else {
    let notEvaluatedTotal = 0;
    for (const [key, ev] of evaluated) {
      if (truncated.has(key)) continue; // already non-authoritative
      const missing = crawledNormalized
        .filter((norm) => !ev.has(norm))
        .map((norm) => resolutionUrlHash(norm));
      if (missing.length === 0) continue;
      // An oversized complement costs more than it's worth: drop resolve
      // authority for the key instead (safe direction).
      if (
        missing.length > limits.maxHashesPerCheck ||
        notEvaluatedTotal + missing.length > limits.maxHashesTotal
      ) {
        truncated.add(key);
        continue;
      }
      notEvaluated[key] = missing;
      notEvaluatedTotal += missing.length;
    }
  }

  const failingRecord: Record<string, string[]> = {};
  for (const [key, set] of failing) failingRecord[key] = [...set];
  return {
    crawledUrls,
    failing: failingRecord,
    ...(Object.keys(notEvaluated).length > 0 ? { notEvaluated } : {}),
    ...(truncated.size > 0 ? { truncated: [...truncated] } : {}),
  };
}
