// Resolving a requested page count against the hard cap, and saying so (#1909).
//
// `MAX_PAGES_CAP` was applied with a bare `Math.min` in five places — the
// `audit` and `crawl` commands, the audit controller and twice in the crawl
// controller — and none of them said anything. `squirrel audit --max-pages 10000` crawled 5,000 and
// reported `maxPages: 5000`, which is indistinguishable from a 5,000-page site.
// The neighbouring notice in cli/format.ts fires when a crawl REACHES the cap,
// so a request for 10,000 against a 4,000-page site was clamped and never
// mentioned at all.
//
// One place to do it, so the three callers cannot drift, and so the requested
// value survives the clamp far enough to reach the report.

import { MAX_PAGES_CAP } from "@squirrelscan/core-contracts/limits";

export interface PageLimit {
  /** What the caller asked for, from `--max-pages` or `[crawler] max_pages`. */
  readonly requested: number;
  /** What will actually be crawled: `requested`, or the cap. */
  readonly effective: number;
  /** The cap bound. */
  readonly clamped: boolean;
}

/**
 * Resolve a requested page count against the cap.
 *
 * `effective` is exactly `Math.min(requested, MAX_PAGES_CAP)`, which is what the
 * five call sites did before this existed, so the ceiling behaves identically
 * for every input including the strange ones. An earlier version of this
 * returned non-finite and non-positive requests UNTOUCHED, on the reasoning
 * that the commands reject them with their own message — but `[crawler]
 * max_pages = inf` passes the config schema and never reaches that check, so
 * `Infinity` went straight to the crawler and the hard cap stopped being hard.
 * A safety bound does not get to have exceptions for inputs that look invalid.
 *
 * `clamped` is the narrower question of whether to SAY anything, so it is false
 * for `NaN` (which no comparison makes true) and for anything at or under the
 * cap. `Infinity` does get a notice: it really was clamped.
 */
export function resolvePageLimit(requested: number): PageLimit {
  return {
    requested,
    effective: Math.min(requested, MAX_PAGES_CAP),
    clamped: requested > MAX_PAGES_CAP,
  };
}

/**
 * The line to print when the cap bound, or null when it did not.
 *
 * Deliberately does not name `--max-pages`: the same clamp applies to
 * `[crawler] max_pages`, and a notice that names the flag would be wrong for
 * half the ways of reaching it.
 */
export function pageLimitNotice(limit: PageLimit): string | null {
  if (!limit.clamped) return null;
  // `Infinity.toLocaleString()` is "∞", which reads as a rendering fault rather
  // than as what the user typed.
  // A fractional request is degenerate but reachable through config, and
  // `(5000.0001).toLocaleString()` is "5,000" — which would print "Requested
  // 5,000 pages, capped at 5,000" and read as a bug in the notice rather than
  // in the config. Non-integers keep their digits.
  const asked = !Number.isFinite(limit.requested)
    ? "unlimited pages"
    : Number.isInteger(limit.requested)
      ? `${limit.requested.toLocaleString("en-US")} pages`
      : `${limit.requested} pages`;
  return (
    `⚠ Requested ${asked}, capped at ${limit.effective.toLocaleString("en-US")}. ` +
    `This is the hard limit; split the audit by section (e.g. [crawler] include) to scan more.`
  );
}
