// Pure evaluator for the repo#2307 component-aware findings evaluation.
//
// Runs the REAL rules (a11y/link-text, content/stale-copyright) over a case's
// synthetic pages, then the REAL report grouping, and scores the result against
// the case's human labels. Shared by the test and by
// benchmarks/harness/component-findings-eval.ts. Nothing here writes files or
// reads the clock apart from the timings it returns.

import { parseHTML } from "@squirrelscan/parser/dom";

import { calculateHealthScore } from "../../../audit-engine/src/scoring";
import { componentFixRollups } from "../../../report/src/component-fix-rollup";
import { groupIssuesByCategory, type GroupedRule } from "../../../report/src/grouping";
import type { AuditReport, ReportRuleResult } from "../../../report/src/types";
import { linkTextRule } from "../../src/a11y/link-text";
import { staleCopyrightRule } from "../../src/content/stale-copyright";
import type { CheckResult, ParsedPage, Rule, RuleContext, RuleRunResult } from "../../src/types";
import {
  EVAL_CURRENT_YEAR,
  EVAL_ORIGIN,
  type EvalCase,
  type EvalLabel,
  type EvalRuleId,
} from "../fixtures/component-eval/cases";

export type EvalOrder = "forward" | "reversed" | "shuffled";

export const EVAL_RULES: Array<{ id: EvalRuleId; rule: Rule }> = [
  { id: "a11y/link-text", rule: linkTextRule },
  { id: "content/stale-copyright", rule: staleCopyrightRule },
];

