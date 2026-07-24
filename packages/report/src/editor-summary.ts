// Shared helpers for the report-only "Editor's summary" section: building the
// pre-aggregated request digest the cloud editor-summary service consumes, and
// the presentation note rendered above the summary in every output format.
//
// The digest is intentionally slim — category scores + a ranked, capped set of
// the highest-impact issues — so the request stays small and the model gets a
// focused view of THIS audit (never the full report). Mirrors how the CLI builds
// other cloud-service payloads.

import type {
  AuditReport,
  EditorSummaryCategoryInput,
  EditorSummaryIssueInput,
  EditorSummaryRequest,
  EditorSummarySiteProfile,
  SiteMetadata,
} from "@squirrelscan/core-contracts";
import { SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import { normalizeCategoryCode } from "./categories";
import { checkOccurrences } from "./occurrences";

/** Note rendered above the summary so it reads as informational, not scored. */
export const EDITOR_SUMMARY_NOTE = "Auto-generated editor's summary — informational, not scored.";

/** Map the resolved site-metadata profile to the slim summary-framing slice. */
function toSiteProfile(meta: SiteMetadata): EditorSummarySiteProfile {
  return {
    siteType: meta.siteType,
    businessCategory: meta.businessCategory ?? null,
    audienceScope: meta.audienceScope ?? null,
    primaryCountry: meta.primaryCountry ?? null,
    entityName: meta.entityName ?? null,
    isYMYL: meta.isYMYL,
    isLocalBusiness: meta.isLocalBusiness,
  };
}

/**
 * Severity rank for issue ordering (errors before warnings). Mirrors the
 * error(0)/info(1)/warning(2) ranking in grouping.ts's RULE_SEVERITY_RANK for
 * consistency, though `info` never appears here — buildTopIssues only ever
 * produces "error" or "warning" (see EditorSummaryIssueInput).
 */
const SEVERITY_RANK = { error: 0, info: 1, warning: 2 } as const;

/**
 * Build the slim, ranked top-issues list from the report's rule results. Each
 * failing/warning check becomes one entry; entries are ranked by severity, then
 * rule weight (score impact), then occurrence count, and capped.
 */
function buildTopIssues(report: AuditReport, max: number): EditorSummaryIssueInput[] {
  const issues: EditorSummaryIssueInput[] = [];
  for (const [ruleId, rr] of Object.entries(report.ruleResults)) {
    let occurrences = 0;
    let hasFail = false;
    let hasWarn = false;
    for (const check of rr.checks) {
      // Folded aggregates (#910) stand in for details.occurrences checks.
      if (check.status === "fail") {
        hasFail = true;
        occurrences += checkOccurrences(check);
      } else if (check.status === "warn") {
        hasWarn = true;
        occurrences += checkOccurrences(check);
      }
    }
    if (!hasFail && !hasWarn) continue;
    issues.push({
      ruleId,
      title: rr.meta.name,
      category: normalizeCategoryCode(rr.meta.category),
      severity: hasFail ? "error" : "warning",
      weight: rr.meta.weight,
      ...(occurrences > 0 ? { occurrences } : {}),
    });
  }

  issues.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (b.occurrences ?? 0) - (a.occurrences ?? 0);
  });

  return issues.slice(0, max);
}

/** Build the per-category score lines (worst first), capped. */
function buildCategories(report: AuditReport, max: number): EditorSummaryCategoryInput[] {
  const cats = report.healthScore?.categories ?? [];
  return cats
    .map((c) => ({
      category: c.category,
      name: c.name,
      score: c.score,
      failed: c.failed,
      warnings: c.warnings,
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, max);
}

export interface BuildEditorSummaryRequestOptions {
  auditId?: string;
  websiteId?: string;
  /** Deltas vs the previous audit, when the caller has a prior run. */
  delta?: EditorSummaryRequest["delta"];
}

/**
 * Build the editor-summary cloud-service request from a completed audit report.
 * Pure + deterministic — no I/O. The site profile is included only when the
 * report carries resolved site-metadata.
 */
export function buildEditorSummaryRequest(
  report: AuditReport,
  opts: BuildEditorSummaryRequestOptions = {},
): EditorSummaryRequest {
  return {
    ...(opts.auditId ? { auditId: opts.auditId } : {}),
    ...(opts.websiteId ? { websiteId: opts.websiteId } : {}),
    url: report.baseUrl,
    healthScore: report.healthScore?.overall ?? null,
    totalPages: report.totalPages,
    passed: report.passed,
    warnings: report.warnings,
    failed: report.failed,
    categories: buildCategories(report, SERVICE_LIMITS.editorSummaryMaxCategories),
    topIssues: buildTopIssues(report, SERVICE_LIMITS.editorSummaryMaxIssues),
    ...(opts.delta ? { delta: opts.delta } : {}),
    ...(report.siteMetadata ? { siteProfile: toSiteProfile(report.siteMetadata) } : {}),
  };
}
