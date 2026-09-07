// Resolving a requested page count against the hard cap, and saying so (#1909).
//
// `MAX_PAGES_CAP` was applied with a bare `Math.min` in three places — the
// `audit` command, the `crawl` command and the audit controller — and none of
// them said anything. `squirrel audit --max-pages 10000` crawled 5,000 and
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
 * three call sites did before this existed, so the ceiling behaves identically
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
  const asked = Number.isFinite(limit.requested)
    ? `${limit.requested.toLocaleString("en-US")} pages`
    : "unlimited pages";
  return (
    `⚠ Requested ${asked}, capped at ${limit.effective.toLocaleString("en-US")}. ` +
    `This is the hard limit; split the audit by section (e.g. [crawler] include) to scan more.`
  );
}
