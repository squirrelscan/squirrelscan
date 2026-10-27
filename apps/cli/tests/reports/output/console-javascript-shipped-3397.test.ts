// squirrelscan/repo#3397: the console report, the CLI's default output, states
// the JavaScript the audit measured, once, in the header. packages/report covers
// the shared line and the other formats; this covers the console wiring.

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

describe("console report: JavaScript shipped", () => {
  test("one line when scripts were measured", () => {
    const report: AuditReport = {
      ...createMinimalReport(),
      javascript: {
        scripts: 3,
        bytes: 307_200,
        thirdPartyBytes: 0,
        unmeasured: 0,
        framework: { id: "astro", name: "Astro", bytes: 102_400 },
        heaviestPages: [{ url: "https://example.com/", bytes: 307_200, scripts: 3 }],
      },
    };
    const out = capture(report);
    expect(out).toContain("JavaScript shipped: 300.0 KB across 3 scripts (Astro runtime 100.0 KB, 33%)");
    expect(out.match(/JavaScript shipped/g)).toHaveLength(1);
  });

  test("nothing when none was", () => {
    expect(capture(createMinimalReport())).not.toContain("JavaScript shipped");
  });
});
