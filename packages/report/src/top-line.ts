// The top line of a report: the four section scores and the page/check counts.
// One derivation for the published report (output/html.tsx) and the dashboard's
// overview and audit page, so a number cannot read differently in each.

import type { RuleGroup } from "./categories";
import { GROUP_CODES, getGroupName } from "./categories";
import { scanScopeUnfetched } from "./coverage";
import type { SitemapDiscovery } from "@squirrelscan/core-contracts";
import type { AuditReport, GroupScore } from "./types";

/** What the page counts read: any report-shaped object with these three fields. */
type PageCountSource = Pick<AuditReport, "totalPages" | "coverage" | "scanScope">;

/** A non-negative whole number off report JSON, or 0 (stored reports of any origin). */
export function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Pages the audit knows exist: every sitemap URL plus the crawled pages no
 * sitemap lists, or the crawled pages plus the in-scope URLs the crawl queued
 * but never fetched (`scanScope.unfetched`), whichever is larger. The links on
 * the pages still queued are unknown and sitemap intake is capped, so a capped
 * crawl's count is a floor.
 */
export function discoveredPages(report: PageCountSource): {
  total: number;
  sitemap: number;
  crawlOnly: number;
  unfetched: number;
} {
  // Written by the engine's report stream but not on the AuditReport type; read defensively.
  const sm = (
    report as PageCountSource & {
      sitemaps?: Partial<Pick<SitemapDiscovery, "totalUrls" | "missingPages">>;
    }
  ).sitemaps;
  const sitemap = count(sm?.totalUrls);
  const crawlOnly = Array.isArray(sm?.missingPages) ? sm.missingPages.length : 0;
  const unfetched = scanScopeUnfetched(report);
  const total = Math.max(
    count(report.totalPages),
    count(report.coverage?.knownPages),
    sitemap + crawlOnly,
    // Fetched and still-queued URLs are disjoint, so their sum is a floor too.
    count(report.scanScope?.pagesCrawled) + unfetched,
  );
  return { total, sitemap, crawlOnly, unfetched };
}

/** The discovered-pages count, with whether it is a floor ("N+") because the crawl was cut short. */
export function discoveredCount(report: PageCountSource): { total: number; floor: boolean } {
  const found = discoveredPages(report);
  const floor =
    (!!report.scanScope?.capped || report.scanScope?.stopReason === "time") &&
    found.total > count(report.totalPages);
  return { total: found.total, floor };
}

/** The counts row under the section scores: scanned / discovered / passed / warnings / failed. */
export interface ReportTopLineCounts {
  scanned: number;
  discovered: { total: number; floor: boolean };
  passed: number;
  warnings: number;
  failed: number;
}

export function reportTopLineCounts(report: AuditReport): ReportTopLineCounts {
  return {
    scanned: count(report.totalPages),
    discovered: discoveredCount(report),
    passed: count(report.passed),
    warnings: count(report.warnings),
    failed: count(report.failed),
  };
}

/** One section's score, with its error and warning counts. */
export interface SectionScoreRow {
  group: RuleGroup;
  name: string;
  score: number;
  failed: number;
  warnings: number;
}

/**
 * The section scores in the report's order (SEO, Performance, Security, Agents).
 * An older report with no `groups`, or a group code this build does not know,
 * yields fewer rows (possibly none), never a placeholder.
 */
export function sectionScoreRows(groups: readonly GroupScore[] | null | undefined): SectionScoreRow[] {
  const byGroup = new Map((groups ?? []).map((g) => [g.group, g]));
  const rows: SectionScoreRow[] = [];
  for (const code of GROUP_CODES) {
    const g = byGroup.get(code);
    if (!g || typeof g.score !== "number" || !Number.isFinite(g.score)) continue;
    rows.push({
      group: code,
      name: getGroupName(code),
      score: Math.round(g.score),
      failed: count(g.failed),
      warnings: count(g.warnings),
    });
  }
  return rows;
}
