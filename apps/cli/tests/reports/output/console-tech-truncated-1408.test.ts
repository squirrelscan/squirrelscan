// #1408: the console report shows an empty technologies section that a cap cut short (so it does not
// read as "this site runs nothing"), and still hides an empty one that read everything.

import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

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
  return lines.join("\n");
}

const empty = {
  items: [],
  added: [],
  removed: [],
  firstScan: false,
  source: "local" as const,
};

describe("console technologies section when nothing was detected (#1408)", () => {
  test("a cut empty section is shown with the cut", () => {
    const out = capture({
      ...createMinimalReport(),
      technologies: {
        ...empty,
        truncated: { reasons: ["script-limit"], scripts: 2 },
      },
    } as AuditReport);
    expect(out).toContain("TECHNOLOGIES");
    expect(out).toContain("Detection was cut short");
  });

  test("an empty section that read everything stays hidden", () => {
    const out = capture({
      ...createMinimalReport(),
      technologies: empty,
    } as AuditReport);
    expect(out).not.toContain("TECHNOLOGIES");
  });
});
