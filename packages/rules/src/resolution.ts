// Build the unsampled publish resolution signal (#1185).
//
// Runs in BOTH publish producers — the CLI (`slimForPublish`) and the cloud
// container (worker-agent `truncateReportForPublish`) — over the PRE-sample
// `ruleResults`, before #1167's `sampleChecksForPublish` clips `pages[]`. The
// server merge consumes the signal to resolve findings on pages crawled clean
// this run regardless of sampling; see core-contracts/resolution.ts for the
// contract semantics.
//
// #2658: producers send it compact ({@link buildPublishResolution}), in a fixed
// byte budget shared with `pageStatuses`. Both shapes are built from the same
// evidence ({@link collectResolutionEvidence}), so the server, which decodes the
// compact one back into a ResolutionSignal, reads the same signal either way.
//
// Worker-clean like fold.ts: core-contracts + utils only, no rule runtime. The
// compact encoder deflates with node:zlib, which only the producers (Bun) call.

import { deflateRawSync } from "node:zlib";

import type { CheckResult, ResolutionSignal } from "@squirrelscan/core-contracts";
import {
  REPORT_LIMITS,
  RESOLUTION_PUBLISH_LIMITS,
  RESOLUTION_SIGNAL_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import {
  type CompactResolutionPayload,
  type CompactResolutionSignal,
  encodeIndexGaps,
  resolutionCheckKey,
  resolutionUrlHash,
  SCAN_TRUNCATED_SKIP_REASON,
} from "@squirrelscan/core-contracts/resolution";
import { byteLength } from "@squirrelscan/utils/bytes";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { clipPageStatusesToBytes } from "./fold";

/** The runner's noindex gate (pub#457): a skip that is a "does not apply" verdict. */
const NOT_APPLICABLE_SKIP_REASON = "noindex";

/**
 * What one run says about each page and check, keyed by NORMALIZED page URL:
 * the input both signal shapes are encoded from.
 */
interface ResolutionEvidence {
  /** The crawled list as given, clipped to `maxCrawledUrls` (the original shape ships these). */
  crawledRaw: string[];
  /** `crawledRaw` normalized and deduped, in crawl order. */
  crawled: string[];
  /** Distinct normalized pages in the whole crawled list, before the clip. */
  crawledCount: number;
  /** The crawled list was longer than `maxCrawledUrls`. */
  crawledOverCap: boolean;
  /**
   * Key → pages failing/warning it, in report order. A walk stops one page past
   * `maxHashesPerCheck` (enough to prove the set is incomplete).
   */
  failing: Map<string, Set<string>>;
  /** Key → pages that produced an evaluated result for it, noindex verdicts included. */
  evaluated: Map<string, Set<string>>;
  /** Keys whose source page list the fold had already clipped. */
  truncated: Set<string>;
  /** `resolutionUrlHash` of a normalized page URL, memoized. */
  hash: (normalizedUrl: string) => string;
}

/**
 * Walk a report's pre-sample rule results + the crawled page URLs
 * (`report.pages[].url`, which publish drops) into {@link ResolutionEvidence}.
 *
 * Key-emission contract (the server treats an ABSENT key as "no signal, never
 * resolve"): a `ruleId|checkName` key is emitted for every check class that
 * produced page-attributable EVALUATED checks this run — `pageUrl` checks and
 * folded aggregates (`details.aggregated` + `pages[]`) with status
 * pass/warn/fail. Genuine site-scope checks (no pageUrl, not aggregated) never
 * become per-page findings, so they emit nothing; `skipped` checks didn't
 * evaluate, so they emit nothing either.
 *
 * One skip is a verdict rather than a gap: the runner's noindex gate
 * (`skipReason: "noindex"`, pub#457) decided that NOTHING the rule reports applies
 * to that page. Its page counts as evaluated clean for every key of that rule that
 * this run emits, so a finding carried from before the page went noindex resolves
 * instead of being carried forever. If the run emits no key for the rule at all
 * (every page skipped), there is nothing to attach it to: the key is absent, and
 * the merge falls back to its pre-signal behaviour, which resolves a prior on a
 * crawled page (here the outcome the verdict wanted anyway).
 *
 * Another is a gap rather than a verdict: `skipReason: "scan-truncated"` (pub#501)
 * means the rule stopped at a work cap before it had seen the whole page. That page
 * is not evaluated, and its key is emitted even when no other page evaluated the
 * check, so the page lands in `notEvaluated` and its prior findings carry.
 */
function collectResolutionEvidence(
  ruleResults: Record<string, { checks: CheckResult[] }>,
  crawledPageUrls: string[],
): ResolutionEvidence {
  const limits = RESOLUTION_SIGNAL_LIMITS;
  // Insertion-ordered so the budgets clip deterministically (report order).
  const failing = new Map<string, Set<string>>();
  const truncated = new Set<string>();
  // Pages that produced an EVALUATED (pass/warn/fail) result for each key,
  // keyed by NORMALIZED URL rather than by hash. Build-time only — shipped as
  // its complement against the crawled pages (`notEvaluated`), which is empty
  // for the overwhelmingly common case of a check that ran on every crawled
  // page.
  //
  // Subtracting by URL, not by hash, is what keeps a hash collision in the
  // SAFE direction. If a not-evaluated page collided with an evaluated one and
  // the complement were computed on hashes, the not-evaluated page would
  // silently drop out of `notEvaluated` and could then be resolved. By URL it
  // stays in, and the collision instead makes the *other* page carry too —
  // over-carry, never a wrong resolve.
  const evaluated = new Map<string, Set<string>>();
  // Rule id per emitted key, and the pages each rule's noindex gate skipped
  // (normalized URL), merged into `evaluated` once every key is known.
  const keyRule = new Map<string, string>();
  const notApplicable = new Map<string, Set<string>>();
  // (#2063) Keyed on the QUERY-PRESERVING page identity, the same key the merge
  // stores findings under. A consumer on an older release hashed these
  // query-blind; it recognizes both spellings (see merge-core's resolutionHashes),
  // and the mismatch it cannot resolve only ever makes it carry, never resolve.
  //
  // The same page URL recurs across many checks/rules; normalizePageUrl (URL
  // parsing) dominates the build cost, so memoize per unique URL.
  const normalizeCache = new Map<string, string>();
  const normalized = (url: string): string => {
    let norm = normalizeCache.get(url);
    if (norm === undefined) {
      norm = normalizePageUrl(url);
      normalizeCache.set(url, norm);
    }
    return norm;
  };

  for (const [ruleId, rule] of Object.entries(ruleResults)) {
    for (const check of rule.checks) {
      if (check.status === "skipped" && check.skipReason === NOT_APPLICABLE_SKIP_REASON) {
        // A fold can turn these into one aggregate with pages[]. The runner gives
        // the skip its own `details.foldKey`, so an aggregate is trusted only when
        // it carries that key (every constituent was a noindex skip, not a mix
        // with another gate's skip). A clipped list only leaves the clipped pages
        // unevaluated (carry), never wrongly clean.
        const homogeneous = check.details?.foldKey === NOT_APPLICABLE_SKIP_REASON;
        const skippedUrls = check.pageUrl
          ? [check.pageUrl]
          : homogeneous
            ? (check.pages ?? [])
            : [];
        let set = notApplicable.get(ruleId);
        if (!set) {
          set = new Set<string>();
          notApplicable.set(ruleId, set);
        }
        for (const url of skippedUrls) set.add(normalized(url));
        continue;
      }
      if (check.status === "skipped" && check.skipReason === SCAN_TRUNCATED_SKIP_REASON) {
        // (pub#501) The opposite kind of skip: a GAP. The rule stopped at a work
        // cap with nothing found so far, so the page is not evaluated. That needs
        // the key to exist: with no other page evaluating the check, an absent key
        // falls back to resolving every prior on a crawled page. Registering it
        // with no evaluated page puts this page in `notEvaluated`, which carries.
        const key = resolutionCheckKey(ruleId, check.name);
        if (!failing.has(key) && failing.size < limits.maxChecks) {
          failing.set(key, new Set<string>());
          evaluated.set(key, new Set<string>());
          keyRule.set(key, ruleId);
        }
        continue;
      }
      if (check.status !== "pass" && check.status !== "warn" && check.status !== "fail") continue;
      // (#2063) A carried/unrendered check is a replay of an earlier observation,
      // not something this run evaluated. It can only mislead here — the pages it
      // names were not crawled, so the consumer never consults them — while eating
      // the signal's own budget: a producer replaying thousands of stale findings
      // would push the pages this crawl DID evaluate past `maxChecks` and out of
      // the signal entirely, which costs real resolutions.
      if (check.provenance === "carried" || check.provenance === "unrendered") continue;
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
        keyRule.set(key, ruleId);
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
          // Past the per-check cap the budget pass clips to at most the cap
          // anyway — stop collecting (cap+1 is enough to prove truncation).
          // The overshoot to cap+1 is REQUIRED, not an off-by-one: the budget
          // pass detects truncation by `set.size > budget`, so a set stopped at
          // exactly the cap would look complete and be treated as authoritative
          // — resolving pages that were merely clipped.
          if (set.size > limits.maxHashesPerCheck) break;
          set.add(normalized(url));
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

  // Noindex-gated pages are clean for every key of their rule (see the header).
  for (const [key, ev] of evaluated) {
    const skipped = notApplicable.get(keyRule.get(key)!);
    if (skipped) for (const url of skipped) ev.add(url);
  }

  // Deduped by normalized URL (not by hash) — see `evaluated` above for why
  // hash identity must not decide membership.
  const crawledRaw = crawledPageUrls.slice(0, limits.maxCrawledUrls);
  const crawled: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < crawledPageUrls.length; i++) {
    const norm = normalized(crawledPageUrls[i]!);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (i < limits.maxCrawledUrls) crawled.push(norm);
  }

  const hashCache = new Map<string, string>();
  const hash = (norm: string): string => {
    let value = hashCache.get(norm);
    if (value === undefined) {
      value = resolutionUrlHash(norm);
      hashCache.set(norm, value);
    }
    return value;
  };

  return {
    crawledRaw,
    crawled,
    crawledCount: seen.size,
    crawledOverCap: crawledPageUrls.length > limits.maxCrawledUrls,
    failing,
    evaluated,
    truncated,
    hash,
  };
}

/**
 * Build the original (#1185) resolution signal from a report's pre-sample rule
 * results + the crawled page URLs. Producers send {@link buildPublishResolution}
 * now; this shape stays for the API's rollout window and as the reference the
 * compact one is tested against.
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
  const evidence = collectResolutionEvidence(ruleResults, crawledPageUrls);
  if (evidence.crawledRaw.length === 0 && evidence.failing.size === 0) return undefined;
  const truncated = new Set(evidence.truncated);
  const urlHash = evidence.hash;

  const failing = new Map<string, Set<string>>();
  for (const [key, pages] of evidence.failing) {
    const set = new Set<string>();
    for (const url of pages) set.add(urlHash(url));
    // The walk stopped one page past the cap; colliding hashes could shrink the
    // set back under it and hide that, so the page count decides.
    if (pages.size > limits.maxHashesPerCheck) truncated.add(key);
    failing.set(key, set);
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

  // Per-key complement: crawled pages that produced NO evaluated result for
  // this check (rule skipped them, or didn't apply to them). The server must
  // not resolve on these — absence from `failing` isn't evidence of clean.
  // Emitted as the complement because it is empty for a check that ran
  // everywhere, keeping the common case free.
  const notEvaluated: Record<string, string[]> = {};
  if (evidence.crawledOverCap) {
    // The crawled list itself was clipped, so no complement can be trusted —
    // every key loses resolve authority (falls back to pre-#1185 carry).
    for (const key of failing.keys()) truncated.add(key);
  } else {
    let notEvaluatedTotal = 0;
    for (const [key, ev] of evidence.evaluated) {
      if (truncated.has(key)) continue; // already non-authoritative
      const missing = evidence.crawled.filter((norm) => !ev.has(norm)).map(urlHash);
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
    crawledUrls: evidence.crawledRaw,
    failing: failingRecord,
    ...(Object.keys(notEvaluated).length > 0 ? { notEvaluated } : {}),
    ...(truncated.size > 0 ? { truncated: [...truncated] } : {}),
  };
}

/**
 * The compact payload over the first `listed` crawled pages (crawl order), with
 * only the keys in `kept` authoritative (all of them when omitted).
 *
 * Same evidence and the same count caps as {@link buildResolutionSignal}, so with
 * every page listed and every key kept it decodes to that signal's content. Two
 * differences once the byte budget bites, both in the safe direction:
 *  - a key left out of `kept` ships no page set and is listed in `truncated`, so
 *    the merge carries instead of resolving on it;
 *  - with only part of the crawl listed (`complete: false`), failing and
 *    not-evaluated sets cover the listed pages, and the merge trusts the signal
 *    for those pages only (merge-core). The original shape could only mark every
 *    key truncated in that case.
 */
function compactPayload(
  evidence: ResolutionEvidence,
  listed: number,
  kept?: ReadonlySet<string>,
): CompactResolutionPayload {
  const limits = RESOLUTION_SIGNAL_LIMITS;
  const complete = !evidence.crawledOverCap && listed >= evidence.crawled.length;
  const listedPages = evidence.crawled.slice(0, listed);
  // Sorted: neighbouring URLs share long prefixes, which is most of what makes
  // the list deflate to ~10 bytes a page on a real site.
  const urls = [...listedPages].sort();
  const position = new Map<string, number>();
  for (let i = 0; i < urls.length; i++) position.set(urls[i]!, i);
  const other: string[] = [];
  const otherPosition = new Map<string, number>();
  const truncated = new Set(evidence.truncated);

  const failing = new Map<string, number[]>();
  let total = 0;
  for (const [key, pages] of evidence.failing) {
    if (kept && !kept.has(key)) {
      truncated.add(key);
      continue;
    }
    // The same per-check and whole-signal caps as the original shape, which
    // also bound what the decoder materializes server-side. Counted in distinct
    // hashes, as the original counts its hash set, so both clip at the same page.
    const budget = Math.min(limits.maxHashesPerCheck, limits.maxHashesTotal - total);
    const indexes: number[] = [];
    const hashes = new Set<string>();
    for (const url of pages) {
      let index = position.get(url);
      // A failing page that is not a listed crawled page. With a partial list
      // the merge never consults the signal for an unlisted page: skip it.
      if (index === undefined && !complete) continue;
      const hash = evidence.hash(url);
      // A page sharing a hash with one already in the set adds nothing the
      // decoded set could tell apart.
      if (hashes.has(hash)) continue;
      if (hashes.size >= budget) {
        truncated.add(key);
        break;
      }
      hashes.add(hash);
      if (index === undefined) {
        // With the whole crawl listed it is a page the crawl never fetched; the
        // original shape hashed it all the same, so it rides in `other`.
        index = otherPosition.get(url);
        if (index === undefined) {
          index = urls.length + other.length;
          otherPosition.set(url, index);
          other.push(url);
        }
      }
      indexes.push(index);
    }
    if (pages.size > limits.maxHashesPerCheck) truncated.add(key);
    total += hashes.size;
    failing.set(key, indexes);
  }

  const notEvaluated = new Map<string, number[]>();
  let notEvaluatedTotal = 0;
  for (const [key, ev] of evidence.evaluated) {
    if (truncated.has(key)) continue;
    const missing: number[] = [];
    for (const url of listedPages) if (!ev.has(url)) missing.push(position.get(url)!);
    if (missing.length === 0) continue;
    if (
      missing.length > limits.maxHashesPerCheck ||
      notEvaluatedTotal + missing.length > limits.maxHashesTotal
    ) {
      truncated.add(key);
      continue;
    }
    notEvaluated.set(key, missing);
    notEvaluatedTotal += missing.length;
  }

  const gaps = (map: Map<string, number[]>): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    for (const [key, indexes] of map) out[key] = encodeIndexGaps(indexes.sort((a, b) => a - b));
    return out;
  };
  return {
    v: 1,
    urls,
    ...(other.length > 0 ? { other } : {}),
    complete,
    // Never past the crawl ceiling, which the decoder enforces: billing reads it.
    pages: Math.min(evidence.crawledCount, REPORT_LIMITS.maxPages),
    failing: gaps(failing),
    ...(notEvaluated.size > 0 ? { notEvaluated: gaps(notEvaluated) } : {}),
    ...(truncated.size > 0 ? { truncated: [...truncated] } : {}),
  };
}

/** Deflate + base64 a payload; undefined past the decoder's inflated-size cap. */
function deflatePayload(
  payload: CompactResolutionPayload,
): { signal: CompactResolutionSignal; bytes: number } | undefined {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.byteLength > RESOLUTION_PUBLISH_LIMITS.maxInflatedBytes) return undefined;
  const signal: CompactResolutionSignal = { v: 1, data: deflateRawSync(json).toString("base64") };
  // base64 and the envelope are ASCII: characters are bytes.
  return { signal, bytes: JSON.stringify(signal).length };
}

