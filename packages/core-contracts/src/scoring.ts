// Canonical score → color/grade thresholds. SINGLE SOURCE OF TRUTH for every
// surface that visualizes a 0-100 audit score: the published HTML report,
// dashboard score circles + category bars, the website nav switcher, CLI
// terminal output, and audit-complete emails. Re-exported by
// @squirrelscan/report and @squirrelscan/audit-engine — do not redefine these
// boundaries or colors anywhere else.
//
// Dependency-free on purpose: this file has no runtime imports, so even
// packages that only depend on core-contracts for its types can import
// `./scoring` without pulling in typebox/effect.

import type { RuleGroup } from "./index";

/** Inclusive lower bound for each color band. */
export const SCORE_THRESHOLDS = {
  /** >= good → green */
  good: 90,
  /** >= fair (and < good) → amber */
  fair: 70,
} as const;

/** Band colors (hex). Shared by every visual surface. */
export const SCORE_COLORS = {
  good: "#22c55e", // green
  fair: "#f59e0b", // amber
  poor: "#ef4444", // red
  none: "#9ca3af", // gray — no score yet
} as const;

export type ScoreBand = "good" | "fair" | "poor";

export function getScoreBand(score: number): ScoreBand {
  if (score >= SCORE_THRESHOLDS.good) return "good";
  if (score >= SCORE_THRESHOLDS.fair) return "fair";
  return "poor";
}

/** Score → band color (hex). Use for every score bar/dot/circle/number fill. */
export function getScoreColor(score: number): string {
  return SCORE_COLORS[getScoreBand(score)];
}

/** Score → letter grade. Finer-grained than color bands (A/B/C/D/F). */
export function getScoreGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** Accent set for one rule group: base hue + tint variants for labels/badges. */
export interface GroupColor {
  /** Base accent — icons, fills, decorative strokes. */
  base: string;
  /** Darkened text variant, readable at small sizes on cream/tinted backgrounds. */
  text: string;
  /** 10% tint — label/badge background. */
  bg: string;
  /** 25% tint — label/badge border. */
  border: string;
}

/**
 * Per-group brand accents for the 4 top-level rule groups (#626). Same hues as
 * @squirrelscan/ui Badge's green/orange/blue/purple color classes — keep them
 * aligned. Used by the published report's group labels, the UI kit's
 * GroupBadge, and any surface that color-codes audit categories by group.
 * oklch strings: fine in browsers, NOT supported by satori OG images (use
 * SCORE_COLORS hex there).
 */
export const GROUP_COLORS: Record<RuleGroup, GroupColor> = {
  seo: {
    base: "oklch(0.52 0.12 145)", // green (= --primary)
    text: "oklch(0.40 0.12 145)",
    bg: "oklch(0.52 0.12 145 / 0.1)",
    border: "oklch(0.52 0.12 145 / 0.25)",
  },
  performance: {
    base: "oklch(0.62 0.14 45)", // orange (= --accent)
    text: "oklch(0.50 0.14 45)",
    bg: "oklch(0.62 0.14 45 / 0.1)",
    border: "oklch(0.62 0.14 45 / 0.25)",
  },
  security: {
    base: "oklch(0.50 0.15 260)", // blue
    text: "oklch(0.40 0.15 260)",
    bg: "oklch(0.50 0.15 260 / 0.1)",
    border: "oklch(0.50 0.15 260 / 0.25)",
  },
  ai: {
    base: "oklch(0.55 0.15 300)", // purple
    text: "oklch(0.45 0.15 300)",
    bg: "oklch(0.55 0.15 300 / 0.1)",
    border: "oklch(0.55 0.15 300 / 0.25)",
  },
};

const GROUP_COLOR_FALLBACK: GroupColor = {
  base: "#9ca3af",
  text: "#6b7280",
  bg: "rgba(156, 163, 175, 0.1)",
  border: "rgba(156, 163, 175, 0.25)",
};

/** Group code → accent set; unknown codes fall back to neutral gray. */
export function getGroupColor(group: string): GroupColor {
  return GROUP_COLORS[group as RuleGroup] ?? GROUP_COLOR_FALLBACK;
}
