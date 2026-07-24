// Tests for Markdown report generator

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateMarkdownReport } from "@/reports/output/markdown";

import { createMinimalReport, createReportWithIssues } from "../fixtures";

describe("generateMarkdownReport", () => {
  let outputPath: string;

  beforeEach(() => {
    outputPath = join(tmpdir(), `test-report-${Date.now()}.md`);
  });

  afterEach(() => {
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
  });

  test("generates valid markdown output", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("# squirrelscan Audit Report");
  });

  test("includes report metadata", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("**URL:** https://example.com");
    expect(content).toContain("**Pages:** 5");
    expect(content).toContain("**Date:**");
  });

  test("uses ISO date format", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    // ISO format contains T separator
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("includes health score table", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("## Health Score");
    expect(content).toContain("| Category | Score |");
    expect(content).toContain("**Overall**");
    expect(content).toContain("85/100");
  });

  test("includes summary section", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("## Summary");
    expect(content).toContain("**Passed:** 10");
    expect(content).toContain("**Warnings:** 3");
    expect(content).toContain("**Failed:** 2");
  });

  test("includes issues section", () => {
    const report = createReportWithIssues();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("## Issues");
    // #626: issues nest under a top-level group heading. The SEO group here has a
    // single issue-category (core), so its redundant category heading collapses and
    // the rule promotes directly under the group (h3 → h4).
    expect(content).toContain("### SEO");
    expect(content).toContain("#### Meta Title");
    expect(content).toContain("**[ERROR]**");
  });

  test("includes check table", () => {
    const report = createReportWithIssues();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("| Check | Status | Message |");
    expect(content).toContain("missing-title");
  });

  test("includes collapsible details for pages", () => {
    const report = createReportWithIssues();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("<details>");
    expect(content).toContain("<summary>");
    expect(content).toContain("</details>");
  });

  test("shows no issues message when empty", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("No issues found.");
  });

  test("includes footer", () => {
    const report = createMinimalReport();
    generateMarkdownReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("squirrelscan");
    expect(content).toContain("https://squirrelscan.com");
  });

  test("throws error for invalid path", () => {
    const report = createMinimalReport();
    const invalidPath = "/nonexistent/directory/report.md";

    expect(() => generateMarkdownReport(report, invalidPath)).toThrow(
      /Failed to write report/
    );
  });
});