/**
 * What each key adds to the deflated payload, roughly: its page sets deflated on
 * their own. Raw length would be the wrong measure: a check failing on nearly
 * every page is a long run of zero gaps that deflates to a few bytes, while one
 * failing on a random half of the pages costs a bit a page whatever the text.
 */
function keyCosts(payload: CompactResolutionPayload): Map<string, number> {
  const costs = new Map<string, number>();
  for (const [key, gaps] of Object.entries(payload.failing)) {
    const sets = JSON.stringify([key, gaps, payload.notEvaluated?.[key] ?? []]);
    costs.set(key, deflateRawSync(Buffer.from(sets, "utf8")).byteLength);
  }
  return costs;
}

/**
 * The compact resolution signal (#2658) for a report's pre-sample rule results
 * and crawled page URLs, at most `maxBytes` of serialized JSON. Undefined when
 * there is nothing to signal, or when not even an empty page list fits.
 *
 * Everything fits for any real site up to a few thousand pages. Past that the
 * builder gives up, whichever keeps more (listed page × key) decisions:
 *  - the costliest keys, with every page listed (a dense, site-wide failing
 *    check goes first; its findings carry instead of resolving), or
 *  - the tail of the crawl, with every key kept: a crawl-order prefix stays
 *    listed. Unlisted pages fall back to pre-#1185 behavior in the merge, and
 *    `pages` still counts every crawled page so the audited-page count does not
 *    drop with the list.
 * Each is a binary search over re-deflated candidates: only the overflow case
 * pays more than one deflate.
 */