/** A fixed-seed LCG (Numerical Recipes constants) so "shuffled" is the same shuffle every run. */
function shuffle<T>(items: T[], seed = 0x2307): T[] {
  const out = [...items];
  let state = seed;
  const next = () => {
    // 1664525 * 2^32 stays below 2^53, so this is exact.
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function orderPages<T>(pages: T[], order: EvalOrder): T[] {
  if (order === "reversed") return [...pages].reverse();
  if (order === "shuffled") return shuffle(pages);
  return [...pages];
}

export function pageUrl(path: string): string {
  return `${EVAL_ORIGIN}${path}`;
}

function pathOf(url: string): string {
  return url.startsWith(EVAL_ORIGIN) ? url.slice(EVAL_ORIGIN.length) : url;
}

/** Runs both rules over every page in `order`. Checks carry their pageUrl. */
export async function runCaseRules(
  evalCase: EvalCase,
  order: EvalOrder,
): Promise<{ checks: Record<EvalRuleId, CheckResult[]>; ruleMs: number; pagesRun: number }> {
  const checks: Record<EvalRuleId, CheckResult[]> = {
    "a11y/link-text": [],
    "content/stale-copyright": [],
  };
  let ruleMs = 0;
  let pagesRun = 0;
  for (const page of orderPages(evalCase.pages, order)) {
    pagesRun++;
    const url = pageUrl(page.path);
    const html = `<html><body>${page.html}</body></html>`;
    const { document } = parseHTML(html);
    for (const { id, rule } of EVAL_RULES) {
      const ctx: RuleContext = {
        page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
        parsed: { document } as unknown as ParsedPage,
        options: id === "content/stale-copyright" ? { current_year: EVAL_CURRENT_YEAR } : {},
      };
      const start = performance.now();
      const result = await rule.run(ctx);
      ruleMs += performance.now() - start;
      for (const check of result.checks)
        checks[id].push({ ...check, pageUrl: check.pageUrl ?? url });
    }
  }
  return { checks, ruleMs, pagesRun };
}

/** The same check as a report that predates component evidence would hold it. */
export function stripEvidence(check: CheckResult): CheckResult {
  const { componentOccurrences: _o, componentEvidence: _e, ...rest } = check;
  return rest as CheckResult;
}

export function ruleResults(
  checks: Record<EvalRuleId, CheckResult[]>,
  strip: boolean,
): Record<string, ReportRuleResult> {
  const out: Record<string, ReportRuleResult> = {};
  for (const { id, rule } of EVAL_RULES) {
    out[id] = {
      meta: rule.meta,
      checks: strip ? checks[id].map(stripEvidence) : checks[id],
    } as unknown as ReportRuleResult;
  }
  return out;
}

/** A minimal report around the rule results, enough for every text renderer. */
export function buildReport(
  evalCase: EvalCase,
  results: Record<string, ReportRuleResult>,
): AuditReport {
  const warnings = Object.values(results).reduce(
    (sum, rule) => sum + rule.checks.filter((c) => c.status === "warn").length,
    0,
  );
  return {
    baseUrl: EVAL_ORIGIN,
    timestamp: "2026-11-15T00:00:00.000Z",
    totalPages: evalCase.pages.length,
    passed: 0,
    warnings,
    failed: 0,
    ruleResults: results,
    healthScore: {
      overall: 80,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: warnings,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

export interface GroupSummary {
  id: string;
  ruleId: string;
  attribution: string;
  pages: string[];
  fixKeys: string[];
  /** Sorted `path|locator` of every member, for membership comparison. */
  members: string[];
}

export interface CaseResult {
  id: string;
  order: EvalOrder;
  pages: number;
  pagesWithDetections: number;
  observations: number;
  /** Non-pass checks per rule. */
  detections: Record<string, { checks: number; items: number }>;
  /** Warn/fail checks per rule as `[path, status, message, itemsJson]`, sorted. Compared to the case golden. */
  detectionRows: Partial<Record<string, Array<[string, string, string, string]>>>;
  /** The grouped message view (checks, counts, pages, items) is identical with and without evidence. */
  presentationOnly: boolean;
  healthScoreOn: number | null;
  healthScoreOff: number | null;
  /** Message groups (GroupedCheck) with evidence stripped. */
  beforeGroups: number;
  afterGroups: number;
  observedGroups: number;
  promotedGroups: number;
  rollups: number;
  /** Union of group pages, ungrouped observation pages and evidence-less detection pages. */
  affectedPages: number;
  coverageOk: boolean;
  incorrectMerges: number;
  missedMerges: number;
  /** Observations labelled expectObserved=false that landed in an observed group. */
  overclaims: number;
  /** Occurrences with no label, or labels no occurrence matched. */
  unlabeled: string[];
  unmatchedLabels: string[];
  /** One entry per page that has a detection but no observation or fallback. */
  pagesSkipped: string[];
  groups: GroupSummary[];
  rollupSummary: Array<{ level: string; variants: number; groupIds: string[]; pages: number }>;
  ruleMs: number;
  groupingMsOn: number;
  groupingMsOff: number;
}

function itemCount(check: CheckResult): number {
  return check.items?.length ?? 0;
}

/** A detection is a warn or fail. `skipped` and `pass` checks are not findings. */
function isDetection(check: CheckResult): boolean {
  return check.status === "warn" || check.status === "fail";
}

function detection(checks: CheckResult[]) {
  const hit = checks.filter(isDetection);
  return { checks: hit.length, items: hit.reduce((sum, c) => sum + itemCount(c), 0) };
}

/** Region-relative locators repeat inside a page, so the nesting disambiguates them. */
function labelKey(page: string, rule: string, locator: string, nestedIn = "none"): string {
  return `${page}|${rule}|${nestedIn}|${locator}`;
}

function bestMs<T>(repeats: number, fn: () => T): { ms: number; value: T } {
  let ms = Number.POSITIVE_INFINITY;
  let value!: T;
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    value = fn();
    ms = Math.min(ms, performance.now() - start);
  }
  return { ms, value };
}

function scoreOf(results: Record<string, ReportRuleResult>): number | null {
  const map = new Map<string, RuleRunResult>();
  for (const [id, result] of Object.entries(results)) {
    map.set(id, result as unknown as RuleRunResult);
  }
  return calculateHealthScore({ results: map }).overall;
}

export async function evaluateCase(
  evalCase: EvalCase,
  options: { order?: EvalOrder; repeats?: number } = {},
): Promise<CaseResult> {
  const order = options.order ?? "forward";
  const repeats = options.repeats ?? 1;
  const { checks, ruleMs } = await runCaseRules(evalCase, order);

  // "Evidence on" is what the rules emitted, unless the case is a legacy report.
  const on = ruleResults(checks, evalCase.legacy === true);
  const off = ruleResults(checks, true);

  const groupedOn = bestMs(repeats, () => groupIssuesByCategory(on));
  const groupedOff = bestMs(repeats, () => groupIssuesByCategory(off));
  const rulesOn = groupedOn.value.flatMap((category) => category.rules);
  const rulesOff = groupedOff.value.flatMap((category) => category.rules);

  const labels = new Map<string, EvalLabel>();
  for (const label of evalCase.labels) {
    labels.set(labelKey(label.page, label.rule, label.locator, label.nestedIn), label);
  }
  const used = new Set<string>();
  const unlabeled: string[] = [];
  const labelOf = (
    page: string,
    rule: string,
    locator: string,
    nestedIn: string,
  ): EvalLabel | undefined => {
    const key = labelKey(pathOf(page), rule, locator, nestedIn);
    const label = labels.get(key);
    if (label) used.add(key);
    return label;
  };

  // Observations are read from the checks the rules produced (never from a group).
  type Observation = {
    page: string;
    rule: string;
    locator: string;
    nestedIn: string;
    label?: EvalLabel;
    grouped: boolean;
  };
  const observations: Observation[] = [];
  if (!evalCase.legacy) {
    for (const { id } of EVAL_RULES) {
      for (const check of checks[id]) {
        for (const occurrence of check.componentOccurrences ?? []) {
          const nestedIn = occurrence.region.nestedIn;
          const label = labelOf(occurrence.pageUrl, id, occurrence.element.locator, nestedIn);
          if (!label) {
            unlabeled.push(
              labelKey(pathOf(occurrence.pageUrl), id, occurrence.element.locator, nestedIn),
            );
          }
          observations.push({
            page: pathOf(occurrence.pageUrl),
            rule: id,
            locator: occurrence.element.locator,
            nestedIn,
            label,
            grouped: false,
          });
        }
      }
    }
  }
  const observationAt = new Map(
    observations.map((o) => [labelKey(o.page, o.rule, o.locator, o.nestedIn), o]),
  );

  const groups: GroupSummary[] = [];
  const rawGroups: Array<{
    rule: GroupedRule;
    group: NonNullable<GroupedRule["componentFixGroups"]>[number];
  }> = [];
  for (const rule of rulesOn) {
    for (const group of rule.componentFixGroups ?? []) rawGroups.push({ rule, group });
  }
  let incorrectMerges = 0;
  let overclaims = 0;
  const groupOfObservation = new Map<string, { id: string; attribution: string }>();
  for (const { rule, group } of rawGroups) {
    const fixKeys = new Set<string>();
    const members: string[] = [];
    for (const occurrence of group.occurrences) {
      const path = pathOf(occurrence.pageUrl);
      const key = labelKey(path, rule.id, occurrence.element.locator, occurrence.region.nestedIn);
      members.push(key);
      const observation = observationAt.get(key);
      if (observation) {
        observation.grouped = true;
        groupOfObservation.set(key, { id: group.id, attribution: group.attribution });
        if (observation.label) fixKeys.add(observation.label.fixKey);
        if (
          group.attribution === "observed-component-evidence" &&
          observation.label?.expectObserved === false
        ) {
          overclaims++;
        }
      }
    }
    if (fixKeys.size > 1) incorrectMerges++;
    groups.push({
      id: group.id,
      ruleId: rule.id,
      attribution: group.attribution,
      pages: group.affectedPages.map(pathOf),
      fixKeys: [...fixKeys].sort(),
      members: members.sort(),
    });
  }

  // A shared-region defect is missed when its observations are not all in one
  // observed group (ungrouped observations count as their own bucket).
  const byFix = new Map<string, Observation[]>();
  for (const observation of observations) {
    if (!observation.label?.expectGrouped) continue;
    const list = byFix.get(observation.label.fixKey) ?? [];
    list.push(observation);
    byFix.set(observation.label.fixKey, list);
  }
  let missedMerges = 0;
  for (const list of byFix.values()) {
    const buckets = new Set(
      list.map((o) => {
        const hit = groupOfObservation.get(labelKey(o.page, o.rule, o.locator, o.nestedIn));
        return hit && hit.attribution === "observed-component-evidence" ? hit.id : "ungrouped";
      }),
    );
    if (buckets.size !== 1 || buckets.has("ungrouped")) missedMerges++;
  }

  // Coverage: every page with a detection is accounted for by a group, an
  // ungrouped observation, or (legacy / evidence-less) the check's own page.
  const detectionPages = new Set<string>();
  const coveredPages = new Set<string>();
  for (const group of groups) for (const page of group.pages) coveredPages.add(page);
  for (const observation of observations)
    if (!observation.grouped) coveredPages.add(observation.page);
  for (const { id } of EVAL_RULES) {
    for (const check of checks[id]) {
      if (!isDetection(check) || !check.pageUrl) continue;
      const page = pathOf(check.pageUrl);
      detectionPages.add(page);
      if (evalCase.legacy || (check.componentOccurrences?.length ?? 0) === 0)
        coveredPages.add(page);
    }
  }
  const pagesSkipped = [...detectionPages].filter((page) => !coveredPages.has(page)).sort();
  const coverageOk =
    pagesSkipped.length === 0 && [...coveredPages].every((page) => detectionPages.has(page));

  const detections: CaseResult["detections"] = {};
  const detectionRows: CaseResult["detectionRows"] = {};
  for (const { id } of EVAL_RULES) {
    detections[id] = detection(checks[id]);
    detectionRows[id] = checks[id]
      .filter(isDetection)
      .map((c): [string, string, string, string] => [
        pathOf(c.pageUrl ?? ""),
        c.status,
        c.message,
        JSON.stringify(c.items ?? null),
      ])
      .sort((x, y) => (x.join("\u0000") < y.join("\u0000") ? -1 : 1));
  }
  // The grouped message view must also be identical with and without evidence.
  const messages = (rules: GroupedRule[]) =>
    JSON.stringify(
      rules.map((rule) => ({
        id: rule.id,
        checks: rule.checks.map((c) => [c.name, c.status, c.message, c.count, c.pages, c.items]),
      })),
    );
  const presentationOnly = messages(rulesOn) === messages(rulesOff);

  const rollups = componentFixRollups(rawGroups.map((r) => r.group));
  return {
    id: evalCase.id,
    order,
    pages: evalCase.pages.length,
    pagesWithDetections: detectionPages.size,
    observations: observations.length,
    detections,
    detectionRows,
    presentationOnly,
    healthScoreOn: scoreOf(on),
    healthScoreOff: scoreOf(off),
    beforeGroups: rulesOff.reduce((sum, rule) => sum + rule.checks.length, 0),
    afterGroups: groups.length,
    observedGroups: groups.filter((g) => g.attribution === "observed-component-evidence").length,
    promotedGroups: groups.filter((g) => g.attribution === "repeated-subtree").length,
    rollups: rollups.length,
    affectedPages: coveredPages.size,
    coverageOk,
    incorrectMerges,
    missedMerges,
    overclaims,
    unlabeled,
    unmatchedLabels: evalCase.labels
      .map((l) => labelKey(l.page, l.rule, l.locator, l.nestedIn))
      .filter((key) => !used.has(key) && !evalCase.legacy),
    pagesSkipped,
    groups: groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    rollupSummary: rollups.map((r) => ({
      level: r.level,
      variants: r.variantCount,
      groupIds: r.groupIds,
      pages: r.affectedPageCount,
    })),
    ruleMs,
    groupingMsOn: groupedOn.ms,
    groupingMsOff: groupedOff.ms,
  };
}
