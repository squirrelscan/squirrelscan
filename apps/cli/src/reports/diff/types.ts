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
}

export interface DiffOptions {
  severity?: SeverityLevel;
}
