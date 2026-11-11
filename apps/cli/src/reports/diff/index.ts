import { LINK_COVERAGE_DETAIL_KEYS } from "@squirrelscan/core-contracts";
import {
  buildSupersededIndex,
  judgeSuperseded,
  splitSuccessor,
  successorListsLocator,
  resolutionCheckKey,
  type SupersededOutcome,
} from "@squirrelscan/core-contracts/resolution";
import { skipReasonClass } from "@squirrelscan/core-contracts/rule-outcome";
import { ruleRuns, type RuleRun } from "@squirrelscan/report";
import { loadAllRules, type RuleCheckDecl } from "@squirrelscan/rules";

import type { SeverityLevel } from "@/reports/filters";
import type {
  AuditReport,
  CheckItem,
  CheckResult,
  ReportRuleResult,
} from "@/types";

import { getScoreGrade } from "@/audit/scoring";
import { CHECK_NAME_ROBOTS_EXISTS, RULE_ID_ROBOTS_TXT } from "@/constants";

import type {
  DiffChange,
  DiffChangeType,
  DiffOptions,
  DiffReport,
  DiffSide,
  IssueInstance,
  NotComparedIssue,
} from "./types";

import {
  fingerprintForIssue,
  normalizeTargetId,
  type IssueTargetType,
} from "./fingerprint";

// Missing robots.txt used to be reported as a "warn" check; reports scored
// before #1535 still carry that status in storage. Normalize it to "fail"
// here so diffing an old report against a re-audit of the same still-missing
// robots.txt doesn't read as a false regression (or an improvement, in the
// other diff direction).
function normalizeLegacyCheckStatus(
  ruleId: string,
  check: CheckResult
): CheckResult {
  if (
    ruleId === RULE_ID_ROBOTS_TXT &&
    check.name === CHECK_NAME_ROBOTS_EXISTS &&
    check.status === "warn"
  ) {
    return { ...check, status: "fail" };
  }
  return check;
}

function shouldIncludeCheck(
  check: CheckResult,
  severity?: SeverityLevel
): check is CheckResult & { status: "fail" | "warn" } {
  if (check.status !== "fail" && check.status !== "warn") return false;
  if (!severity || severity === "all") return true;
  if (severity === "error") return check.status === "fail";
  return check.status === "warn";
}

// What links/broken-links covered (pub#794) describes the audit, not any one
// broken link: left out of each issue's meta, or a change in coverage would
// mark every broken link as changed.
function issueDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out = { ...details };
  for (const key of LINK_COVERAGE_DETAIL_KEYS) delete out[key];
  // The page a header rule read its headers from (#1778) describes the audit, not the finding: an audit from
  // before it names none, and the first diff across the upgrade must read the same finding as unchanged.
  delete out.pageUrl;
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildMeta(
  check: CheckResult,
  item?: CheckItem
): Record<string, unknown> | undefined {
  const details = issueDetails(check.details);
  if (item?.meta && details) {
    return { ...details, ...item.meta };
  }
  return item?.meta ?? details ?? undefined;
}

function buildIssueInstance(
  report: AuditReport,
  ruleId: string,
  rule: ReportRuleResult,
  check: CheckResult,
  targetType: IssueTargetType,
  targetIdRaw: string,
  targetLabel?: string,
  sourcePages?: string[],
  meta?: Record<string, unknown>
): IssueInstance {
  const targetId = normalizeTargetId(targetIdRaw, report.baseUrl);
  const fingerprint = fingerprintForIssue(
    ruleId,
    check.name,
    targetType,
    targetId
  );

  return {
    fingerprint,
    ruleId,
    ruleName: rule.meta.name,
    category: rule.meta.category,
    severity: rule.meta.severity,
    weight: rule.meta.weight,
    checkName: check.name,
    status: check.status as "fail" | "warn",
    message: check.message,
    target: {
      type: targetType,
      id: targetId,
      label: targetLabel,
    },
    sourcePages,
    meta,
  };
}

