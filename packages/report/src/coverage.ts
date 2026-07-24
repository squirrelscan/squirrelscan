// Smart audits (#110) — coverage line + carried-finding provenance helpers.
// Shared across CLI console + report renderers. No-op when `smart_audits` is
// off (the report carries no `coverage` and no carried checks).

import type { AuditReport, CheckItem } from "./types";
import type { GroupedCheck } from "./grouping";
import { checkAffectedPages } from "./affected-pages";

/**
 * One-line coverage summary, e.g.
 *   "Coverage: audited 10 of 100 known pages (90 issues carried forward)."
 * Returns null when smart audits did not run (no `coverage` on the report).
 */
export function coverageLine(report: AuditReport): string | null {
  const c = report.coverage;
  if (!c) return null;
  const carried =
    c.carriedFindings > 0
      ? ` (${c.carriedFindings} finding${c.carriedFindings === 1 ? "" : "s"} carried forward)`
      : "";
  return `Coverage: audited ${c.auditedPages} of ${c.knownPages} known page${c.knownPages === 1 ? "" : "s"}${carried}.`;
}

/**
 * One-line scan scope summary (#1180), e.g.
 *   "Scan: 100 pages crawled from the CLI v0.0.76 (page limit 100 reached)."
 * Returns null for pre-#1180 reports (no `scanScope`).
 */
export function scanScopeLine(report: AuditReport): string | null {
  const s = report.scanScope;
  if (!s) return null;
  const origin = s.origin === "cloud" ? "squirrelscan cloud" : s.origin === "ci" ? "CI" : "the CLI";
  const version = report.generatorVersion ? ` v${report.generatorVersion}` : "";
  const cap =
    s.maxPages !== undefined
      ? s.capped
        ? ` (page limit ${s.maxPages} reached)`
        : ` (page limit ${s.maxPages})`
      : "";
  return `Scan: ${s.pagesCrawled} page${s.pagesCrawled === 1 ? "" : "s"} crawled from ${origin}${version}${cap}.`;
}

/**
 * Full-scan hint (#1180): shown when the score does not rest on a full fresh
 * crawl — either the page limit stopped the crawl (`scanScope.capped`) or the
 * smart-audit union carried pages not re-checked this run. Returns null when
 * the scan was complete.
 */
export function fullScanHint(report: AuditReport): string | null {
  const s = report.scanScope;
  const c = report.coverage;
  const capped = s?.capped ?? false;
  const partialUnion = c ? c.auditedPages < c.knownPages : false;
  if (!capped && !partialUnion) return null;
  // Remediation copy branches by origin: --max-pages is a CLI flag; a cloud
  // audit's page budget lives in the website settings / audit trigger.
  const cloud = s?.origin === "cloud";
  if (partialUnion && c) {
    const target = c.knownPages > (s?.maxPages ?? 0) ? String(c.knownPages) : null;
    const remedy = cloud
      ? "Raise the audit page limit and re-run"
      : `Re-run with ${target ? `--max-pages ${target}` : "a higher --max-pages"}`;
    return `Partial scan: ${c.auditedPages} of ${c.knownPages} known pages were re-checked this run; the score carries earlier results for the rest. ${remedy} for a fully fresh full-site score.`;
  }
  const remedy = cloud ? "Raise the audit page limit" : "Raise --max-pages";
  return `Partial scan: the page limit stopped the crawl, so the site may have more pages than this score covers. ${remedy} for a full-site score.`;
}

/**
 * One-line render-block recovery note (#512), e.g.
 *   "3 pages recovered via direct fetch after a render block."
 * Returns null when nothing was recovered (no `fetchFallbacks` on the report).
 */
export function fetchFallbacksLine(report: AuditReport): string | null {
  const recovered = report.fetchFallbacks?.recovered ?? 0;
  if (recovered <= 0) return null;
  return `${recovered} page${recovered === 1 ? "" : "s"} recovered via direct fetch after a render block.`;
}

