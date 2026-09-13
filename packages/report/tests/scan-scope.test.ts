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

// #1909 / squirrelscan/repo#2110 — a page limit the run did not get to use.
//
// `requestedMaxPages` has been on the contract since #1909 but no human-readable
// renderer ever printed it, so a run clamped from 10,000 to 4,320 read as though
// 4,320 were the number the user chose — and the full-scan hint told them to
// raise a limit that was already above what the run could use. Two producers set
// it: the CLI's own page cap, and a hosted run whose crawl budget cannot pay for
// the pace the site asks for. The wording here is shared by both, so it states
// the facts and leaves the remedy to the surface that knows it.
describe("a reduced page limit (#1909)", () => {
  const clampedScope = {
    origin: "cloud" as const,
    maxPages: 4320,
    requestedMaxPages: 10000,
    pagesCrawled: 4320,
    capped: true,
  };

  test("the scan line names both limits", () => {
    expect(scanScopeLine(baseReport({ scanScope: clampedScope }))).toBe(
      "Scan: 4320 pages crawled from squirrelscan cloud (page limit 4320 of 10000 requested, reached).",
    );
  });

  test("an uncapped clamped run still names both, without 'reached'", () => {
    expect(
      scanScopeLine(baseReport({ scanScope: { ...clampedScope, capped: false, pagesCrawled: 900 } })),
    ).toBe("Scan: 900 pages crawled from squirrelscan cloud (page limit 4320 of 10000 requested).");
  });

  test("the CLI reads the same as the cloud — no surface-specific advice here", () => {
    expect(scanScopeLine(baseReport({ scanScope: { ...clampedScope, origin: "cli" } }))).toBe(
      "Scan: 4320 pages crawled from the CLI (page limit 4320 of 10000 requested, reached).",
    );
  });

  test("a requested limit equal to the effective one is not a reduction", () => {
    // A producer echoing the same number both ways must not render a clamp that
    // never happened, which is why this compares rather than trusting presence.
    expect(
      scanScopeLine(
        baseReport({ scanScope: { ...clampedScope, requestedMaxPages: 4320 } }),
      ),
    ).toBe("Scan: 4320 pages crawled from squirrelscan cloud (page limit 4320 reached).");
  });

  test("the full-scan hint stops telling them to raise the limit", () => {
    const hint = fullScanHint(baseReport({ scanScope: clampedScope }));
    expect(hint).toBe(
      "Partial scan: the page limit stopped the crawl, so the site may have more pages than this score covers. This run was limited to 4320 of the 10000 pages requested, so raising the limit alone will not extend it.",
    );
    // The advice that cannot work: the request was already above what this run
    // could use, so a bigger number is reduced exactly the same way.
    expect(hint).not.toContain("Raise");
    expect(hint).not.toContain("--max-pages");
  });

  test("an unclamped capped run keeps its original advice", () => {
    const hint = fullScanHint(
      baseReport({ scanScope: { origin: "cli", maxPages: 100, pagesCrawled: 100, capped: true } }),
    );
    expect(hint).toContain("Raise --max-pages");
  });

  test("the carried-pages hint drops the raise advice too when clamped", () => {
    const hint = fullScanHint(
      baseReport({
        scanScope: clampedScope,
        coverage: { auditedPages: 4320, knownPages: 9000, carriedFindings: 12 },
      }),
    );
    expect(hint).toContain("4320 of 9000 known pages were re-checked");
    expect(hint).toContain("raising the limit alone will not extend it");
    expect(hint).not.toContain("Raise the audit page limit");
  });

  test("every human-readable renderer carries both numbers", () => {
    // The gap this closes: json and llm already emitted `requestedMaxPages`,
    // and the three renderers a person actually reads did not.
    const report = baseReport({ scanScope: clampedScope });
    for (const rendered of [
      renderText(report),
      renderMarkdown(report),
      renderHtml(report),
    ]) {
      expect(rendered).toContain("4320 of 10000 requested");
    }
  });
});