export function buildIssueInstances(
  report: AuditReport,
  severity?: SeverityLevel
): IssueInstance[] {
  const instances: IssueInstance[] = [];
  const ruleEntries: Array<[string, ReportRuleResult]> =
    report.ruleResults instanceof Map
      ? Array.from(report.ruleResults.entries())
      : Object.entries(report.ruleResults);

  for (const [ruleId, rule] of ruleEntries) {
    for (const rawCheck of rule.checks) {
      const check = normalizeLegacyCheckStatus(ruleId, rawCheck);
      if (!shouldIncludeCheck(check, severity)) continue;

      if (check.items && check.items.length > 0) {
        for (const item of check.items) {
          instances.push(
            buildIssueInstance(
              report,
              ruleId,
              rule,
              check,
              "item",
              item.id,
              item.label,
              item.sourcePages,
              buildMeta(check, item)
            )
          );
        }
        continue;
      }

      if (check.pages && check.pages.length > 0) {
        for (const page of check.pages) {
          instances.push(
            buildIssueInstance(
              report,
              ruleId,
              rule,
              check,
              "page",
              page,
              undefined,
              undefined,
              buildMeta(check)
            )
          );
        }
        continue;
      }

      if (check.pageUrl) {
        instances.push(
          buildIssueInstance(
            report,
            ruleId,
            rule,
            check,
            "page",
            check.pageUrl,
            undefined,
            undefined,
            buildMeta(check)
          )
        );
        continue;
      }

      instances.push(
        buildIssueInstance(
          report,
          ruleId,
          rule,
          check,
          "check",
          check.name,
          undefined,
          undefined,
          buildMeta(check)
        )
      );
    }
  }

  return instances;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    );
    return `{${entries
      .map(([k, v]) => `${k}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return String(value);
}

function issuesDiffer(a: IssueInstance, b: IssueInstance): boolean {
  if (a.status !== b.status) return true;
  if (a.message !== b.message) return true;
  return stableStringify(a.meta) !== stableStringify(b.meta);
}

function changeTypeFor(
  before: IssueInstance,
  after: IssueInstance
): DiffChangeType {
  if (before.status === "warn" && after.status === "fail") return "regression";
  if (before.status === "fail" && after.status === "warn") return "improvement";
  return "change";
}

