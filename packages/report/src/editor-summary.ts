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
  EditorSummary,
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

/**
 * Coerce a cloud editor-summary response body into the report-stored shape, or
 * null when the body is unusable.
 *
 * The cloud client CASTS its JSON to the declared response type without
 * validating it. That is additive-safe (an unknown extra field is harmless) but
 * not subtractive-safe: a 2xx body missing `prose` still types as `string` while
 * being `undefined` at runtime, and the failure then lands far from the fetch,
 * inside a renderer, after the crawl has already been paid for. Callers treat
 * null exactly like a 5xx: no editor-summary section, never a throw.
 *
 * `prose` IS the section, so a missing or blank one rejects the whole body; the
 * remaining fields are decorative and are defaulted rather than rejected.
 */
export function toEditorSummary(res: unknown): EditorSummary | null {
  if (!res || typeof res !== "object") return null;
  const r = res as Partial<Record<keyof EditorSummary, unknown>>;
  if (typeof r.prose !== "string" || r.prose.trim() === "") return null;
  return {
    prose: r.prose,
    bigTicket: Array.isArray(r.bigTicket)
      ? r.bigTicket.filter((item): item is string => typeof item === "string")
      : [],
    verdict: typeof r.verdict === "string" ? r.verdict : "",
    model: typeof r.model === "string" ? r.model : "",
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
  };
}

/** The already-validated slice every output format renders. */
export interface EditorSummaryView {
  /** Prose split on blank lines, trimmed, empties dropped; never empty. */
  paragraphs: string[];
  bigTicket: string[];
  verdict: string;
  model: string;
}

/**
 * Renderer-side guard: normalize a report's stored editor summary into what the
 * output formats need, or null when there is nothing safe to render.
 *
 * Every format goes through here so that none of them dereferences `prose` (or
 * `bigTicket`) directly. Reports are persisted and re-rendered later, so a
 * report stored before the fetch-side guard existed can still carry a malformed
 * summary: the guard has to live at render time too, not only at fetch time.
 */
export function editorSummaryView(
  es: EditorSummary | undefined | null,
): EditorSummaryView | null {
  const summary = toEditorSummary(es);
  if (!summary) return null;
  return {
    paragraphs: summary.prose
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean),
    bigTicket: summary.bigTicket,
    verdict: summary.verdict,
    model: summary.model,
  };
}
