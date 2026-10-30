// Publish-time unsampled resolution signal (#1185).
//
// #1167 publish sampling clips every check's `pages[]` to a fixed sample, so
// the server-side smart-audits merge can no longer tell "crawled clean" from
// "clipped out of the sample" — on >100-page sites, prior open findings on
// pages that are now clean carry forward forever and the density penalty
// ratchets the published score down with no way to recover. The publish
// payload therefore carries a COMPACT, UNSAMPLED per-run signal alongside the
// sampled `pages[]`: the crawled-URL list plus, per rule+check class, the set
// of pages (as URL hashes, not full check payloads) still failing/warning
// this run. The merge resolves any prior finding whose page was crawled this
// run and is absent from its check's failing set — regardless of sampling.
//
// #2658: that signal still grew with the crawl, so producers now send it
// deflated and indexed in a fixed byte budget ({@link CompactResolutionSignal});
// the server decodes it back to the same {@link ResolutionSignal}.

/**
 * The signal object attached to `AuditReport.resolutionSignal` by the publish
 * producers (CLI `slimForPublish`, worker-agent `truncateReportForPublish`)
 * BEFORE sampling runs, and consumed by the server merge. Transport-only:
 * never rendered, never feeds `healthScore` directly.
 */
export interface ResolutionSignal {
  /**
   * Raw URLs of every page crawled this run (from `report.pages`, which the
   * CLI drops at publish). Re-normalized server-side. Capped at
   * RESOLUTION_SIGNAL_LIMITS.maxCrawledUrls — pages past the cap simply fall
   * back to today's carry behavior.
   */
  crawledUrls: string[];
  /**
   * `${ruleId}|${checkName}` → hashes (resolutionUrlHash of the NORMALIZED
   * page URL) of every page failing/warning that check this run, UNSAMPLED.
   * A key is emitted for every page-scope check class that RAN this run
   * (including all-pass classes, as an empty array) — so on the server:
   *  - key present, hash present  → still failing (carry);
   *  - key present, hash absent   → crawled clean (resolve), unless the key is
   *    truncated or the page is listed in `notEvaluated` for it;
   *  - key ABSENT                 → check didn't run / unknown shape → no
   *    signal, fall back to pre-#1185 behavior (never resolve on absence).
   */
  failing: Record<string, string[]>;
  /**
   * `${ruleId}|${checkName}` → hashes of crawled pages that produced NO
   * evaluated (pass/warn/fail) result for that check this run: the rule
   * `skipped` them (perf/ttfb without timing data) or emitted no check for
   * them at all. Absence from `failing` is then NOT evidence of clean, so the
   * merge must not resolve these pages. Omitted entirely when every key
   * evaluated every crawled page (the common case). (#2688) With
   * `crawledHashes`, it names the unlisted pages a key did not evaluate too.
   */
  notEvaluated?: Record<string, string[]>;
  /**
   * Keys whose hash set is INCOMPLETE (the fold's page cap already clipped the
   * source pages, or the signal's own size budget dropped hashes). Absence
   * from a truncated set is non-authoritative: hash-present still means
   * "carry", hash-absent resolves only on positive evidence in the published
   * payload, a pass on that page (#2658; before it, the #1167 sample guard).
   */
  truncated?: string[];
  /**
   * (#2658) `false` when `crawledUrls` lists only PART of the crawl: the compact
   * signal's byte budget clipped it. `failing` and `notEvaluated` are then exact
   * for the listed pages only, so the merge takes the signal's word for a listed
   * page and, for every other one, resolves only on positive evidence in the
   * published payload, as for a truncated key. Never set by the original
   * producers, which marked every key truncated instead.
   */
  crawledComplete?: boolean;
  /** (#2658) Pages crawled, listed or not, when `crawledComplete` is false. */
  crawledCount?: number;
  /**
   * (#2658) Listed pages that returned 404 or 410 this run. `pageStatuses` is
   * clipped to its byte share, so this is where the merge learns of every
   * removed page it can name. Set by the compact decoder only.
   */
  removedPages?: Array<{ url: string; status: number }>;
  /**
   * (#2658) Pages that returned 404 or 410 this run, listed or not, so the
   * audited-page count can leave them out when the list is clipped. Set by the
   * compact decoder only, when there are any.
   */
  removedCount?: number;
  /**
   * (#2673) When `crawledComplete` is false: the `resolutionUrlHash` of every
   * crawled page the list leaves out, so the merge can tell an unlisted page
   * this run crawled from one it did not. Membership only: a page whose hash is
   * here was crawled, or collides with one that was. Set by the compact decoder
   * only, from a payload that carries them (producers since #2673). (#2688)
   * `notEvaluated` then covers these pages as well as the listed ones, so a key
   * that is present, not truncated and does not name a page's hash there
   * evaluated that page.
   */
  crawledHashes?: string[];
}

