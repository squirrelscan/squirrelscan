// The llm format labels its group and category scores and prints the report's own version (#1746).

import { describe, expect, test } from "bun:test";

import { renderLlm } from "../src/output/llm";
import type { AuditReport } from "../src/types";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    healthScore: {
      overall: 80,
      categories: [{ name: "Core SEO", score: 70 }],
      groups: [{ group: "seo", score: 90, failed: 1, warnings: 2 }],
    },
    ...overrides,
  } as AuditReport;
}

const llm = (r: AuditReport, version?: string) =>
  renderLlm(r as Parameters<typeof renderLlm>[0], { version, includePassed: false, includeInfo: false });

describe("llm score labels", () => {
  test("group and category scores each say which they are", () => {
    const out = llm(report());
    expect(out).toMatch(/<group [^>]*score="90" scope="group"/);
    expect(out).toMatch(/<cat name="Core SEO" score="70" scope="category"\/>/);
  });
});

describe("llm audit version", () => {
  test("a report that carries a version prints it, not 0.0.0", () => {
    const out = llm(report({ generatorVersion: "1.2.3" } as Partial<AuditReport>));
    expect(out).toContain('<audit version="1.2.3">');
    expect(out).not.toContain("0.0.0");
  });

  test("the report's version wins over the renderer's", () => {
    expect(llm(report({ generatorVersion: "1.2.3" } as Partial<AuditReport>), "9.9.9")).toContain('<audit version="1.2.3">');
  });

  test("without either, the fallback is kept; with the option, the option", () => {
    expect(llm(report())).toContain('<audit version="0.0.0">');
    expect(llm(report(), "4.5.6")).toContain('<audit version="4.5.6">');
  });
});