export function buildCompactResolutionSignal(
  ruleResults: Record<string, { checks: CheckResult[] }>,
  crawledPageUrls: string[],
  maxBytes: number = RESOLUTION_PUBLISH_LIMITS.maxBytes,
): CompactResolutionSignal | undefined {
  const evidence = collectResolutionEvidence(ruleResults, crawledPageUrls);
  if (evidence.crawled.length === 0 && evidence.failing.size === 0) return undefined;
  const fit = (listed: number, kept?: ReadonlySet<string>): CompactResolutionSignal | undefined => {
    const out = deflatePayload(compactPayload(evidence, listed, kept));
    return out && out.bytes <= maxBytes ? out.signal : undefined;
  };

  const all = evidence.crawled.length;
  const whole = fit(all);
  if (whole) return whole;

  // Over budget. Two ways to give something up, scored by what the merge can
  // still decide: listed pages × authoritative keys.
  //  A. every page listed, the costliest keys dropped (only if the list fits);
  //  B. every key kept, the list clipped to a crawl-order prefix.
  // B alone is what a long-slug site at thousands of pages needs; A alone, for
  // a list that just fits, would keep pages but give up nearly every failing key.
  const none = new Set<string>();
  const candidates: Array<{ signal: CompactResolutionSignal; listed: number; keys: number }> = [];
  const keyCount = evidence.failing.size;
  if (fit(all, none)) {
    const kept = largestKeySet(evidence, all, fit);
    candidates.push({ ...kept, listed: all });
  }
  const prefix = largestPrefix(all, (listed) => fit(listed));
  if (prefix) candidates.push({ ...prefix, keys: keyCount });
  if (candidates.length === 0) {
    // Not even one page fits with every key: list what fits with none, then add
    // back what keys still fit.
    const bare = largestPrefix(all, (listed) => fit(listed, none));
    if (!bare) return undefined;
    candidates.push({ ...largestKeySet(evidence, bare.listed, fit), listed: bare.listed });
  }
  candidates.sort((a, b) => b.listed * b.keys - a.listed * a.keys || b.listed - a.listed);
  return candidates[0]!.signal;
}

