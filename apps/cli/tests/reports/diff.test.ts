import { describe, expect, test } from "bun:test";

import type {
  AuditReport,
  ReportRuleResult,
  CheckResult,
} from "../../src/types";

import { buildIssueInstances, diffReports } from "../../src/reports/diff";

function makeReport(
  ruleResults: Record<string, ReportRuleResult>,
  baseUrl = "https://example.com",
  crawlId = "crawl-1"
): AuditReport {
  return {
    crawlId,
    baseUrl,
    timestamp: new Date().toISOString(),
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    siteChecks: [],
    pages: [],
    summary: {
      missingTitles: [],
      missingDescriptions: [],
      missingOgTags: [],
      missingTwitterCards: [],
      missingSchemas: [],
      missingAltText: [],
      multipleH1s: [],
      thinContentPages: [],
      urlIssues: [],
      redirectChains: [],
      securityIssues: [],
    },
    ruleResults,
  };
}

function makeRuleResult(
  ruleId: string,
  checks: CheckResult[]
): ReportRuleResult {
  const [category] = ruleId.split("/");
  return {
    meta: {
      id: ruleId,
      name: ruleId,
      description: ruleId,
      category: category as "core",
      scope: "page",
      severity: "error",
      weight: 5,
    },
    checks,
  };
}

describe("diff reports", () => {
  test("fingerprints are stable for identical issues", () => {
    const ruleResults = {
      "core/meta-title": makeRuleResult("core/meta-title", [
        {
          name: "meta-title",
          status: "fail",
          message: "Missing title",
          items: [{ id: "https://example.com/about" }],
        },
      ]),
    };

    const report = makeReport(ruleResults);
    const first = buildIssueInstances(report);
    const second = buildIssueInstances(report);

    expect(first.length).toBe(1);
    expect(first[0].fingerprint).toBe(second[0].fingerprint);
  });

  test("issue target selection uses item, page, pageUrl, then check", () => {
    const ruleResults = {
      "core/item": makeRuleResult("core/item", [
        {
          name: "item",
          status: "fail",
          message: "Item issue",
          items: [{ id: "https://example.com/a" }],
        },
      ]),
      "core/pages": makeRuleResult("core/pages", [
        {
          name: "pages",
          status: "fail",
          message: "Page issue",
          pages: ["https://example.com/b"],
        },
      ]),
      "core/pageUrl": makeRuleResult("core/pageUrl", [
        {
          name: "pageUrl",
          status: "fail",
          message: "Page URL issue",
          pageUrl: "https://example.com/c",
        },
      ]),
      "core/check": makeRuleResult("core/check", [
        {
          name: "check",
          status: "fail",
          message: "Check issue",
        },
      ]),
    };

    const report = makeReport(ruleResults);
    const instances = buildIssueInstances(report);

    const byRule = new Map(instances.map((i) => [i.ruleId, i]));
    expect(byRule.get("core/item")?.target.type).toBe("item");
    expect(byRule.get("core/pages")?.target.type).toBe("page");
    expect(byRule.get("core/pageUrl")?.target.type).toBe("page");
    expect(byRule.get("core/check")?.target.type).toBe("check");
  });

  test("diff detects added, removed, and status changes", () => {
    const baseline = makeReport({
      "core/meta-title": makeRuleResult("core/meta-title", [
        {
          name: "meta-title",
          status: "warn",
          message: "Title too short",
          items: [{ id: "https://example.com/a" }],
        },
      ]),
      "core/removed": makeRuleResult("core/removed", [
        {
          name: "removed",
          status: "fail",
          message: "Removed issue",
          items: [{ id: "https://example.com/b" }],
        },
      ]),
    });

    const current = makeReport({
      "core/meta-title": makeRuleResult("core/meta-title", [
        {
          name: "meta-title",
          status: "fail",
          message: "Title too short",
          items: [{ id: "https://example.com/a" }],
        },
      ]),
      "core/added": makeRuleResult("core/added", [
        {
          name: "added",
          status: "fail",
          message: "New issue",
          items: [{ id: "https://example.com/c" }],
        },
      ]),
    });

    const diff = diffReports(baseline, current);

    expect(diff.added.length).toBe(1);
    expect(diff.removed.length).toBe(1);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0].changeType).toBe("regression");
  });

  // #586: diffing a scored baseline against a failed (0-page) current must keep
  // the failed side's score null (N/A), not coerce it to 0 — else the diff reads
  // as a bogus "-85 point / grade-F regression" instead of "current audit failed".
  test("failed current keeps a null (N/A) score, not a coerced 0", () => {
    const baseline = makeReport({});
    baseline.healthScore = {
      overall: 85,
      categories: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 0,
    };
    const current = makeReport({});
    current.status = "failed";
    current.statusReason = "No pages were crawled";
    current.healthScore = {
      overall: null,
      categories: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 0,
    };

    const diff = diffReports(baseline, current);
    expect(diff.baseline.score?.overall).toBe(85);
    expect(diff.current.score?.overall).toBeNull();
    expect(diff.current.score?.grade).toBe("N/A");
  });
});
