// pub#2212: the section header counts grouped findings, the breakdown and the Total count
// checks. Each number carries its unit so the two never read as a contradiction.
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { generateConsoleReport } from "../../src/reports/output/console";

function report(): AuditReport {
  const check = (page: string) => ({
    name: "Security headers",
    status: "warn",
    message: "Missing header",
    pageUrl: `https://example.com/${page}`,
  });
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-31T00:00:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 3,
    failed: 0,
    // Three occurrences of one warning, while the score counts two checks.
    ruleResults: {
      "security/example": {
        meta: {
          id: "security/example",
          name: "Example",
          description: "d",
          category: "security",
          severity: "warning",
          weight: 5,
        },
        checks: [check("a"), check("b"), check("c")],
      },
    },
    healthScore: {
      overall: 90,
      groups: [],
      categories: [
        {
          category: "security",
          name: "Security",
          score: 90,
          passed: 0,
          warnings: 2,
          failed: 0,
        },
      ],
      passedCount: 0,
      warningCount: 2,
      errorCount: 0,
    },
  } as unknown as AuditReport;
}

function capture(run: () => void): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  // eslint-disable-next-line no-control-regex
  return chunks.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("console count units (pub#2212)", () => {
  test("header counts findings, breakdown counts checks", () => {
    const out = capture(() => generateConsoleReport(report(), {} as never));
    expect(out).toContain("(3 warning findings)");
    expect(out).toContain("Category Breakdown (checks):");
    expect(out).toMatch(/Security .*⚠2/);
    expect(out).not.toMatch(/\(\d+ warnings?\)/);
  });
});