/**
 * (#2658) The resolution signal as the publish producers send it now:
 * `AuditReport.resolutionSignalCompact`. The original `resolutionSignal` grew
 * with the crawl (raw URLs plus an 8-hex hash per failing page and check, about
 * 0.3KB a page: over 1 MiB from ~2,800 pages). This one carries the same
 * evidence in a fixed byte budget (RESOLUTION_PUBLISH_LIMITS).
 *
 * `data` is base64 of raw-deflated UTF-8 JSON, a {@link CompactResolutionPayload}.
 * `decodeResolutionSignal` (`@squirrelscan/rules/resolution-decode`)
 * turns it back into a {@link ResolutionSignal}, so the merge reads one shape
 * whichever a producer sent.
 */
export interface CompactResolutionSignal {
  v: 1;
  data: string;
}

/**
 * The JSON inside {@link CompactResolutionSignal.data}. Page sets are indexes
 * into `urls` followed by `other`, sorted, written as gaps: the first index,
 * then each next one as `index - previous - 1` (a run of pages is a run of
 * zeros, which deflates to almost nothing).
 */
export interface CompactResolutionPayload {
  v: 1;
  /** Crawled pages, NORMALIZED, deduped, sorted. All of them when `complete`. */
  urls: string[];
  /**
   * Pages a failing set names that were not crawled (a check whose `pageUrl` is
   * not in the page list). Only when `complete`: with a partial list, failing
   * evidence is needed for listed pages only.
   */
  other?: string[];
  /** False when the byte budget clipped `urls` (see ResolutionSignal.crawledComplete). */
  complete: boolean;
  /** Pages crawled, listed or not. */
  pages: number;
  /** `ruleId|checkName` → gap-coded indexes of failing/warning pages. */
  failing: Record<string, number[]>;
  /** `ruleId|checkName` → gap-coded indexes (into `urls`) of crawled pages not evaluated. */
  notEvaluated?: Record<string, number[]>;
  /** Keys with incomplete sets, including keys the byte budget dropped. */
  truncated?: string[];
  /** HTTP status (`"404"`, `"410"`) → gap-coded indexes (into `urls`) of listed pages that returned it. */
  removed?: Record<string, number[]>;
  /** Pages that returned 404 or 410, listed or not. Omitted when none did. */
  removedCount?: number;
  /**
   * (#2673) Only when not `complete`: the 8-hex `resolutionUrlHash` of each
   * distinct crawled page `urls` leaves out, sorted and concatenated into one
   * string (about 5.7 bytes a page once deflated, where a list of strings costs
   * 7). Absent when there are none.
   */
  hashes?: string;
  /**
   * (#2688) Only with `hashes`: `ruleId|checkName` → gap-coded indexes (into the
   * 8-hex values of `hashes`) of unlisted pages the check did not evaluate, the
   * unlisted half of `notEvaluated`. A hash two unlisted pages share is named
   * when either was not evaluated. The two maps share `notEvaluated`'s count
   * caps: a key past them is listed in `truncated` instead.
   */
  hashesNotEvaluated?: Record<string, number[]>;
}

/** Sorted, distinct indexes → gap code (see {@link CompactResolutionPayload}). */
export function encodeIndexGaps(sortedIndexes: readonly number[]): number[] {
  const gaps: number[] = [];
  let previous = -1;
  for (const index of sortedIndexes) {
    gaps.push(index - previous - 1);
    previous = index;
  }
  return gaps;
}


/**
 * `skipReason` of a page check whose rule stopped at a work cap before it had
 * looked at the whole page and found nothing in the part it did look at
 * (pub#501): `content/hidden-text`, `content/dev-leakage`. A pass there would be
 * evaluation evidence and resolve a prior finding that may sit past the cap, so
 * the rule skips instead, and the signal lists the page as not evaluated. Also
 * the skip's `details.foldKey`, so a fold keeps it apart from the rule's other
 * skips.
 */
export const SCAN_TRUNCATED_SKIP_REASON = "scan-truncated";

/**
 * `skipReason` of the `<rule>-error` check of a rule abandoned for its time
 * budget (pub#960). The rule did not finish on that page, so nothing was found
 * there: a not-evaluated state, never a failed finding. A skip that is neither a
 * verdict nor a registered gap, so the resolution signal lists the page as not
 * evaluated for the checks the rule did emit elsewhere and a prior finding on
 * it is carried, not resolved.
 */
export const RULE_TIMED_OUT_SKIP_REASON = "rule-timed-out";

/**
 * The runner's noindex gate (pub#457): a skip that is a "does not apply"
 * verdict for every check of its rule on that page, so the signal and the merge
 * read it as clean, not as a gap. Also the skip's `details.foldKey`.
 */
