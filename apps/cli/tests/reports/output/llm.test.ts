// Tests for LLM (XML) report generator

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateLlmReport } from "@/reports/output/llm";

import {
  createMinimalReport,
  createReportWithIssues,
  createReportWithXssContent,
} from "../fixtures";

describe("generateLlmReport", () => {
  let outputPath: string;

  beforeEach(() => {
    outputPath = join(tmpdir(), `test-report-${Date.now()}.xml`);
  });

  afterEach(() => {
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
  });

  test("generates valid XML output", () => {
    const report = createMinimalReport();
    generateLlmReport(report, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain("<audit");
    expect(content).toContain("</audit>");
  });

  test("includes site information", () => {
    const report = createMinimalReport();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain('<site url="https://example.com"');
    expect(content).toContain('crawled="5"');
  });

  test("includes health score", () => {
    const report = createMinimalReport();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain('<score overall="85"');
    expect(content).toContain('grade="');
    expect(content).toContain('<cat name="Core SEO"');
  });

  // #586: a failed/0-page audit (null score) must render N/A to the agent, never
  // overall="0" grade="F" — this is the MCP tool's output surface.
  test("renders N/A (not 0/F) for a failed audit with a null score", () => {
    const report = createMinimalReport();
    report.status = "failed";
    report.statusReason = "No pages were crawled";
    if (report.healthScore) report.healthScore.overall = null;
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain('<score overall="N/A" grade="N/A">');
    expect(content).not.toContain('grade="F"');
    expect(content).not.toContain('overall="0"');
  });

  test("includes summary", () => {
    const report = createMinimalReport();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain('passed="10"');
    expect(content).toContain('warnings="3"');
    expect(content).toContain('failed="2"');
  });

  test("includes issues with rules and docs URL", () => {
    const report = createReportWithIssues();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("<issues>");
    expect(content).toContain("<category");
    expect(content).toContain('rule id="core/meta-title"');
    // Docs URL for LLM to look up rule details
    expect(content).toContain(
      'docs="https://docs.squirrelscan.com/rules/core/meta-title"'
    );
    // Desc/Fix omitted in compact LLM format to reduce token count
    expect(content).not.toContain("Desc:");
    expect(content).not.toContain("Fix:");
  });

  test("includes check items with compressed URLs", () => {
    const report = createReportWithIssues();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("Items (2):");
    // URLs compressed to relative paths for same-domain
    expect(content).toContain("- /about");
    expect(content).toContain("- /contact");
  });

  test("escapes XML special characters", () => {
    const report = createReportWithXssContent();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    // Should escape < > & " '
    expect(content).toContain("&lt;script&gt;");
    expect(content).toContain("&amp;");
    expect(content).not.toContain("<script>alert");
  });

  test("handles empty issues", () => {
    const report = createMinimalReport();
    generateLlmReport(report, outputPath);

    const content = readFileSync(outputPath, "utf-8");

    // Empty issues should be self-closing
    expect(content).toContain("<issues/>");
  });

  test("caps affected pages and includes shown/total marker", () => {
    const report = createMinimalReport();
    report.ruleResults = {
      "core/multi-page": {
        meta: {
          id: "core/multi-page",
          name: "Multi Page Issue",
          description: "Issue appears on many pages",
          category: "core",
          scope: "page",
          severity: "warning",
          weight: 5,
        },
        checks: [
          {
            name: "same-issue",
            status: "warn",
            message: "Repeated issue",
            pageUrl: "https://example.com/",
          },
          {
            name: "same-issue",
            status: "warn",
            message: "Repeated issue",
            pageUrl: "https://example.com/a",
          },
          {
            name: "same-issue",
            status: "warn",
            message: "Repeated issue",
            pageUrl: "https://example.com/b",
          },
          {
            name: "same-issue",
            status: "warn",
            message: "Repeated issue",
            pageUrl: "https://example.com/a/c",
          },
          {
            name: "same-issue",
            status: "warn",
            message: "Repeated issue",
            pageUrl: "https://example.com/b/c",
          },
          {
            name: "same-issue",
            status: "warn",
            message: "Repeated issue",
            pageUrl: "https://example.com/deep/path/one",
          },
        ],
      },
    };

    generateLlmReport(report, outputPath);
    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("Pages (5/6):");
    expect(content).toContain("/, /a, /b");
    expect(content).not.toContain("/deep/path/one");
  });

  test("serializes object metadata without [object Object]", () => {
    const report = createMinimalReport();
    report.ruleResults = {
      "links/meta-object": {
        meta: {
          id: "links/meta-object",
          name: "Meta Object Serialization",
          description: "Ensures object metadata is serialized safely",
          category: "links",
          scope: "site",
          severity: "warning",
          weight: 3,
        },
        checks: [
          {
            name: "object-meta",
            status: "warn",
            message: "Contains structured metadata",
            items: [
              {
                id: "https://example.com/item",
                meta: { status: 403, provider: "cloudflare" },
              },
            ],
          },
        ],
      },
    };

    generateLlmReport(report, outputPath);
    const content = readFileSync(outputPath, "utf-8");

    expect(content).toContain("status");
    expect(content).toContain("cloudflare");
    expect(content).not.toContain("[object Object]");
  });

  test("throws error for invalid path", () => {
    const report = createMinimalReport();
    const invalidPath = "/nonexistent/directory/report.xml";

    expect(() => generateLlmReport(report, invalidPath)).toThrow(
      /Failed to write report/
    );
  });
});
