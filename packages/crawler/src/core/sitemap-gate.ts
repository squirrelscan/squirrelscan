import type { FrontierRecord } from "../storage/types";

// Recompute the quick-mode discovery-gate counts from frontier rows on resume —
// they're runtime-only (default 0), which would wrongly re-enable discovery (#133).
export function sitemapGateFromFrontier(entries: FrontierRecord[]): {
  sitemapUrlCount: number;
  sitemapPendingCount: number;
} {
  let sitemapUrlCount = 0;
  let sitemapPendingCount = 0;
  for (const entry of entries) {
    if (entry.source !== "sitemap") continue;
    sitemapUrlCount++;
    // pending = passed robots/scope filtering (mirrors the fresh-start getPendingCount)
    if (entry.status !== "skipped") sitemapPendingCount++;
  }
  return { sitemapUrlCount, sitemapPendingCount };
}