type Fit = (listed: number, kept?: ReadonlySet<string>) => CompactResolutionSignal | undefined;

/**
 * Largest `listed` in [1, limit) for which `fit` succeeds (binary search; `limit`
 * itself is known not to fit). Undefined when even one page does not fit.
 */
function largestPrefix(
  limit: number,
  fit: (listed: number) => CompactResolutionSignal | undefined,
): { signal: CompactResolutionSignal; listed: number } | undefined {
  let best = limit > 1 ? fit(1) : undefined;
  if (!best) return undefined;
  let lo = 1;
  let hi = limit;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    const candidate = fit(mid);
    if (candidate) {
      lo = mid;
      best = candidate;
    } else {
      hi = mid;
    }
  }
  return { signal: best, listed: lo };
}

/**
 * With `listed` pages, the most keys that fit, cheapest first (ties in report
 * order): many cheap keys, the all-pass classes above all, are worth more than
 * one dense one. Caller has checked that no keys at all fits.
 */
function largestKeySet(
  evidence: ResolutionEvidence,
  listed: number,
  fit: Fit,
): { signal: CompactResolutionSignal; keys: number } {
  const costs = keyCosts(compactPayload(evidence, listed));
  const order = [...costs.keys()]
    .map((key, i) => ({ key, i, cost: costs.get(key)! }))
    .sort((a, b) => a.cost - b.cost || a.i - b.i)
    .map((entry) => entry.key);
  const keep = (count: number) => new Set(order.slice(0, count));
  const every = fit(listed, keep(order.length));
  if (every) return { signal: every, keys: order.length };
  let best = fit(listed, keep(0))!;
  let lo = 0;
  let hi = order.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    const candidate = fit(listed, keep(mid));
    if (candidate) {
      lo = mid;
      best = candidate;
    } else {
      hi = mid;
    }
  }
  return { signal: best, keys: lo };
}

