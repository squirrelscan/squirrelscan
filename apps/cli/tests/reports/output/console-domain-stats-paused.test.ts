// Domain stats is paused, so an audit produces no `report.domainStats` and the
// console report must show no trace of it: no heading, and no blank line left
// where the section used to be.
//
// The section is already conditional, which is exactly why this is worth
// pinning — the pause makes the absent branch the ONLY branch that runs in
// practice, so a regression there would ship to everyone before anyone noticed.

import { DOMAIN_STATS_NOTE } from "@squirrelscan/report";
import { describe, expect, test, spyOn } from "bun:test";

import type { AuditReport, DomainStats } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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
  return lines.join("\n").replace(ANSI, "");
}

describe("console report — domain stats paused", () => {
  test("no domainStats → no DOMAIN STATS heading", () => {
    const out = capture(createMinimalReport());
    expect(out).not.toContain("DOMAIN STATS");
  });

  test("no domainStats → none of the section's vocabulary leaks either", () => {
    // Heading absence alone would still pass if the note or a metric label were
    // printed outside the guard.
    const out = capture(createMinimalReport());
    expect(out).not.toContain(DOMAIN_STATS_NOTE);
    expect(out).not.toContain("Ref. domains");
    expect(out).not.toContain("Domain rank");
    expect(out).not.toContain("Organic positions");
  });

  test("paused, not removed: a report that HAS domainStats still renders it", () => {
    const report = createMinimalReport();
    report.domainStats = {
      domain: "example.com",
      metrics: { backlinks: 12, referringDomains: 3 },
      capturedAt: "2026-09-03T00:00:00.000Z",
    } as unknown as DomainStats;
    expect(capture(report)).toContain("DOMAIN STATS");
  });
});
