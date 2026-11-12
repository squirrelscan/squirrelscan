// pub#1765: `squirrel report --diff` judges a baseline issue stored under a superseded check name by its successors.

import { describe, expect, test } from "bun:test";

import type {
  AuditReport,
  CheckResult,
  ReportRuleResult,
} from "../../src/types";

import { diffReports } from "../../src/reports/diff";

const RULE = "core/meta-title";
const URL = "https://example.com/p";

const rule = (checks: CheckResult[]): ReportRuleResult => ({
  meta: {
    id: RULE,
    name: RULE,
    description: RULE,
    category: "core",
    scope: "page",
    severity: "error",
    weight: 8,
  },
  checks,
});

const report = (checks: CheckResult[], crawlId: string): AuditReport =>
  ({
    crawlId,
    baseUrl: "https://example.com",
    timestamp: new Date().toISOString(),
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    siteChecks: [],
    pages: [],
    summary: {},
    ruleResults: { [RULE]: rule(checks) },
  }) as unknown as AuditReport;

const warn = (name: string): CheckResult => ({
  name,
  status: "warn",
  message: name,
  items: [{ id: URL, label: "t" }],
});
const pass = (name: string): CheckResult => ({
  name,
  status: "pass",
  message: "ok",
});
const skipped = (name: string): CheckResult => ({
  name,
  status: "skipped",
  message: "skipped",
});

const before = () => report([warn("meta-title")], "before");

describe("diff with a superseded check name", () => {
  test("both successors passed: the old issue is removed (fixed)", () => {
    const diff = diffReports(
      before(),
      report(
        [pass("meta-title-too-short"), pass("meta-title-too-long")],
        "after"
      )
    );
    expect(diff.removed.map((i) => i.checkName)).toEqual(["meta-title"]);
    expect(diff.added).toEqual([]);
  });

  test("a still-long title is one change, not a removal plus an addition", () => {
    const diff = diffReports(
      before(),
      report(
        [pass("meta-title-too-short"), warn("meta-title-too-long")],
        "after"
      )
    );
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(
      diff.changed.map((c) => [c.before.checkName, c.after.checkName])
    ).toEqual([["meta-title", "meta-title-too-long"]]);
  });

  test("a successor that was not checked is neither fixed nor failing", () => {
    const diff = diffReports(
      before(),
      report(
        [skipped("meta-title-too-short"), pass("meta-title-too-long")],
        "after"
      )
    );
    expect(diff.removed).toEqual([]);
    expect(diff.notChecked?.map((i) => i.checkName)).toEqual(["meta-title"]);
  });

  test("a title missing in both audits is the same finding: not fixed, not changed, not added", () => {
    // A missing title is still emitted as `meta-title`; neither successor fires on a page with no title.
    const missing = (): CheckResult => ({
      name: "meta-title",
      status: "warn",
      message: "Missing title tag",
    });
    const diff = diffReports(
      report([missing()], "before"),
      report([missing()], "after")
    );
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});