/** Statuses the merge treats as a page gone (stale its findings): merge-promise.ts. */
const REMOVED_PAGE_STATUSES = new Set([404, 410]);

/** The crawl-sized publish fields, fitted to RESOLUTION_PUBLISH_LIMITS. */
export interface PublishResolution {
  /** Non-2xx pages (url + status); omitted for a site with none. */
  pageStatuses?: Array<{ url: string; status: number }>;
  resolutionSignalCompact?: CompactResolutionSignal;
}

/**
 * The two publish fields sized by pages crawled rather than by findings (#2658):
 * `pageStatuses` and the compact resolution signal, together within
 * `limits.maxBytes`. Both producers (CLI `slimForPublish`, worker-agent
 * `truncateReportForPublish`) call this over the PRE-sample rule results and the
 * report's full `pages[]`, before either is dropped or sampled.
 *
 * `pageStatuses` lists only non-2xx pages: a 200 is implied by the signal's page
 * list, so a healthy site sends none. It is clipped first, to its own share, so a
 * site with thousands of redirects cannot crowd out the signal; when it has to be
 * clipped, 404/410 pages go first, since they are the ones that stale findings.
 * The signal gets the rest of the budget.
 */
export function buildPublishResolution(
  ruleResults: Record<string, { checks: CheckResult[] }>,
  pages: ReadonlyArray<{ url?: unknown; statusCode?: unknown }>,
  limits: { maxBytes: number; maxPageStatusBytes: number } = RESOLUTION_PUBLISH_LIMITS,
): PublishResolution {
  const crawled: string[] = [];
  let statuses: Array<{ url: string; status: number }> = [];
  for (const page of pages) {
    if (typeof page?.url !== "string") continue;
    crawled.push(page.url);
    const status = page.statusCode;
    if (typeof status === "number" && (status < 200 || status >= 300)) {
      statuses.push({ url: page.url, status });
    }
  }
  // The publish schema REJECTS (not clamps) a list over MAX_PAGES.
  statuses = statuses.slice(0, REPORT_LIMITS.maxPages);
  if (statuses.length > 0 && byteLength(JSON.stringify(statuses)) > limits.maxPageStatusBytes) {
    statuses = [
      ...statuses.filter((s) => REMOVED_PAGE_STATUSES.has(s.status)),
      ...statuses.filter((s) => !REMOVED_PAGE_STATUSES.has(s.status)),
    ];
    statuses = clipPageStatusesToBytes(
      { pageStatuses: statuses },
      limits.maxPageStatusBytes,
    ).pageStatuses!;
  }
  const statusBytes = statuses.length > 0 ? byteLength(JSON.stringify(statuses)) : 0;
  const signal = buildCompactResolutionSignal(ruleResults, crawled, limits.maxBytes - statusBytes);
  return {
    ...(statuses.length > 0 ? { pageStatuses: statuses } : {}),
    ...(signal ? { resolutionSignalCompact: signal } : {}),
  };
}