/** Approximate "N days/hours ago" from an epoch-ms timestamp. */
export function timeAgo(epochMs: number, now: number = Date.now()): string {
  const deltaMs = Math.max(0, now - epochMs);
  const days = Math.floor(deltaMs / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return "recently";
}

/**
 * Provenance tag for a grouped check, e.g. "(carried — last seen 3 days ago)".
 * Returns "" when the check is fresh (not carried). Only fully-carried checks
 * (every merged instance carried) are tagged.
 */
export function carriedTag(check: GroupedCheck, now: number = Date.now()): string {
  if (!check.carriedCount || check.carriedCount < check.count) return "";
  const seen =
    check.lastSeenAt !== undefined ? ` — last seen ${timeAgo(check.lastSeenAt, now)}` : "";
  return ` (carried${seen})`;
}

/**
 * Full-sentence label for a check row (#1135), e.g.
 *   "Not re-checked this run — last verified 3 days ago."
 * Returns null unless every merged instance of the check was carried
 * (partial-carry checks get {@link ruleCarriedRollupLine} instead, at the
 * rule level, since a check-level "N of M" would repeat the rule rollup).
 */
export function checkCarriedLabel(check: GroupedCheck, now: number = Date.now()): string | null {
  if (!check.carriedCount || check.carriedCount < check.count) return null;
  const seen = check.lastSeenAt !== undefined ? ` — last verified ${timeAgo(check.lastSeenAt, now)}` : "";
  return `Not re-checked this run${seen}.`;
}

/**
 * Per-rule carried-pages rollup (#1135), e.g.
 *   "28 of 103 pages carried from previous crawls."
 * Returns null when nothing is carried, or when EVERY affected page is
 * carried (the rule-level "carried" state is obvious without a fraction).
 */
export function ruleCarriedRollupLine(carriedPages: number, totalPages: number): string | null {
  if (carriedPages <= 0 || totalPages <= 0 || carriedPages >= totalPages) return null;
  return `${carriedPages} of ${totalPages} page${totalPages === 1 ? "" : "s"} carried from previous crawls.`;
}

/** The 5 fields {@link ruleMixedProvenanceNote} reads off a raw check. */
export interface MixedProvenanceCheck {
  status: string;
  pageUrl?: string;
  pages?: string[];
  items?: CheckItem[];
  provenance?: string;
}

/**
 * Per-rule "fixed on all pages checked this run; N pages pending re-check"
 * note (#1135). Fires when a rule has a FRESH pass on at least one page AND a
 * CARRIED warn/fail on at least one page, with no FRESH warn/fail anywhere —
 * i.e. every page re-checked this run came back clean, but the rule still
 * shows red only because of pages the crawl didn't revisit. Must read every
 * status (pass included), not just fail/warn.
 *
 * SINGLE shared implementation (#1135 codex review) — both
 * `packages/report`'s grouping.ts (feeds the cloud HTML/markdown/LLM
 * renderers) and `apps/api`'s run-report.ts (feeds the MCP/agent-runs AND
 * dashboard report summaries) call this instead of maintaining their own
 * copy, so the two can't silently drift the way #1135's own provenance data
 * once did between those two report-summary builders.
 *
 * A page can be BOTH a fresh pass (one check under the rule) and a carried
 * issue (a different check under the same rule) — e.g. one check-name passes
 * on page X fresh while another check-name has a carried warn on the same
 * page. Such a page isn't actually clean, so it's excluded from the "checked
 * clean" count (only counted toward "pending re-check"); the two counts in
 * the rendered message are always disjoint.
 */
export function ruleMixedProvenanceNote(
  checks: ReadonlyArray<MixedProvenanceCheck>,
): string | undefined {
  const freshPassPages = new Set<string>();
  const carriedIssuePages = new Set<string>();
  const freshIssuePages = new Set<string>();
  for (const check of checks) {
    const pages = checkAffectedPages({ pages: check.pages, items: check.items });
    if (check.pageUrl) pages.add(check.pageUrl);
    if (pages.size === 0) continue;
    const isCarried = check.provenance === "carried";
    if (check.status === "pass") {
      if (!isCarried) for (const p of pages) freshPassPages.add(p);
    } else if (check.status === "warn" || check.status === "fail") {
      if (isCarried) for (const p of pages) carriedIssuePages.add(p);
      else for (const p of pages) freshIssuePages.add(p);
    }
  }
  // Disjoint the two buckets: a page counted as a carried issue can't also
  // count toward "checked clean", even if some other check passed it fresh.
  const trulyClean = [...freshPassPages].filter((p) => !carriedIssuePages.has(p)).length;
  if (trulyClean === 0 || carriedIssuePages.size === 0 || freshIssuePages.size > 0) {
    return undefined;
  }
  const pending = carriedIssuePages.size;
  return `Fixed on all ${trulyClean} page${trulyClean === 1 ? "" : "s"} checked this run; ${pending} page${pending === 1 ? "" : "s"} pending re-check.`;
}
