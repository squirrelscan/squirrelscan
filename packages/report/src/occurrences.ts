// Occurrence counting for folded aggregate checks (#910).

/**
 * Number of per-page checks a report check stands for. Over-cap per-rule check
 * arrays are folded client-side into one aggregate check per issue class
 * (rules' foldOverflowChecks, #910) carrying the folded count in
 * `details.occurrences`; plain checks count as 1. Consumers that count checks
 * (issue trackers, badges, rankings) must use this or a folded 600-page rule
 * reads as a single occurrence.
 */
export function checkOccurrences(check: { details?: Record<string, unknown> }): number {
  const folded = check.details?.occurrences;
  return typeof folded === "number" && Number.isFinite(folded) && folded > 1
    ? Math.floor(folded)
    : 1;
}
