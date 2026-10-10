// pub#629: the console renderer is the DEFAULT output, and "audit my dev
// server" is the first run most people try, so the rules a local host skipped
// are named here once, under the score they explain. packages/report covers the
// shared line and the other renderers; this covers the console wiring.

import { PRIVATE_TARGET_SKIP_REASON } from "@squirrelscan/core-contracts";
import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport, CheckResult } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const LINE =
  "Local or private-network host: 2 transport and delivery rules do not apply here and are not scored (HSTS Header, HTTPS).";

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

function skip(name: string, pageUrl?: string): CheckResult {
  return {
    name,
    status: "skipped",
    message: "Not applicable: local or private-network host",
    skipReason: PRIVATE_TARGET_SKIP_REASON,
    details: { foldKey: PRIVATE_TARGET_SKIP_REASON },
    ...(pageUrl ? { pageUrl } : {}),
  };
}

function localReport(): AuditReport {
  const base = createMinimalReport();
  const meta = (id: string, name: string) => ({
    id,
    name,
    description: name,
    category: "security" as const,
    scope: "page" as const,
    severity: "error" as const,
    weight: 1,
  });
  return {
    ...base,
    baseUrl: "http://localhost:3000",
    ruleResults: {
      "security/https": {
        meta: meta("security/https", "HTTPS"),
        checks: [
          skip("security/https", "http://localhost:3000/"),
          skip("security/https", "http://localhost:3000/about"),
        ],
      },
      "security/hsts": {
        meta: meta("security/hsts", "HSTS Header"),
        checks: [skip("security/hsts")],
      },
    },
  };
}

describe("console report names the rules a private host skipped", () => {
  test("once, right under the score line", () => {
    const lines = capture(localReport()).split("\n");
    expect(lines.filter((l) => l === LINE)).toHaveLength(1);
    const header = lines.findIndex((l) => l.includes("/100"));
    expect(lines.indexOf(LINE)).toBeGreaterThan(header);
    expect(lines.indexOf(LINE) - header).toBeLessThanOrEqual(3);
  });

  test("and never as an issue", () => {
    const out = capture(localReport());
    expect(out).not.toContain("ISSUES");
    expect(out).not.toContain("Not applicable: local or private-network host");
  });

  test("a public report prints nothing new", () => {
    expect(capture(createMinimalReport())).not.toContain(
      "Local or private-network host"
    );
  });
});
