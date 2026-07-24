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
   * "carry", hash-absent falls back to the #1167 sample guard.
   */
  truncated?: string[];
}

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
 * The accepted cost of 32 bits is over-carrying: at the 5,000-page crawl
 * ceiling the birthday odds of any collision are ~0.3%, and each one merely
 * keeps one finding open a cycle longer. If per-signal page counts ever grow
 * well past that ceiling, widen the hash rather than reasoning about the
 * collision rate — but note that changing it breaks producer/consumer parity,
 * so it needs the golden-value test updated and a server-before-CLI rollout.
 */
export function resolutionUrlHash(normalizedUrl: string): string {
  const bytes = new TextEncoder().encode(normalizedUrl);
  let h = FNV32_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, FNV32_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
