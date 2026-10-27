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
  EditorSummaryCoverageInput,
  EditorSummaryIssueInput,
  EditorSummaryNotCheckedInput,
  EditorSummaryPriority,
  EditorSummaryRequest,
  EditorSummarySiteProfile,
  EditorSummaryTechnologyInput,
  SiteMetadata,
} from "@squirrelscan/core-contracts";
import { clampItemString } from "@squirrelscan/core-contracts/clamp";
import { REPORT_LIMITS, SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import { normalizeCategoryCode } from "./categories";
import { notCheckedRules } from "./not-checked";
import { checkOccurrences } from "./occurrences";
import { scanScopeUnfetched } from "./coverage";
import { guardSummaryText, stripOutOf100 } from "./summary-text";

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
    // A capped published report (repo#2656) keeps at most `classesPerRule` issue
    // classes per rule, and counts only the rest: their checks are gone from
    // `ruleResults`, but the true counts survive in `checkTallies`. The digest
    // counts from them too, so it matches the one built from the full report. A
    // tally leaves out the warnings of an info-severity rule, so it can only raise
    // the count the kept classes give, never lower it.
    const tally = report.detail?.capped === true ? report.checkTallies?.[ruleId] : undefined;
    if (tally) {
      let tallied = 0;
      for (const t of Object.values(tally)) {
        const failed = t.failed ?? 0;
        const warned = t.warnings ?? 0;
        if (failed > 0) hasFail = true;
        if (warned > 0) hasWarn = true;
        tallied += failed + warned;
      }
      occurrences = Math.max(occurrences, tallied);
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

/**
 * Checks this audit did not run (repo#2729), so the summary can say a Quick or
 * offline audit did not check links instead of calling the site clean.
 */
function buildNotChecked(report: AuditReport): EditorSummaryNotCheckedInput[] {
  return notCheckedRules(report).map((r) => ({ ruleId: r.ruleId, title: r.name, reason: r.reason }));
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

/** Per-field bound on technology and rule id strings sent to the summary. */
const EDITOR_SUMMARY_FIELD_MAX = 128;

/**
 * The detected stack, so action points can name the platform, plugin or setting.
 * Only the fields the summary needs; capped.
 */
function buildTechnologies(report: AuditReport, max: number): EditorSummaryTechnologyInput[] {
  // Site-derived values (a version string, a detector label): clamped so one
  // long value cannot push the request past the server's field bounds.
  const short = (value: string) => clampItemString(value, EDITOR_SUMMARY_FIELD_MAX);
  return (report.technologies?.items ?? []).slice(0, max).map((t) => ({
    id: short(t.id),
    name: short(t.name),
    category: short(t.category),
    version: t.version ? short(t.version) : null,
    ...(t.detectedBy ? { detectedBy: short(t.detectedBy) } : {}),
  }));
}

/** Every rule that failed or warned, not just the ranked top issues; capped. */
function buildFailingRuleIds(report: AuditReport, max: number): string[] {
  const ids: string[] = [];
  for (const [ruleId, rr] of Object.entries(report.ruleResults)) {
    if (rr.checks.some((c) => c.status === "fail" || c.status === "warn")) {
      ids.push(clampItemString(ruleId, EDITOR_SUMMARY_FIELD_MAX));
    }
    if (ids.length >= max) break;
  }
  return ids;
}

/** A count the engine wrote, or undefined when absent or not a whole non-negative number. */
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/**
 * The audit's coverage facts, copied from the report (never estimated), or
 * undefined when the report has no scan scope to read them from.
 */
function buildCoverage(report: AuditReport): EditorSummaryCoverageInput | undefined {
  const scope = report.scanScope;
  const scannedPages = count(scope?.pagesCrawled);
  if (!scope || scannedPages === undefined) return undefined;
  const maxPages = count(scope.maxPages);
  const knownPages = count(report.coverage?.knownPages);
  // A rate-limited run's count already includes the URLs still queued; any
  // other run that stopped short has only those (`scanScope.unfetched`).
  const unfetchedPages = count(report.rateLimited?.unfetched) ?? count(scope.unfetched);
  return {
    scannedPages,
    ...(maxPages !== undefined ? { maxPages } : {}),
    capped: scope.capped === true,
    timeStopped: scope.stopReason === "time",
    ...(knownPages !== undefined ? { knownPages } : {}),
    ...(unfetchedPages !== undefined ? { unfetchedPages } : {}),
  };
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
  const notChecked = buildNotChecked(report);
  const technologies = buildTechnologies(report, SERVICE_LIMITS.editorSummaryMaxTechnologies);
  const failingRuleIds = buildFailingRuleIds(report, SERVICE_LIMITS.editorSummaryMaxFailingRuleIds);
  const coverage = buildCoverage(report);
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
    ...(notChecked.length > 0 ? { notChecked } : {}),
    ...(technologies.length > 0 ? { technologies } : {}),
    ...(failingRuleIds.length > 0 ? { failingRuleIds } : {}),
    ...(coverage ? { coverage } : {}),
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
  const priorities = toPriorities(r.priorities);
  return {
    prose: r.prose,
    bigTicket: Array.isArray(r.bigTicket)
      ? r.bigTicket.filter((item): item is string => typeof item === "string")
      : [],
    verdict: typeof r.verdict === "string" ? r.verdict : "",
    model: typeof r.model === "string" ? r.model : "",
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
    ...(priorities.length > 0 ? { priorities } : {}),
  };
}

const EFFORTS = new Set<EditorSummaryPriority["effort"]>(["quick-win", "moderate", "significant"]);
/** Most ids kept per priority list (rule ids, technology ids). */
const MAX_PRIORITY_IDS = 20;

const stringIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, MAX_PRIORITY_IDS)
        .map((id) => clampItemString(id, REPORT_LIMITS.maxShortString))
    : [];

/**
 * Ranked priorities from a response or a stored report, or [] when absent.
 * Same posture as the rest of the summary: model-authored and only cast, so an
 * entry without a title or action is dropped, text is clamped, and the list is
 * capped. An unknown effort reads as "moderate".
 */
function toPriorities(value: unknown): EditorSummaryPriority[] {
  if (!Array.isArray(value)) return [];
  const out: EditorSummaryPriority[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const p = item as Partial<Record<keyof EditorSummaryPriority, unknown>>;
    if (typeof p.title !== "string" || p.title.trim() === "") continue;
    if (typeof p.action !== "string" || p.action.trim() === "") continue;
    out.push({
      title: clampItemString(p.title.replace(/\s+/g, " ").trim(), REPORT_LIMITS.maxShortString),
      why: typeof p.why === "string" ? clampItemString(p.why, REPORT_LIMITS.maxMediumString) : "",
      action: clampItemString(p.action, REPORT_LIMITS.maxMediumString),
      effort: EFFORTS.has(p.effort as EditorSummaryPriority["effort"])
        ? (p.effort as EditorSummaryPriority["effort"])
        : "moderate",
      ruleIds: stringIds(p.ruleIds),
      technologies: stringIds(p.technologies),
    });
    if (out.length >= SERVICE_LIMITS.editorSummaryMaxPriorities) break;
  }
  return out;
}

function guardedSummary(summary: EditorSummary, report: AuditReport): EditorSummary {
  const text = guardSummaryText(
    { prose: summary.prose, verdict: summary.verdict },
    { allowedPageCounts: summaryPageCounts(report), fallbackProse: fallbackProse(report) },
  );
  return {
    ...summary,
    prose: text.prose,
    verdict: text.verdict,
    bigTicket: summary.bigTicket.map(stripOutOf100),
    ...(summary.priorities
      ? {
          priorities: summary.priorities.map((p) => ({
            ...p,
            why: stripOutOf100(p.why),
            action: stripOutOf100(p.action),
          })),
        }
      : {}),
  };
}

/** Display label for a priority's effort. */
export function priorityEffortLabel(effort: EditorSummaryPriority["effort"]): string {
  return effort === "quick-win" ? "Quick win" : effort === "significant" ? "Significant" : "Moderate";
}

/**
 * The validated summary every output format renders, plus the paragraph split
 * they all used to do for themselves. The raw fields ride along so the formats
 * that persist the summary verbatim (json) go through this same guard instead
 * of a second one.
 */
export interface EditorSummaryView extends EditorSummary {
  /** Prose split on blank lines, trimmed, empties dropped; never empty. */
  paragraphs: string[];
  /**
   * Validated ranked priorities; [] when the summary has none. A format shows
   * these as its own "Priorities" section and drops the big-ticket list (the
   * server derives `bigTicket` from them), or shows `bigTicket` when empty.
   */
  priorities: EditorSummaryPriority[];
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
/**
 * Page counts this report states: the totals, the scan scope and coverage
 * counts, and each failing rule's occurrence count (what the summary's digest
 * was built from). A page count in the summary that is none of these was
 * invented by the model.
 */
export function summaryPageCounts(report: AuditReport): number[] {
  const unfetched = scanScopeUnfetched(report);
  const counts: Array<number | undefined> = [
    report.totalPages,
    report.scanScope?.pagesCrawled,
    report.scanScope?.maxPages,
    report.coverage?.knownPages,
    report.coverage?.auditedPages,
    report.rateLimited?.pages,
    report.rateLimited?.unfetched,
    // The URLs a capped crawl left queued (the digest's "found but not
    // fetched"), and the discovered total the report shows beside them.
    ...(unfetched > 0 ? [unfetched, (report.scanScope?.pagesCrawled ?? 0) + unfetched] : []),
    ...buildTopIssues(report, Number.POSITIVE_INFINITY).map((i) => i.occurrences),
  ];
  return counts.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0);
}

/** The summary prose when no model sentence survives the text rules. */
function fallbackProse(report: AuditReport): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return `This audit found ${n(report.failed, "failing check", "failing checks")} and ${n(report.warnings, "warning", "warnings")} across ${n(report.totalPages, "page", "pages")}.`;
}

/**
 * The summary as every format shows it. With the report, the text rules apply
 * (`guardSummaryText`): at most one numeric score and no "/100", and no page
 * count the report does not state, so older stored summaries read the same as
 * new ones. Without it (a caller with only the summary), the text is as stored.
 */
export function editorSummaryView(
  es: EditorSummary | undefined | null,
  report?: AuditReport,
): EditorSummaryView | null {
  const stored = toEditorSummary(es);
  if (!stored) return null;
  const summary = report ? guardedSummary(stored, report) : stored;
  return {
    ...summary,
    paragraphs: summary.prose
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean),
    priorities: summary.priorities ?? [],
  };
}
