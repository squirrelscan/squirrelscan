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

import { REPORT_LIMITS, RESOLUTION_PUBLISH_LIMITS, RESOLUTION_SIGNAL_LIMITS } from "./limits";

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
   * evaluated every crawled page (the common case).
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
}

/**
 * (#2658) The resolution signal as the publish producers send it now:
 * `AuditReport.resolutionSignalCompact`. The original `resolutionSignal` grew
 * with the crawl (raw URLs plus an 8-hex hash per failing page and check, about
 * 0.3KB a page: over 1 MiB from ~2,800 pages). This one carries the same
 * evidence in a fixed byte budget (RESOLUTION_PUBLISH_LIMITS).
 *
 * `data` is base64 of raw-deflated UTF-8 JSON, a {@link CompactResolutionPayload}.
 * {@link decodeResolutionSignal} turns it back into a {@link ResolutionSignal},
 * so the merge reads one shape whichever a producer sent.
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

const isStringArray = (value: unknown, max: number, maxLength: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((s) => typeof s === "string" && s.length <= maxLength);

/**
 * Inflate a {@link CompactResolutionSignal} back into the {@link ResolutionSignal}
 * the merge reads: `crawledUrls` are the listed pages, and every index becomes
 * the `resolutionUrlHash` of its URL, the value the original producer would
 * have sent. Validates as strictly as the publish schema validates the original
 * shape and THROWS on anything out of bounds; a caller that catches it should
 * drop the signal, which only ever costs resolutions (findings carry), never
 * causes one.
 *
 * Reads at most RESOLUTION_PUBLISH_LIMITS.maxInflatedBytes of inflated output.
 */
export async function decodeResolutionSignal(
  compact: CompactResolutionSignal,
): Promise<ResolutionSignal> {
  if (compact.v !== 1) throw new Error(`unknown compact resolution signal version ${compact.v}`);
  const json = await inflateCapped(compact.data, RESOLUTION_PUBLISH_LIMITS.maxInflatedBytes);
  const payload = JSON.parse(json) as Partial<CompactResolutionPayload>;
  const limits = RESOLUTION_SIGNAL_LIMITS;
  const maxKey = REPORT_LIMITS.maxMediumString;
  if (payload.v !== 1) throw new Error("compact resolution payload: bad version");
  if (!isStringArray(payload.urls, limits.maxCrawledUrls, REPORT_LIMITS.maxUrlLength)) {
    throw new Error("compact resolution payload: bad urls");
  }
  const other = payload.other ?? [];
  if (!isStringArray(other, limits.maxHashesTotal, REPORT_LIMITS.maxUrlLength)) {
    throw new Error("compact resolution payload: bad other");
  }
  if (typeof payload.complete !== "boolean") {
    throw new Error("compact resolution payload: bad complete");
  }
  const urls = payload.urls;
  const pages = payload.pages;
  // Bounded by the crawl ceiling: the merge counts it as audited pages, and
  // billing reads that count.
  if (
    typeof pages !== "number" ||
    !Number.isSafeInteger(pages) ||
    pages < urls.length ||
    pages > REPORT_LIMITS.maxPages ||
    // A complete list is every crawled page, deduped; `other` only rides with one.
    (payload.complete && pages !== urls.length)
  ) {
    throw new Error("compact resolution payload: bad pages");
  }
  if (!payload.complete && other.length > 0) {
    throw new Error("compact resolution payload: other with a partial list");
  }
  const truncated = payload.truncated ?? [];
  if (!isStringArray(truncated, limits.maxChecks, maxKey)) {
    throw new Error("compact resolution payload: bad truncated");
  }

  const hashes: string[] = [];
  const hashAt = (index: number): string =>
    (hashes[index] ??= resolutionUrlHash(
      index < urls.length ? urls[index]! : other[index - urls.length]!,
    ));
  const decodeMap = <T>(
    field: string,
    record: Record<string, number[]> | undefined,
    indexLimit: number,
    value: (index: number) => T,
  ): Record<string, T[]> => {
    if (record === undefined) return {};
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`compact resolution payload: bad ${field}`);
    }
    const entries = Object.entries(record);
    if (entries.length > limits.maxChecks)
      throw new Error(`compact resolution payload: ${field} keys`);
    const out: Record<string, T[]> = {};
    let total = 0;
    for (const [key, gaps] of entries) {
      if (key.length > maxKey || !Array.isArray(gaps) || gaps.length > limits.maxHashesPerCheck) {
        throw new Error(`compact resolution payload: bad ${field} entry`);
      }
      total += gaps.length;
      if (total > limits.maxHashesTotal)
        throw new Error(`compact resolution payload: ${field} size`);
      const set: T[] = [];
      let index = -1;
      for (const gap of gaps) {
        if (typeof gap !== "number" || !Number.isSafeInteger(gap) || gap < 0) {
          throw new Error(`compact resolution payload: bad ${field} index`);
        }
        index += gap + 1;
        if (index >= indexLimit)
          throw new Error(`compact resolution payload: ${field} index range`);
        set.push(value(index));
      }
      out[key] = set;
    }
    return out;
  };
  if (payload.failing === undefined) throw new Error("compact resolution payload: no failing");
  const failing = decodeMap("failing", payload.failing, urls.length + other.length, hashAt);
  const notEvaluated = decodeMap("notEvaluated", payload.notEvaluated, urls.length, hashAt);

  const removedByStatus = decodeMap("removed", payload.removed, urls.length, (i) => urls[i]!);
  const removedPages: Array<{ url: string; status: number }> = [];
  for (const [status, removedUrls] of Object.entries(removedByStatus)) {
    if (status !== "404" && status !== "410") {
      throw new Error("compact resolution payload: bad removed status");
    }
    for (const url of removedUrls) removedPages.push({ url, status: Number(status) });
  }
  const removedCount = payload.removedCount ?? 0;
  if (
    typeof removedCount !== "number" ||
    !Number.isSafeInteger(removedCount) ||
    removedCount < removedPages.length ||
    removedCount > pages ||
    (payload.complete && removedCount !== removedPages.length)
  ) {
    throw new Error("compact resolution payload: bad removedCount");
  }

  return {
    crawledUrls: urls,
    failing,
    ...(Object.keys(notEvaluated).length > 0 ? { notEvaluated } : {}),
    ...(truncated.length > 0 ? { truncated } : {}),
    ...(payload.complete ? {} : { crawledComplete: false, crawledCount: pages }),
    ...(removedPages.length > 0 ? { removedPages } : {}),
    ...(removedCount > 0 ? { removedCount } : {}),
  };
}

/**
 * base64 → raw inflate → UTF-8, reading no more than `maxBytes` of output. Web
 * streams only, so it runs unchanged in Workers, Bun and browsers.
 */
async function inflateCapped(base64: string, maxBytes: number): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`compact resolution signal inflates past ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
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
 * The runner's noindex gate (pub#457): a skip that is a "does not apply"
 * verdict for every check of its rule on that page, so the signal and the merge
 * read it as clean, not as a gap. Also the skip's `details.foldKey`.
 */
export const NOT_APPLICABLE_SKIP_REASON = "noindex";

/** Signal map key — same `ruleId|checkName` shape the merge core keys on. */
export function resolutionCheckKey(ruleId: string, checkName: string): string {
  return `${ruleId}|${checkName}`;
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