function sortIssues(issues: IssueInstance[]): IssueInstance[] {
  const severityRank: Record<string, number> = {
    error: 3,
    warning: 2,
    info: 1,
  };

  return [...issues].sort((a, b) => {
    const sevDiff =
      (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const weightDiff = b.weight - a.weight;
    if (weightDiff !== 0) return weightDiff;
    const ruleDiff = a.ruleId.localeCompare(b.ruleId);
    if (ruleDiff !== 0) return ruleDiff;
    const checkDiff = a.checkName.localeCompare(b.checkName);
    if (checkDiff !== 0) return checkDiff;
    return a.target.id.localeCompare(b.target.id);
  });
}

function sortChanges(changes: DiffChange[]): DiffChange[] {
  const sorted = [...changes];
  return sorted.sort((a, b) => {
    const sevRank: Record<string, number> = {
      error: 3,
      warning: 2,
      info: 1,
    };
    const sevDiff =
      (sevRank[b.after.severity] ?? 0) - (sevRank[a.after.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const weightDiff = b.after.weight - a.after.weight;
    if (weightDiff !== 0) return weightDiff;
    const ruleDiff = a.after.ruleId.localeCompare(b.after.ruleId);
    if (ruleDiff !== 0) return ruleDiff;
    return a.after.target.id.localeCompare(b.after.target.id);
  });
}

function sortNotCompared(items: NotComparedIssue[]): NotComparedIssue[] {
  const order = sortIssues(items.map((i) => i.issue));
  const byIssue = new Map(items.map((i) => [i.issue, i]));
  return order.map((issue) => byIssue.get(issue)!);
}

function buildSide(report: AuditReport): DiffSide {
  // A failed/0-page side has no score — keep it null (N/A), never coerce to 0,
  // else a diff shows a bogus "-85 point / F regression" for a failed run (#586).
  const overall = report.healthScore?.overall ?? null;
  return {
    id: report.crawlId,
    baseUrl: report.baseUrl,
    timestamp: report.timestamp,
    totalPages: report.totalPages,
    score: {
      overall,
      grade: overall === null ? "N/A" : getScoreGrade(overall),
    },
  };
}

/** A check this audit produced and judged: not skipped, and not a finding carried over from an earlier audit. */
const judgedCheck = (c: CheckResult): boolean =>
  c.status !== "skipped" && c.provenance !== "carried";

function reportRule(
  report: AuditReport,
  ruleId: string
): ReportRuleResult | undefined {
  return report.ruleResults instanceof Map
    ? report.ruleResults.get(ruleId)
    : report.ruleResults[ruleId];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Decides, for a baseline issue the current report no longer has, whether the absence means "fixed" (#1748).
 * It does only when the rule ran in both audits over the same scope: same origin, the rule judged something
 * in each report, the issue's pages were crawled in the current audit and not skipped by the rule there, and
 * the rule did not report a check its metadata declares as "not checked" in place of the clean check that
 * supersedes the problem. Returns null for fixed, else why not.
 */
function makeNotComparedJudge(
  baseline: AuditReport,
  current: AuditReport,
  checkDecls: ReadonlyMap<string, readonly RuleCheckDecl[]>,
  superseded: ReadonlyMap<string, readonly string[]>
): (issue: IssueInstance) => Omit<NotComparedIssue, "issue"> | null {
  const sameOrigin = originOf(baseline.baseUrl) === originOf(current.baseUrl);
  const targetDigest = (r: AuditReport) => r.scanScope?.targeted?.digest;
  const sameTargetList =
    current.scanScope?.targeted !== undefined &&
    baseline.scanScope?.targeted !== undefined &&
    targetDigest(current) !== undefined &&
    targetDigest(current) === targetDigest(baseline);
  const baseRuns = new Map<string, RuleRun>(
    ruleRuns(baseline).map((r) => [r.ruleId, r])
  );
  // A report rebuilt from a slim JSON export (`report --input`) has only the sampled failing rows: its rule
  // statuses are the export's own `rules` list, and without one nothing says what ran.
  const slim = current.slimSource;
  const currentRuns = new Map<string, RuleRun>(
    (slim ? (slim.rules ?? []) : ruleRuns(current)).map((r) => [r.ruleId, r])
  );
  const norm = (url: string) => normalizeTargetId(url, current.baseUrl);
  // Empty when the report does not list its pages: nothing then says a page was not crawled.
  const crawled = new Set((current.pages ?? []).map((p) => norm(p.url)));

  return (issue) => {
    if (!sameOrigin) return { reason: "different-scope" };

    const base = baseRuns.get(issue.ruleId);
    if (base?.status !== "ran") return { reason: "rule-not-run-in-baseline" };

    // A slim export samples the pages of each check (`affectedPagesHasMore`) and records no passing row, so an
    // issue's absence from it proves nothing unless the export says the rule ran and listed the check whole.
    if (slim) {
      if (!slim.rules) return { reason: "sampled-report" };
      const names = [
        issue.checkName,
        ...(
          superseded.get(resolutionCheckKey(issue.ruleId, issue.checkName)) ??
          []
        ).map((s) => splitSuccessor(s).check),
      ];
      if (
        names.some((n) => slim.truncatedChecks.includes(`${issue.ruleId}|${n}`))
      ) {
        return { reason: "sampled-report" };
      }
    }

    // A targeted audit (#1777, #1778) runs the site rules that can be judged from the listed pages. A finding
    // that names a page is compared by that page (below); one that names none (a whole-site check, or an item
    // with no source page) is about the whole site, which a run over a few pages cannot speak for. That holds
    // whenever the current run is targeted, unless the baseline was targeted over the very same list: two
    // targeted runs over [/a] and [/b] judged different pages.
    if (
      current.scanScope?.targeted !== undefined &&
      !sameTargetList &&
      (issue.target.type === "check" ||
        (issue.target.type === "item" &&
          (issue.sourcePages?.length ?? 0) === 0))
    ) {
      return { reason: "targeted-run" };
    }

    const run = currentRuns.get(issue.ruleId);
    if (!run) return { reason: "rule-not-run" };
    if (run.status === "timed_out") return { reason: "rule-timed-out" };
    if (run.status === "skipped") {
      return {
        reason: "rule-skipped",
        ...(run.reason ? { detail: run.reason } : {}),
      };
    }

    // A pageless skip row of the issue's own check (or its peer) is a coverage gap of that check: the external
    // link checks past their cap or out of time, internal link targets not fetched. The issue may be among the
    // links not checked, so its absence is no evidence (the page-based rows below only see per-page skips).
    {
      const names = new Set([
        issue.checkName,
        ...(
          superseded.get(resolutionCheckKey(issue.ruleId, issue.checkName)) ??
          []
        ).map((s) => splitSuccessor(s).check),
      ]);
      const gap = (reportRule(current, issue.ruleId)?.checks ?? []).find(
        (c) =>
          c.status === "skipped" &&
          !c.pageUrl &&
          !(c.pages && c.pages.length > 0) &&
          names.has(c.name) &&
          skipReasonClass(c.skipReason)?.notChecked === true
      );
      if (gap) {
        return {
          reason: "rule-skipped",
          ...(gap.skipReason ? { detail: gap.skipReason } : {}),
        };
      }
    }

    // A rule that caps its item list lists the first N and counts the rest in `details.additional` (#1781). A
    // baseline item missing from such a list may be one of the rest: still failing, just not listed.
    if (issue.target.type === "item") {
      const names = new Set([
        issue.checkName,
        ...(
          superseded.get(resolutionCheckKey(issue.ruleId, issue.checkName)) ??
          []
        ).map((s) => splitSuccessor(s).check),
      ]);
      // A check that sits on its own page(s) (a page rule's per-page check) caps only that page's items: another
      // page's capped list says nothing about this item. A site-scope check has no page, so it covers them all.
      const issuePages = new Set((issue.sourcePages ?? []).map(norm));
      const capped = (reportRule(current, issue.ruleId)?.checks ?? []).some(
        (c) => {
          if (
            !names.has(c.name) ||
            c.status === "skipped" ||
            typeof c.details?.additional !== "number" ||
            c.details.additional <= 0
          ) {
            return false;
          }
          const own = [
            ...(c.pageUrl ? [c.pageUrl] : []),
            ...(c.pages ?? []),
          ].map(norm);
          // No page: a site-wide cap. An item with no page of its own cannot be placed: capped, the safe side.
          if (own.length === 0 || issuePages.size === 0) return true;
          return own.some((p) => issuePages.has(p));
        }
      );
      if (capped) return { reason: "items-capped" };
    }

    // The pages the issue sits on: its target for a page issue, its source pages for an item.
    const pages =
      issue.target.type === "page"
        ? [issue.target.id]
        : (issue.sourcePages ?? []).map(norm);
    if (pages.length > 0) {
      const rule = reportRule(current, issue.ruleId);
      const skippedHere = new Set<string>();
      for (const c of rule?.checks ?? []) {
        if (c.status !== "skipped") continue;
        if (c.pageUrl) skippedHere.add(norm(c.pageUrl));
        for (const p of c.pages ?? []) skippedHere.add(norm(p));
      }
      for (const page of pages) {
        if (crawled.size > 0 && !crawled.has(page)) {
          return { reason: "page-not-crawled", detail: page };
        }
        if (skippedHere.has(page)) {
          return { reason: "rule-skipped-on-page", detail: page };
        }
      }
    }

    // The declared linkage (#1741): a clean check that supersedes the problem is the evidence of a fix. A rule
    // that answered with a check it declares as "not checked" and no such clean check evaluated nothing.
    const decls = checkDecls.get(issue.ruleId);
    if (decls) {
      const clears = new Set(
        decls
          .filter(
            (d) => d.outcome === "clean" && d.clears?.includes(issue.checkName)
          )
          .map((d) => d.name)
      );
      const notChecked = new Set(
        decls.filter((d) => d.outcome === "skipped").map((d) => d.name)
      );
      const judged = (reportRule(current, issue.ruleId)?.checks ?? []).filter(
        judgedCheck
      );
      if (
        clears.size > 0 &&
        judged.some((c) => notChecked.has(c.name)) &&
        !judged.some((c) => clears.has(c.name))
      ) {
        return { reason: "not-evaluated" };
      }
    }
    return null;
  };
}

export function diffReports(
  baseline: AuditReport,
  current: AuditReport,
  options: DiffOptions = {}
): DiffReport {
  const baselineIssues = buildIssueInstances(baseline, options.severity);
  const currentIssues = buildIssueInstances(current, options.severity);

  const baselineMap = new Map<string, IssueInstance>();
  for (const issue of baselineIssues) {
    if (!baselineMap.has(issue.fingerprint)) {
      baselineMap.set(issue.fingerprint, issue);
    }
  }

  const currentMap = new Map<string, IssueInstance>();
  for (const issue of currentIssues) {
    if (!currentMap.has(issue.fingerprint)) {
      currentMap.set(issue.fingerprint, issue);
    }
  }

  const added: IssueInstance[] = [];
  const removed: IssueInstance[] = [];
  const changed: DiffChange[] = [];

  for (const [fingerprint, issue] of currentMap) {
    const baselineIssue = baselineMap.get(fingerprint);
    if (!baselineIssue) {
      added.push(issue);
      continue;
    }
    if (issuesDiffer(baselineIssue, issue)) {
      changed.push({
        before: baselineIssue,
        after: issue,
        changeType: changeTypeFor(baselineIssue, issue),
      });
    }
  }

  // A baseline issue stored under a superseded check name (#1765) is judged by its successors on the same target.
  const superseded =
    options.supersededChecks ??
    buildSupersededIndex([...loadAllRules().values()].map((r) => r.meta));
  const checkDecls =
    options.checkDecls ??
    new Map(
      [...loadAllRules().values()]
        .filter((r) => r.meta.checks !== undefined)
        .map((r) => [r.meta.id, r.meta.checks!] as const)
    );
  const judge = makeNotComparedJudge(baseline, current, checkDecls, superseded);
  const notChecked: IssueInstance[] = [];
  const notCompared: NotComparedIssue[] = [];
  const mergedSuccessors = new Set<IssueInstance>();
  // An issue that is gone is removed (fixed) only when its rule ran over the same scope; else it is not compared.
  const removeOrNotCompare = (issue: IssueInstance) => {
    const why = judge(issue);
    if (why) notCompared.push({ issue, ...why });
    else removed.push(issue);
  };
  for (const [fingerprint, issue] of baselineMap) {
    if (currentMap.has(fingerprint)) continue;
    const successors = superseded.get(
      resolutionCheckKey(issue.ruleId, issue.checkName)
    );
    if (!successors) {
      removeOrNotCompare(issue);
      continue;
    }
    const outcomes: SupersededOutcome[] = [];
    let successor: IssueInstance | undefined;
    for (const spec of successors) {
      // A successor can report the finding under one locator of its own (#1780).
      const { check: name, locator, members } = splitSuccessor(spec);
      let hit = currentMap.get(
        fingerprintForIssue(
          issue.ruleId,
          name,
          issue.target.type,
          // A whole-check finding's identity is its check name, which for a successor is the successor's (#1783).
          issue.target.type === "check" ? name : (locator ?? issue.target.id)
        )
      );
      // A successor that lists its members (#1780) takes the old row only when its list names it.
      if (
        hit &&
        members &&
        !successorListsLocator(hit.meta, members, issue.target.id)
      ) {
        hit = undefined;
      }
      if (hit) {
        outcomes.push("failing");
        successor ??= hit;
      } else if (
        // A grouped successor (#1780) emits nothing when there is nothing to group, so it ran whenever the rule
        // did; any other successor must have emitted a judged check of its own.
        !(locator !== undefined && ruleJudged(current, issue.ruleId)) &&
        !ranCheck(current, issue.ruleId, name) &&
        // Peers (#1772): a link moves between two checks of one run of the rule, so the old name having been
        // judged this run says the successor was too (it emits no pass row when it has no link to report).
        !(
          superseded
            .get(resolutionCheckKey(issue.ruleId, name))
            ?.some((s) => splitSuccessor(s).check === issue.checkName) &&
          ranCheck(current, issue.ruleId, issue.checkName)
        )
      )
        outcomes.push("not-checked");
      else outcomes.push("passed");
    }
    const verdict = judgeSuperseded(outcomes);
    if (verdict === "failing" && successor) {
      // Still failing under the new name: one change, not a removal plus an addition. Several old rows that
      // became one grouped row (#1780) are one change, for the first of them.
      const addedAt = added.indexOf(successor);
      if (addedAt >= 0) added.splice(addedAt, 1);
      if (!mergedSuccessors.has(successor)) {
        mergedSuccessors.add(successor);
        changed.push({ before: issue, after: successor, changeType: "change" });
      }
    } else if (verdict === "not-checked") notChecked.push(issue);
    else removeOrNotCompare(issue);
  }

  const sortedAdded = sortIssues(added);
  const sortedRemoved = sortIssues(removed);
  const sortedChanged = sortChanges(changed);

  const regressions = sortedChanged.filter(
    (c) => c.changeType === "regression"
  ).length;
  const improvements = sortedChanged.filter(
    (c) => c.changeType === "improvement"
  ).length;

  return {
    baseline: buildSide(baseline),
    current: buildSide(current),
    summary: {
      added: sortedAdded.length,
      removed: sortedRemoved.length,
      changed: sortedChanged.length,
      regressions,
      improvements,
      ...(notCompared.length > 0 ? { notCompared: notCompared.length } : {}),
    },
    added: sortedAdded,
    removed: sortedRemoved,
    changed: sortedChanged,
    ...(notChecked.length > 0 ? { notChecked: sortIssues(notChecked) } : {}),
    ...(notCompared.length > 0
      ? { notCompared: sortNotCompared(notCompared) }
      : {}),
  };
}

/** True when the rule produced any judged check in the report (a pass, warn or fail that is not carried). */
function ruleJudged(report: AuditReport, ruleId: string): boolean {
  const rule: ReportRuleResult | undefined =
    report.ruleResults instanceof Map
      ? report.ruleResults.get(ruleId)
      : report.ruleResults[ruleId];
  return rule?.checks.some(judgedCheck) ?? false;
}

/** True when the report holds a check of that name for the rule that was evaluated (not only skipped). */
function ranCheck(report: AuditReport, ruleId: string, name: string): boolean {
  const rule: ReportRuleResult | undefined =
    report.ruleResults instanceof Map
      ? report.ruleResults.get(ruleId)
      : report.ruleResults[ruleId];
  return (
    rule?.checks.some(
      (c: CheckResult) => c.name === name && c.status !== "skipped"
    ) ?? false
  );
}

export function isSameBaseUrl(a: AuditReport, b: AuditReport): boolean {
  return a.baseUrl === b.baseUrl;
}
