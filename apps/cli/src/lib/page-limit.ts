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
 * A non-finite or non-positive request is passed through untouched rather than
 * coerced: the commands reject those with their own message naming the flag,
 * and silently turning `NaN` into the cap here would hide that.
 */
export function resolvePageLimit(requested: number): PageLimit {
  if (!Number.isFinite(requested) || requested < 1) {
    return { requested, effective: requested, clamped: false };
  }
  const effective = Math.min(requested, MAX_PAGES_CAP);
  return { requested, effective, clamped: effective < requested };
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
  return (
    `⚠ Requested ${limit.requested.toLocaleString("en-US")} pages, capped at ` +
    `${limit.effective.toLocaleString("en-US")}. This is the hard limit; split the audit ` +
    `by section (e.g. [crawler] include) to scan more.`
  );
}
