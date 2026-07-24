// #1180 — scan scope disclosure. Every renderer states where the audit ran and
// how much of the site it crawled, plus a full-scan hint when the score does
// not rest on a full fresh crawl.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { fullScanHint, scanScopeLine } from "../src/coverage";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

describe("scanScopeLine (#1180)", () => {
  test("null when the report has no scanScope (pre-#1180 reports)", () => {
    expect(scanScopeLine(baseReport())).toBeNull();
  });

  test("origin + version + cap render into one line", () => {
    const report = baseReport({
      generatorVersion: "0.0.76",
      scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true },
    });
    expect(scanScopeLine(report)).toBe(
      "Scan: 100 pages crawled from the CLI v0.0.76 (page limit 100 reached).",
    );
  });

  test("cloud origin, uncapped", () => {
    const report = baseReport({
      scanScope: { origin: "cloud", maxPages: 500, pagesCrawled: 42, capped: false },
    });
    expect(scanScopeLine(report)).toBe(
      "Scan: 42 pages crawled from squirrelscan cloud (page limit 500).",
    );
  });

  test("ci origin, single page, no cap", () => {
    const report = baseReport({
      scanScope: { origin: "ci", pagesCrawled: 1, capped: false },
    });
    expect(scanScopeLine(report)).toBe("Scan: 1 page crawled from CI.");
  });
});

describe("fullScanHint (#1180)", () => {
  test("null on a complete scan", () => {
    expect(fullScanHint(baseReport())).toBeNull();
    expect(
      fullScanHint(
        baseReport({
          scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 42, capped: false },
          coverage: { auditedPages: 42, knownPages: 42, carriedFindings: 0 },
        }),
      ),
    ).toBeNull();
  });

  test("partial union names the re-check target", () => {
    const hint = fullScanHint(
      baseReport({
        scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true },
        coverage: { auditedPages: 100, knownPages: 505, carriedFindings: 3063 },
      }),
    );
    expect(hint).toContain("100 of 505 known pages");
    expect(hint).toContain("--max-pages 505");
  });

  test("capped without coverage still hints", () => {
    const hint = fullScanHint(
      baseReport({
        scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true },
      }),
    );
    expect(hint).toContain("page limit stopped the crawl");
    expect(hint).toContain("--max-pages");
  });
});

describe("renderer wiring (#1180)", () => {
  const report = baseReport({
    generatorVersion: "0.0.76",
    scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true },
    coverage: { auditedPages: 100, knownPages: 505, carriedFindings: 12 },
  });

  test("text output carries scope line + hint", () => {
    const out = renderText(report);
    expect(out).toContain("Scan: 100 pages crawled from the CLI v0.0.76");
    expect(out).toContain("Partial scan:");
  });

  test("markdown output carries scope line + hint", () => {
    const out = renderMarkdown(report);
    expect(out).toContain("Scan: 100 pages crawled from the CLI v0.0.76");
    expect(out).toContain("Partial scan:");
  });

  test("html output carries scope line + hint", () => {
    const out = renderHtml(report, { reportId: "TESTID" });
    expect(out).toContain("Scan: 100 pages crawled from the CLI v0.0.76");
    expect(out).toContain("Partial scan:");
  });

  test("llm output emits a structured scan-scope element", () => {
    const out = renderLlm(report);
    expect(out).toContain('<scan-scope origin="cli" crawled="100" max-pages="100" capped="true"/>');
  });

  test("pre-#1180 reports render without any scope artifacts", () => {
    const legacy = baseReport();
    expect(renderText(legacy)).not.toContain("Scan:");
    // CSS for the class is always in the stylesheet; the rendered element is not.
    expect(renderHtml(legacy, { reportId: "TESTID" })).not.toContain('class="scan-scope"');
    expect(renderHtml(legacy, { reportId: "TESTID" })).not.toContain("crawled from");
  });
});
