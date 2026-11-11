import type { RuleCheckDecl } from "@squirrelscan/rules";

import type { SeverityLevel } from "@/reports/filters";

import type { IssueTargetType } from "./fingerprint";

export type DiffChangeType = "regression" | "improvement" | "change";

export interface IssueTarget {
  type: IssueTargetType;
  id: string;
  label?: string;
}

export interface IssueInstance {
  fingerprint: string;
  ruleId: string;
  ruleName: string;
  category: string;
  severity: "error" | "warning" | "info";
  weight: number;
  checkName: string;
  status: "fail" | "warn";
  message: string;
  target: IssueTarget;
  sourcePages?: string[];
  meta?: Record<string, unknown>;
}

export interface DiffSide {
  id?: string;
  baseUrl: string;
  timestamp: string;
  totalPages: number;
  score?: {
    overall: number | null; // null ⇒ N/A (a failed/0-page side, #586)
    grade: string;
  };
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  regressions: number;
  improvements: number;
  /** Baseline issues that are gone but cannot be called fixed (see {@link NotComparedIssue}). Absent when none; never part of `removed`. */
  notCompared?: number;
}

/**
 * Why a baseline issue that the current report no longer has is NOT counted as fixed (#1748). A finding is fixed
 * only when its rule ran over the same scope in both audits and no longer reports it; anything else is not compared.
 */
export type NotComparedReason =
  /** The two reports audit different origins. */
  | "different-scope"
  /** The rule has no judged check in the current report: it did not run (disabled, or no result at all). */
  | "rule-not-run"
  /** The rule's checks were all skipped in the current report (`detail` carries the coded reason, e.g. `targeted-run`). */
  | "rule-skipped"
  /** The rule ran out of time in the current report. */
  | "rule-timed-out"
  /** The rule judged nothing in the baseline either (its finding there was carried from an older audit). */
  | "rule-not-run-in-baseline"
  /** The issue's page is not among the pages the current audit crawled (`detail` is the page). */
  | "page-not-crawled"
  /** The rule skipped the issue's page in the current audit (a noindex or unreadable page; `detail` is the page). */
  | "rule-skipped-on-page"
  /**
   * The current report was rebuilt from a slim JSON export (`report --input`), which keeps a sample of each
   * check's pages and no passing rows: a finding's absence from it is not evidence it was fixed.
   */
  | "sampled-report"
  /** The rule emitted a check its metadata declares as "not checked" and no clean check that supersedes the problem. */
  | "not-evaluated";

export interface NotComparedIssue {
  issue: IssueInstance;
  reason: NotComparedReason;
  detail?: string;
}

export interface DiffChange {
  before: IssueInstance;
  after: IssueInstance;
  changeType: DiffChangeType;
}

export interface DiffReport {
  baseline: DiffSide;
  current: DiffSide;
  summary: DiffSummary;
  added: IssueInstance[];
  removed: IssueInstance[];
  changed: DiffChange[];
  /** Baseline issues stored under a superseded check name whose successors were not checked this run (#1765). Not fixed, not failing. */
  notChecked?: IssueInstance[];
  /** Baseline issues the current report no longer has, whose rule did not run over the same scope (#1748). Not fixed, not in `removed`. */
  notCompared?: NotComparedIssue[];
}

export interface DiffOptions {
  severity?: SeverityLevel;
  /** `${ruleId}|${oldCheck}` -> successor checks; defaults to the loaded rules' `supersededChecks`. */
  supersededChecks?: ReadonlyMap<string, readonly string[]>;
  /** `ruleId` -> the rule's declared check names by outcome class (#1741); defaults to the loaded rules' `meta.checks`. */
  checkDecls?: ReadonlyMap<string, readonly RuleCheckDecl[]>;
}
