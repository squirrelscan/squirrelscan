// Shared helpers for the report-only "Domain stats" section (#111): formatting
// the backlink-summary + traffic + keyword headline numbers and building the
// one-line summary surfaced in every output format. Domain stats are
// informational — they NEVER affect the score.

import type { DomainStats, DomainStatsMetrics, DomainStatsPositions } from "./types";

/** Note rendered with the section so it reads as informational, not scored. */
export const DOMAIN_STATS_NOTE = "Domain SEO stats — informational, not scored.";

/**
 * Compact a count for display: 1234 → "1.2k", 1_500_000 → "1.5M". Whole numbers
 * under 1000 render as-is. Null → "—".
 */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 1_000) return String(Math.round(value));
  if (abs < 1_000_000) return `${trimZero(value / 1_000)}k`;
  if (abs < 1_000_000_000) return `${trimZero(value / 1_000_000)}M`;
  return `${trimZero(value / 1_000_000_000)}B`;
}

/** One decimal, trailing ".0" trimmed (1.0 → "1", 1.2 → "1.2"). */
function trimZero(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** USD amount, compacted ("$1.2k"). Null → "—". */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${formatCompact(value)}`;
}

export interface DomainStatLine {
  label: string;
  value: string;
}

/**
 * The headline metric rows for the section, in display order. Each is included
 * only when the metric is present so an empty field never renders a bare "—".
 */
export function domainStatRows(metrics: DomainStatsMetrics): DomainStatLine[] {
  const rows: DomainStatLine[] = [];
  const push = (label: string, value: number | null, fmt = formatCompact) => {
    if (value != null) rows.push({ label, value: fmt(value) });
  };
  push("Backlinks", metrics.backlinks);
  push("Ref. domains", metrics.referringDomains);
  push("Domain rank", metrics.rank, (v) => String(Math.round(v ?? 0)));
  push("Organic keywords", metrics.organicKeywords);
  push("Organic traffic", metrics.organicTraffic);
  push("Paid traffic", metrics.paidTraffic);
  push("Paid traffic cost", metrics.paidTrafficCost, formatUsd);
  return rows;
}

/**
 * A single one-line summary for compact formats (CLI footer, markdown, llm).
 * Picks the most meaningful few metrics that are present.
 */
export function buildDomainStatsSummary(stats: DomainStats): string {
  const m = stats.metrics;
  const parts: string[] = [];
  if (m.backlinks != null) parts.push(`${formatCompact(m.backlinks)} backlinks`);
  if (m.referringDomains != null)
    parts.push(`${formatCompact(m.referringDomains)} referring domains`);
  if (m.organicKeywords != null)
    parts.push(`${formatCompact(m.organicKeywords)} organic keywords`);
  if (m.organicTraffic != null)
    parts.push(`~${formatCompact(m.organicTraffic)} organic traffic/mo`);
  if (parts.length === 0) return `No domain stats available for ${stats.domain}.`;
  return `${stats.domain}: ${parts.join(" · ")}.`;
}

/** SERP position-band labels in display order, for the distribution sub-line. */
export const POSITION_BANDS: { key: keyof DomainStatsPositions; label: string }[] = [
  { key: "pos1", label: "#1" },
  { key: "pos2_3", label: "#2–3" },
  { key: "pos4_10", label: "#4–10" },
  { key: "pos11_20", label: "#11–20" },
  { key: "pos21_30", label: "#21–30" },
  { key: "pos31_40", label: "#31–40" },
  { key: "pos41_50", label: "#41–50" },
  { key: "pos51_60", label: "#51–60" },
  { key: "pos61_70", label: "#61–70" },
  { key: "pos71_80", label: "#71–80" },
  { key: "pos81_90", label: "#81–90" },
  { key: "pos91_100", label: "#91–100" },
];

/** Non-empty position bands as {label, count}, for the distribution display. */
export function positionBands(
  positions: DomainStatsPositions | null,
): { label: string; count: number }[] {
  if (!positions) return [];
  const out: { label: string; count: number }[] = [];
  for (const { key, label } of POSITION_BANDS) {
    const count = positions[key];
    if (count != null && count > 0) out.push({ label, count });
  }
  return out;
}

/** All position bands as {label, count} incl. zeros — fills out the distribution graph. */
export function allPositionBands(
  positions: DomainStatsPositions | null,
): { label: string; count: number }[] {
  if (!positions) return [];
  return POSITION_BANDS.map(({ key, label }) => ({ label, count: positions[key] ?? 0 }));
}
