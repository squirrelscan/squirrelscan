// Tests for JSON report generator

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateJsonReport } from "@/reports/output/json";

import {
  createMinimalReport,
  createReportWithIssues,
  createReportWithLegacyValue,
} from "../fixtures";

describe("generateJsonReport", () => {
  let outputPath: string;

  beforeEach(() => {
    outputPath = join(tmpdir(), `test-report-${Date.now()}.json`);
  });

  afterEach(() => {
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
  });

  test("generates valid JSON output", () => {
    const report = createMinimalReport();
    generateJsonReport(report, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.meta).toBeDefined();
    expect(parsed.score).toBeDefined();
    expect(parsed.summary).toBeDefined();
    expect(parsed.issues).toBeDefined();
  });

  test("includes correct metadata", () => {
    const report = createMinimalReport();
    generateJsonReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.meta.baseUrl).toBe("https://example.com");
    expect(parsed.meta.totalPages).toBe(5);
    expect(parsed.meta.timestamp).toBeDefined();
  });

  test("includes health score", () => {
    const report = createMinimalReport();
    generateJsonReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.score.overall).toBe(85);
    expect(parsed.score.grade).toBeDefined();
    expect(parsed.score.categories).toHaveLength(2);
  });

  // #586: a failed/0-page audit persists a null score (N/A), never 0 — so a
  // saved-then-reloaded slim report doesn't bake in a bogus "audited, scored 0".
  test("emits null score + N/A grade (not 0/F) for a failed audit", () => {
    const report = createMinimalReport();
    report.status = "failed";
    report.statusReason = "No pages were crawled";
    if (report.healthScore) report.healthScore.overall = null;
    generateJsonReport(report, outputPath);

    const parsed = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(parsed.score.overall).toBeNull();
    expect(parsed.score.grade).toBe("N/A");
  });

  test("includes summary counts", () => {
    const report = createMinimalReport();
    generateJsonReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.summary.passed).toBe(10);
    expect(parsed.summary.warnings).toBe(3);
    expect(parsed.summary.failed).toBe(2);
  });

  test("includes issues with checks", () => {
    const report = createReportWithIssues();
    generateJsonReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.issues.length).toBeGreaterThan(0);
    const issue = parsed.issues[0];
    expect(issue.ruleId).toBe("core/meta-title");
    expect(issue.name).toBe("Meta Title");
    expect(issue.severity).toBe("error");
    expect(issue.checks).toBeDefined();
  });

  test("includes check items", () => {
    const report = createReportWithIssues();
    generateJsonReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    // Checks are now emitted in a deterministic (sorted) order (#150), so don't
    // assume the items-bearing check is first — find it by its `items` field.
    const check = parsed.issues[0].checks.find(
      (c: { items?: unknown[] }) => c.items !== undefined
    );
    expect(check).toBeDefined();
    expect(check.items.length).toBe(2);
  });

  test("handles legacy value field", () => {
    const report = createReportWithLegacyValue();
    generateJsonReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content);

    const check = parsed.issues[0].checks[0];
    expect(check.legacyValue).toBeDefined();
  });

  test("throws error for invalid path", () => {
    const report = createMinimalReport();
    const invalidPath = "/nonexistent/directory/report.json";

    expect(() => generateJsonReport(report, invalidPath)).toThrow(
      /Failed to write report/
    );
  });
});
