// Why an overall score can sit below every section score. The overall applies two adjustments the
// section scores do not: an issue-density penalty computed on the whole audit's pooled issues, and a
// penalty for a missing or blocking robots.txt or a missing sitemap. Both are recorded by the engine in
// `healthScore.debug`; this reads them back, so every report format and the dashboard say the same thing.

import type { HealthScore } from "./types";

export interface ScoreAdjustment {
  /** The overall score as shown. */
  overall: number;
  /** The score before the site-wide adjustments (curved pass ratio). */
  before: number;
  /** How much of `before` the adjustments took, in whole percent (at least 1). */
  percent: number;
  /** The issue-density part is present. */
  issueDensity: boolean;
  /** The robots.txt / sitemap part is present. */
  crawlSetup: boolean;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The adjustment behind the overall score, or null when there is none to show: no overall (N/A), a report
 * that predates `debug`, or an adjustment under 1%. Partial runs carry no score, so none shows there.
 */
export function scoreAdjustment(
  score: Pick<HealthScore, "overall" | "debug" | "groups"> | null | undefined,
): ScoreAdjustment | null {
  const overall = score?.overall;
  const debug = score?.debug;
  // The sentence compares the overall with the section scores, so it needs sections to compare with.
  if (!finite(overall) || !debug || !finite(debug.curved) || !score?.groups?.length) return null;
  const before = Math.round(debug.curved);
  if (before <= 0 || before > 100 || overall >= before) return null;
  const percent = Math.round(((before - overall) / before) * 100);
  if (percent < 1) return null;
  const density = finite(debug.issuePenalty) ? Math.max(0, debug.issuePenalty) : 0;
  const total = finite(debug.penalties) ? Math.max(0, debug.penalties) : 0;
  return {
    overall,
    before,
    percent,
    issueDensity: density > 0 || (debug.issueDensity ?? 0) > 0,
    crawlSetup: total - density > 0,
  };
}

/** One sentence, the same in every format. */
export function scoreAdjustmentNote(adjustment: ScoreAdjustment): string {
  const causes = [
    adjustment.issueDensity ? "issue density across the whole audit" : null,
    adjustment.crawlSetup ? "robots.txt or sitemap problems" : null,
  ].filter((c): c is string => c !== null);
  const because = causes.length > 0 ? ` for ${causes.join(" and ")}` : "";
  return `Overall ${adjustment.overall}: ${adjustment.before} before a ${adjustment.percent}% site-wide adjustment${because}. Section scores use only their own checks.`;
}

/** The note for a report's health score, or null when there is nothing to explain. */
export function scoreAdjustmentNoteFor(
  score: Pick<HealthScore, "overall" | "debug" | "groups"> | null | undefined,
): string | null {
  const adjustment = scoreAdjustment(score);
  return adjustment ? scoreAdjustmentNote(adjustment) : null;
}
