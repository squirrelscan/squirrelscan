// #518: renderJson lists evaluation-gap skips (scan-truncated) under a new
// top-level `skippedChecks` key, never under `issues`.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderJson } from "../src/output/json";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 1,
    failed: 2,
    ruleResults: {},
    ...overrides,
  };
}

function rule(id: string, name: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: {
      id,
      name,
      description: `${name} description`,
      category: "content",
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    checks,
  };
}

describe("renderJson skipped checks (#518)", () => {
  test("a per-page scan-truncated skip appears with its rule id and page URL", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          ruleResults: {
            "content/hidden-text": rule("content/hidden-text", "Hidden text", [
              {
                name: "hidden-text",
                status: "skipped",
                message: "Page too large to scan in full",
                pageUrl: "https://example.com/big",
                skipReason: "scan-truncated",
              },
              {
                name: "hidden-text",
                status: "pass",
                message: "No hidden text or links detected",
                pageUrl: "https://example.com/small",
              },
            ]),
          },
        }),
      ),
    );
    expect(parsed.skippedChecks).toEqual([
      {
        ruleId: "content/hidden-text",
        name: "Hidden text",
        check: "hidden-text",
        reason: "scan-truncated",
        pages: ["https://example.com/big"],
        pagesCount: 1,
        pagesHasMore: false,
      },
    ]);
    expect(parsed.summary.skipped).toBe(1);
    // Never a finding, and the existing counts keep their values.
    expect(parsed.issues).toEqual([]);
    expect(parsed.summary.passed).toBe(10);
    expect(parsed.summary.warnings).toBe(1);
    expect(parsed.summary.failed).toBe(2);
  });

  test("a folded skip carrying pages[] lists every page", () => {
    const pages = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          ruleResults: {
            "content/dev-leakage": rule("content/dev-leakage", "Dev leakage", [
              {
                name: "dev-leakage",
                status: "skipped",
                message: "Page too large to scan in full (+2 more pages)",
                pages,
                skipReason: "scan-truncated",
                details: { aggregated: true, occurrences: 3, foldKey: "scan-truncated" },
              },
            ]),
          },
        }),
      ),
    );
    expect(parsed.skippedChecks).toHaveLength(1);
    expect(parsed.skippedChecks[0].ruleId).toBe("content/dev-leakage");
    expect(parsed.skippedChecks[0].pages).toEqual(pages);
    expect(parsed.skippedChecks[0].pagesCount).toBe(3);
    expect(parsed.skippedChecks[0].pagesHasMore).toBe(false);
    expect(parsed.summary.skipped).toBe(3);
    expect(parsed.issues).toEqual([]);
  });

  test("a clipped fold reports the true page total", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          ruleResults: {
            "content/hidden-text": rule("content/hidden-text", "Hidden text", [
              {
                name: "hidden-text",
                status: "skipped",
                message: "Page too large to scan in full",
                pages: ["https://example.com/a", "https://example.com/b"],
                skipReason: "scan-truncated",
                details: { aggregated: true, pagesTruncated: 50 },
              },
            ]),
          },
        }),
      ),
    );
    expect(parsed.skippedChecks[0].pages).toHaveLength(2);
    expect(parsed.skippedChecks[0].pagesCount).toBe(50);
    expect(parsed.skippedChecks[0].pagesHasMore).toBe(true);
    expect(parsed.summary.skipped).toBe(50);
  });

  test("a fail beside a skip on the same rule keeps both, in their own lists", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          ruleResults: {
            "content/hidden-text": rule("content/hidden-text", "Hidden text", [
              {
                name: "hidden-text",
                status: "fail",
                message: "Hidden text found",
                pageUrl: "https://example.com/bad",
              },
              {
                name: "hidden-text",
                status: "skipped",
                message: "Page too large to scan in full",
                pageUrl: "https://example.com/big",
                skipReason: "scan-truncated",
              },
            ]),
          },
        }),
      ),
    );
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].checks.every((c: { status: string }) => c.status === "fail")).toBe(true);
    expect(parsed.skippedChecks[0].pages).toEqual(["https://example.com/big"]);
  });

  test("skips with other reasons are not listed in version one", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          ruleResults: {
            "core/noindex": rule("core/noindex", "Noindex", [
              {
                name: "noindex",
                status: "skipped",
                message: "Page is noindex",
                pageUrl: "https://example.com/x",
                skipReason: "noindex",
              },
            ]),
          },
        }),
      ),
    );
    expect("skippedChecks" in parsed).toBe(false);
    expect(parsed.summary.skipped).toBe(0);
  });

  test("negative control: no skips gives summary.skipped 0 and the same top-level keys", () => {
    const parsed = JSON.parse(renderJson(baseReport()));
    expect(parsed.summary).toEqual({ passed: 10, warnings: 1, failed: 2, skipped: 0 });
    expect(Object.keys(parsed)).toEqual(["meta", "status", "score", "summary", "issues"]);
  });
});
