// repo#2404: the scan line says how many crawled pages returned an error status.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";

import { scanScopeLine } from "../src/coverage";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

const report = (scope: Record<string, unknown>): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: 2,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    scanScope: {
      origin: "cloud",
      maxPages: 25,
      pagesCrawled: 4,
      capped: false,
      ...scope,
    },
  }) as unknown as AuditReport;

describe("scanScopeLine error pages", () => {
  test("names the pages that returned errors", () => {
    expect(scanScopeLine(report({ errorPages: 2 }))).toStartWith(
      "Scan: 4 pages crawled (2 returned errors) from squirrelscan cloud (page limit 25)."
    );
    expect(scanScopeLine(report({ errorPages: 1 }))).toContain(
      "(1 returned an error)"
    );
  });

  test("no error pages renders as before", () => {
    const plain = scanScopeLine(report({}));
    expect(plain).toBe(
      "Scan: 4 pages crawled from squirrelscan cloud (page limit 25)."
    );
    expect(scanScopeLine(report({ errorPages: 0 }))).toBe(plain);
    expect(scanScopeLine(report({ errorPages: Number.NaN }))).toBe(plain);
    expect(scanScopeLine(report({ errorPages: "2" }))).toBe(plain);
  });

  test("never claims more errors than crawled pages", () => {
    expect(scanScopeLine(report({ errorPages: 99 }))).toContain(
      "(4 returned errors)"
    );
  });

  test("markdown, text and llm carry it", () => {
    const r = report({ errorPages: 2 });
    expect(renderMarkdown(r)).toContain("(2 returned errors)");
    expect(renderText(r)).toContain("(2 returned errors)");
    expect(renderLlm(r)).toContain('error-pages="2"');
  });
});
