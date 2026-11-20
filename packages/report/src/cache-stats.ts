// Shared presentation helpers for the report-only "Cache" stats section (#108),
// rendered across all output formats. Cache stats are informational: they
// NEVER affect the score (mirrors site-metadata.ts / technologies.ts).

import type { CacheFreshness, CacheHitReason, CacheStats } from "./types";
import { formatBytes } from "./utils";

/** Human label per hit reason, in the order we display them. */
const REASON_LABELS: Record<CacheHitReason, string> = {
  "max-age": "max-age",
  "s-maxage": "s-maxage",
  expires: "Expires",
  immutable: "immutable",
  "304": "304 Not Modified",
  hash_match: "content-hash match",
  "stale-while-revalidate": "stale-while-revalidate",
};

const REASON_ORDER: CacheHitReason[] = [
  "max-age",
  "s-maxage",
  "expires",
  "immutable",
  "304",
  "hash_match",
  "stale-while-revalidate",
];

export const CACHE_STATS_NOTE =
  "Cache reuse vs the previous crawl (informational: not part of the score).";

/** hits / total as a 0–100 integer percentage. */
export function cacheHitRatePercent(stats: CacheStats): number {
  return Math.round((stats.hitRate ?? 0) * 100);
}

/**
 * One-line cache summary for the text/markdown SUMMARY block, e.g.
 * "Cache: 12/40 hits (30%), 1.2 MB saved".
 */
export function cacheStatsSummaryLine(stats: CacheStats): string {
  return `Cache: ${stats.hits}/${stats.total} hits (${cacheHitRatePercent(stats)}%), ${formatBytes(stats.bytesSaved)} saved`;
}

/** Ordered, non-zero reason rows for breakdown rendering. */
export function cacheReasonRows(
  stats: CacheStats
): Array<{ reason: CacheHitReason; label: string; count: number }> {
  const rows: Array<{ reason: CacheHitReason; label: string; count: number }> =
    [];
  for (const reason of REASON_ORDER) {
    const count = stats.hitsByReason[reason] ?? 0;
    if (count > 0) rows.push({ reason, label: REASON_LABELS[reason], count });
  }
  return rows;
}

/**
 * Canonical "by reason" breakdown string, shared by text + markdown reports so
 * the separator stays consistent, e.g. "max-age: 2, s-maxage: 2". Empty when no
 * reasons recorded.
 */
export function cacheReasonsLabel(stats: CacheStats): string {
  return cacheReasonRows(stats)
    .map((r) => `${r.label}: ${r.count}`)
    .join(", ");
}

/**
 * Plain lines for the fresh-fetch note (#2032), shared by the text and markdown reports. Empty
 * when there is no note. Informational, never part of the score.
 */
export function cacheFreshnessLines(note: CacheFreshness): string[] {
  const lines: string[] = [];
  if (note.noCache) {
    lines.push("Fetched with Cache-Control: no-cache.");
    if (note.stalePageCount === 0) {
      lines.push("No page response looked cached.");
    } else {
      lines.push(
        `${note.stalePageCount} page${note.stalePageCount === 1 ? "" : "s"} still looked cached (stale-cache note): the audit may describe a copy from before the deploy.`
      );
      for (const p of note.stalePages) lines.push(`  ${p.url} (${p.signal})`);
      if (note.stalePageCount > note.stalePages.length) {
        lines.push(`  ...and ${note.stalePageCount - note.stalePages.length} more`);
      }
    }
  }
  if (note.freshRender) {
    lines.push("Pages were rendered fresh, without the render cache.");
  }
  return lines;
}

export { formatBytes };
