// Detaching retained values from the page they came from (#1860).

import { logger } from "./adapter-logger";

/** Where a detach happened, so a fallback can name the boundary that failed. */
export type DetachBoundary = "page-rules" | "collected-signal";

export interface DetachCounts {
  /** Values copied free of their page. */
  readonly detached: number;
  /** Values kept ATTACHED because the copy threw — the retention is still there. */
  readonly fallbacks: number;
}

const counts = new Map<DetachBoundary, { detached: number; fallbacks: number }>();
/** Log the first few fallbacks per boundary; a broken page shape would hit every page. */
const MAX_LOGGED_FALLBACKS = 3;

function bump(boundary: DetachBoundary, key: "detached" | "fallbacks"): number {
  const row = counts.get(boundary) ?? { detached: 0, fallbacks: 0 };
  row[key] += 1;
  counts.set(boundary, row);
  return row[key];
}

/**
 * Copy a per-page value so it stops referencing the page it came from (#1860).
 *
 * Every string a rule pulls out of a parsed page — an href, an anchor's text, a
 * matched secret — is produced by slicing the page's HTML, and JSC keeps those
 * slices attached to the buffer they came from. Retaining ONE of them retains
 * the whole page as UTF-16. Measured on a real 959 KB page: the collected
 * signal is about 1 KB of actual data and holds 3.8 MB.
 *
 * That is invisible in every obvious measure. `JSON.stringify(signal).length`
 * says 1 KB, `process.memoryUsage().rss` says nothing at all because the arena
 * absorbs it, and it only appears in `heapUsed`/`external` — which is why a
 * production run at 149 pages held ~8 MB per page while a local census of the
 * same structures reported 96 KB.
 *
 * `structuredClone` is what detaches them: it serializes, so every string comes
 * out fresh, and unlike a JSON round-trip it preserves the `Set`s in
 * `PageFingerprint` rather than silently turning them into `{}`. Measured on the
 * same fixture, the collected signal goes from 3841 KB to 322 KB per page with
 * identical values and identical types.
 *
 * Applied only where a value OUTLIVES its batch. Inside a batch the page is
 * resident anyway and a copy would be pure cost.
 */
export function detachFromPage<T>(value: T, boundary: DetachBoundary): T {
  try {
    const copy = structuredClone(value);
    bump(boundary, "detached");
    return copy;
  } catch (error) {
    // A value carrying something non-cloneable (a function, a DOM node) would
    // throw. Keeping the original is the safe answer: it costs the retention
    // this exists to avoid, but it cannot change what the audit reports.
    //
    // It is all-or-nothing per call, so ONE offending finding restores
    // page-sized retention for every page that carries it, with identical
    // findings and green golden tests. That is exactly the failure this counter
    // exists to make visible; `detachCounts` is asserted zero over a real
    // rule-runner graph in tests/detach-from-page.test.ts.
    const seen = bump(boundary, "fallbacks");
    if (seen <= MAX_LOGGED_FALLBACKS) {
      // The error's TYPE only — its message can quote the offending value, and
      // that value is page content.
      const kind = error instanceof Error ? error.name : typeof error;
      logger.warn(
        `detach fallback at ${boundary} (${kind}): this page stays attached to its HTML (#1860)`,
      );
    }
    return value;
  }
}

/** Per-boundary detach/fallback counts for the current process. */
export function detachCounts(boundary: DetachBoundary): DetachCounts {
  return counts.get(boundary) ?? { detached: 0, fallbacks: 0 };
}

/** Test seam: counts are process-wide, so a test that asserts on them starts here. */
export function resetDetachCounts(): void {
  counts.clear();
}
