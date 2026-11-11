// Per page type coverage: pages known against pages audited (#1744).

import { describe, expect, test } from "bun:test";

import { pageTypeCoverageLine, scanScopePageTypes } from "../src/coverage";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport } from "../src/types";

function report(pageTypes?: unknown): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    scanScope: {
      origin: "cli",
      pagesCrawled: 3,
      maxPages: 3,
      capped: true,
      ...(pageTypes ? { pageTypes } : {}),
    },
  } as unknown as AuditReport;
}

const capped = [
  { type: "product", discovered: 36, audited: 1 },
  { type: "article", discovered: 12, audited: 12 },
  { type: "unknown", discovered: 3, audited: 2 },
];

describe("page type coverage line", () => {
  test("a capped crawl names each type as audited of known, and folds unknown into other", () => {
    expect(pageTypeCoverageLine(report(capped))).toBe(
      "Page types audited: 1 of 36 product pages, 12 of 12 article pages, 2 of 3 other pages.",
    );
  });

  test("a complete crawl prints equal counts", () => {
    const line = pageTypeCoverageLine(report([{ type: "product", discovered: 4, audited: 4 }]));
    expect(line).toBe("Page types audited: 4 of 4 product pages.");
  });

  test("a report with no per-type counts has no line", () => {
    expect(pageTypeCoverageLine(report())).toBeNull();
  });

  test("hostile stored rows are dropped and audited is clamped to known", () => {
    const rows = scanScopePageTypes(
      report([
        { type: "<x>", discovered: 1, audited: 1 },
        { type: "faq", discovered: "9", audited: 1 },
        { type: "event", discovered: 2, audited: 5 },
        null,
      ]),
    );
    expect(rows).toEqual([{ type: "event", discovered: 5, audited: 5 }]);
  });
});

describe("every format that prints the scan prints the per-type counts", () => {
  test("text", () => {
    expect(renderText(report(capped))).toContain("1 of 36 product pages");
  });
  test("llm", () => {
    expect(renderLlm(report(capped), { version: "1.0.0" })).toContain(
      '<page-type name="product" discovered="36" audited="1"/>',
    );
  });
  test("xml", () => {
    expect(renderXml(report(capped))).toContain('<page-type name="product" discovered="36" audited="1"/>');
  });
  test("json", () => {
    expect(JSON.parse(renderJson(report(capped))).meta.pageTypes[0]).toEqual({
      type: "product",
      discovered: 36,
      audited: 1,
    });
  });
  test("json omits the field when the report has none", () => {
    expect("pageTypes" in JSON.parse(renderJson(report())).meta).toBe(false);
  });
});
