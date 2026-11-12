import { describe, expect, test } from "bun:test";
import { discoveredCount, reportTopLineCounts, sectionScoreRows } from "../src/top-line";
import type { AuditReport, GroupScore } from "../src/types";

const g = (group: GroupScore["group"], score: number, failed = 0, warnings = 0): GroupScore => ({
  group,
  name: group,
  score,
  failed,
  warnings,
  passed: 10,
  total: 10 + failed + warnings,
});

describe("sectionScoreRows", () => {
  test("returns the four sections in report order whatever the input order", () => {
    const rows = sectionScoreRows([g("ai", 93), g("security", 88), g("seo", 97), g("performance", 92, 1, 5)]);
    expect(rows.map((r) => [r.group, r.name, r.score])).toEqual([
      ["seo", "SEO", 97],
      ["performance", "Performance", 92],
      ["security", "Security", 88],
      ["ai", "Agents", 93],
    ]);
    expect(rows[1]).toMatchObject({ failed: 1, warnings: 5 });
  });

  test("an older report with no groups yields no rows", () => {
    expect(sectionScoreRows(undefined)).toEqual([]);
    expect(sectionScoreRows([])).toEqual([]);
  });

  test("a quick audit that did not score Agents yields three rows", () => {
    expect(sectionScoreRows([g("seo", 90), g("performance", 80), g("security", 70)])).toHaveLength(3);
  });
});

describe("counts", () => {
  const base = { totalPages: 100, passed: 5, warnings: 3, failed: 2 } as AuditReport;

  test("discovered is the larger of scanned and known pages", () => {
    expect(discoveredCount({ ...base, coverage: { knownPages: 250 } } as AuditReport)).toEqual({
      total: 250,
      floor: false,
    });
  });

  test("a capped crawl's discovered count is a floor", () => {
    const r = { ...base, coverage: { knownPages: 250 }, scanScope: { capped: true } } as AuditReport;
    expect(discoveredCount(r)).toEqual({ total: 250, floor: true });
    expect(reportTopLineCounts(r)).toMatchObject({ scanned: 100, passed: 5, warnings: 3, failed: 2 });
  });
});
