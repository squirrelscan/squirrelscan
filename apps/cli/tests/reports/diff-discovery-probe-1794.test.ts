// #1794: `squirrel report --diff` keeps a finding open when its rule's discovery probe was not approved, not
// sent or refused in the newer audit, and still resolves it when the probe was answered.

import { describe, expect, test } from "bun:test";

import type { AuditReport, CheckResult } from "../../src/types";

import { diffReports } from "../../src/reports/diff";

const RULE = "security/security-txt";

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
    ruleResults: {
      [RULE]: {
        meta: {
          id: RULE,
          name: "security.txt",
          description: RULE,
          category: "security",
          scope: "site",
          severity: "warning",
          weight: 2,
        },
        checks,
      },
    },
  }) as unknown as AuditReport;

const missing: CheckResult = {
  name: "security-txt",
  status: "warn",
  message: "No security.txt",
  value: "missing",
  items: [{ id: "https://example.com", label: "site" }],
};

describe("diff with a discovery probe gap", () => {
  const before = () => report([missing], "before");

  test("a refused probe keeps the finding open (notChecked, not removed)", () => {
    const after = report(
      [
        {
          name: "security-txt",
          status: "skipped",
          skipReason: "discovery-probe-refused",
          message: "not checked",
          value: "not-checked",
        },
      ],
      "after"
    );
    const diff = diffReports(before(), after);
    expect(diff.removed).toEqual([]);
    expect(diff.notChecked?.map((i) => i.checkName)).toEqual(["security-txt"]);
  });

  test("an answered probe that found the file resolves the finding", () => {
    const after = report(
      [{ name: "security-txt", status: "pass", message: "ok" }],
      "after"
    );
    const diff = diffReports(before(), after);
    expect(diff.removed.map((i) => i.checkName)).toEqual(["security-txt"]);
    expect(diff.notChecked).toBeUndefined();
  });
});
