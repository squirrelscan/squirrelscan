// Coverage-mode resolution for the audit command.
//
// The CLI `--coverage`/`-C` flag is a free string (citty has no enum), so an
// unknown value like `fast` used to flow through a lying `as CoverageMode` cast
// and make the page-budget lookup `undefined` → a NaN cap → an unbounded crawl
// (every `pages.length >= NaN` check is false). Normalize + validate here.

import {
  COVERAGE_FULL_MAX_PAGES,
  COVERAGE_QUICK_MAX_PAGES,
  COVERAGE_SURFACE_MAX_PAGES,
} from "@/constants";

export const COVERAGE_MODES = ["quick", "surface", "full"] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];

/**
 * Normalize a raw coverage value to a canonical {@link CoverageMode}, or `null`
 * if it isn't a valid mode. Case-insensitive, whitespace-trimmed; `"fast"` is a
 * friendly alias for `"quick"` (the fastest mode).
 */
export function normalizeCoverageMode(raw: string): CoverageMode | null {
  const value = raw.trim().toLowerCase();
  const aliased = value === "fast" ? "quick" : value;
  return (COVERAGE_MODES as readonly string[]).includes(aliased)
    ? (aliased as CoverageMode)
    : null;
}

// Default when no --coverage flag/config: any signed-in plan (free OR paid) →
// surface (cloud rules + summary, pro-parity demo #684); anonymous → quick.
export function defaultCoverageMode(
  accountPlan: "anonymous" | "free" | "paid"
): CoverageMode {
  return accountPlan === "anonymous" ? "quick" : "surface";
}

// Default for smart audits (#684) when config doesn't set `smart_audits`: ON
// for any evidence of an account, OFF only for true anonymous. The finding
// store is local SQLite and needs no cloud, so an auth hiccup must not flip it
// off between runs (union scoring would make scores jump): "unreachable" keeps
// the signed-in default via the coverage plan collapse, and an EXPIRED token
// still proves an account exists.
export function defaultSmartAudits(
  accountPlan: "anonymous" | "free" | "paid",
  cloudOutage: "expired" | "unreachable" | null
): boolean {
  return accountPlan !== "anonymous" || cloudOutage !== null;
}

/** Default page budget for a coverage mode. */
export function coverageMaxPages(mode: CoverageMode): number {
  return {
    quick: COVERAGE_QUICK_MAX_PAGES,
    surface: COVERAGE_SURFACE_MAX_PAGES,
    full: COVERAGE_FULL_MAX_PAGES,
  }[mode];
}