export const NOT_APPLICABLE_SKIP_REASON = "noindex";

/**
 * The runner's page-type gate (pub#841): a contact or legal page is short by nature, so a rule
 * that declares `skipOnPageType` is skipped on it. Like the noindex gate it is a "does not apply"
 * verdict for EVERY check of the rule on that page, and it names the rule, not a check, so it is
 * keyed by rule in the resolution signal. Also the skip's `details.foldKey`.
 */
export const PAGE_TYPE_SKIP_REASON = "page-type";

/** Whether a skip reason is a rule-wide "does not apply" verdict (the noindex and page-type gates). */
export function isRuleNotApplicableReason(reason: string | undefined): boolean {
  return reason === NOT_APPLICABLE_SKIP_REASON || reason === PAGE_TYPE_SKIP_REASON;
}

/**
 * A check that does not apply to THIS page: nothing for it to look at (no images,
 * no form fields, no body, no `Link` header, a page below the minimum size, a
 * `<picture>`-less page, a URL with no extension). Unlike a gap (`scan-truncated`,
 * a timeout, no timing data), it is not "the check did not run": the signal and
 * the merge read the page as evaluated and clean for that check, so a prior
 * finding of it on the page resolves instead of carrying forever (pub#1011).
 * Also the skip's `details.foldKey`, so a fold never mixes it with a gap.
 */
export const CHECK_NOT_APPLICABLE_SKIP_REASON = "not-applicable";

/**
 * Suffix of a check that reports what its rule could not settle on a page:
 * `<check>-unconfirmed` (pub#921). A rule emits it IN PLACE of `<check>` for
 * the controls a style may hide, so the row is evaluation evidence for
 * `<check>` too: the rule evaluated `<check>` on that page and found nothing it
 * could confirm. The signal counts the page as evaluated for `<check>`
 * (pub#935), so the previous audit's `<check>` fail there resolves instead of
 * being carried forever beside the new unconfirmed row. A page the rule
 * reported neither for is still not evaluated.
 */
export const UNCONFIRMED_CHECK_SUFFIX = "-unconfirmed";

/** Signal map key — same `ruleId|checkName` shape the merge core keys on. */
export function resolutionCheckKey(ruleId: string, checkName: string): string {
  return `${ruleId}|${checkName}`;
}

/**
 * Check-name half of a rule-wide `notEvaluated` key (pub#968): `<ruleId>|*`
 * lists the crawled pages on which the rule as a whole did not run (it timed
 * out), whatever checks it would have emitted there. A timed-out rule emits no
 * check under its real names, so without it a rule that timed out on every page
 * has no key at all, and the merge reads that as "no signal" and resolves its
 * prior findings. Only ever in `notEvaluated` (and `truncated`), never in
 * `failing`. A consumer from before it does not know the key and ignores it,
 * which is today's behaviour.
 */
export const RESOLUTION_ANY_CHECK = "*";

/** The rule-wide key (see {@link RESOLUTION_ANY_CHECK}). */
export function resolutionRuleKey(ruleId: string): string {
  return resolutionCheckKey(ruleId, RESOLUTION_ANY_CHECK);
}

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over the NORMALIZED page URL, 8 hex chars. Portable (no
 * node:crypto — Workers-safe, sync) like `findingFingerprint`, and pinned by a
 * golden-value test so producer (CLI/container) and consumer (API Worker)
 * can't drift.
 *
 * 32 bits is deliberate: every collision resolves in the CONSERVATIVE
 * direction. A clean page colliding with a failing page's entry over-CARRIES,
 * and a clean page colliding with a `notEvaluated` entry likewise carries. A
 * wrong RESOLVE is impossible: a failing page's own hash is always in its
 * check's set, and an unevaluated page's own hash is always in `notEvaluated`
 * — which is why the builder computes that complement over normalized URLs
 * rather than over hashes (see rules/src/resolution.ts).
 *
 * The accepted cost of 32 bits is over-carrying: at the 10,000-page crawl
 * ceiling (#1028, was 5,000) the birthday odds of any collision in one signal
 * are ~1.2% (they were ~0.3% at 5,000 — the rate is quadratic in page count),
 * and each one merely keeps one finding open a cycle longer. That is still the
 * right trade at this size: the cost of a collision is bounded and benign,
 * while widening the hash breaks producer/consumer parity and needs the
 * golden-value test updated plus a server-before-CLI rollout. Revisit if the
 * ceiling moves again — at 50,000 pages the odds pass 25%.
 */
export function resolutionUrlHash(normalizedUrl: string): string {
  const bytes = new TextEncoder().encode(normalizedUrl);
  let h = FNV32_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, FNV32_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
