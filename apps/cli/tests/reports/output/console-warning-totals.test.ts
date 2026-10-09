// The console report counts warnings once: the score line ("Total:") and the
// footer must agree on the same audit (repo#2395). Advisory warnings from
// severity-"info" rules are kept out of the score, so the footer reads the
// score's count, not the raw check count.

import { describe, expect, test, spyOn } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");

function capture(report: AuditReport): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return strip(lines.join("\n"));
}

describe("console report warning totals (repo#2395)", () => {
  test("the footer and the Total line show the same warning count", () => {
    const report = createMinimalReport();
    // Two warn checks in total, one of them advisory: the score counts one.
    report.warnings = 2;
    if (report.healthScore) report.healthScore.warningCount = 1;

    const output = capture(report);
    const footer = output.match(/(\d+) warnings • /);
    const total = output.match(/Total: .*?, (\d+) warnings/);
    expect(footer?.[1]).toBeDefined();
    expect(total?.[1]).toBeDefined();
    expect(footer?.[1]).toBe(total?.[1]);
  });
});
