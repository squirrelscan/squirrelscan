import { describe, expect, test } from "bun:test";
import type { AuditReport } from "../src/types";
import { scanScopeDiscovered } from "../src/coverage";
import { renderJson } from "../src/output/json";

const report = (discovered?: unknown): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-16T00:00:00.000Z",
    totalPages: 2,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    scanScope: {
      origin: "cli",
      maxPages: 2,
      pagesCrawled: 2,
      capped: true,
      ...(discovered ? { discovered } : {}),
    },
  }) as unknown as AuditReport;

describe("scanScopeDiscovered", () => {
  test("reads the split and recomputes the total", () => {
    expect(scanScopeDiscovered(report({ total: 99, sitemap: 3, links: 4 }))).toEqual({
      total: 7,
      sitemap: 3,
      links: 4,
    });
  });
  test("absent or malformed field is null so older reports still render", () => {
    expect(scanScopeDiscovered(report())).toBeNull();
    expect(scanScopeDiscovered(report({ sitemap: -1, links: 2 }))).toBeNull();
    expect(scanScopeDiscovered(report({ sitemap: "x", links: 2 }))).toBeNull();
  });
  test("json meta carries discovered only when present", () => {
    const withIt = JSON.parse(renderJson(report({ total: 7, sitemap: 3, links: 4 }))).meta;
    expect(withIt.discovered).toEqual({ total: 7, sitemap: 3, links: 4 });
    expect(JSON.parse(renderJson(report())).meta.discovered).toBeUndefined();
  });
});
