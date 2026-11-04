// #1406: the console report marks a technology only the local scan found, so cloud React and local-only
// Vue do not look identical. An `origin` that is not the literal "local" is not marked.
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { generateConsoleReport } from "../../src/reports/output/console";

function capture(run: () => void): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")
    );
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  // eslint-disable-next-line no-control-regex
  return chunks.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const item = (id: string, name: string, origin?: string) => ({
  id,
  name,
  category: "framework",
  version: null,
  confidence: "high",
  detectedBy: "t",
  ...(origin ? { origin } : {}),
});

const report = (items: object[]) =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-10-29T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    technologies: {
      source: "cloud",
      added: [],
      removed: [],
      firstScan: false,
      items,
    },
  }) as unknown as AuditReport;

describe("console technologies, local origin (#1406)", () => {
  test("a local-only technology carries (local scan); a cloud one does not", () => {
    const out = capture(() =>
      generateConsoleReport(
        report([item("react", "React"), item("vue", "Vue", "local")])
      )
    );
    expect(out).toContain("Vue (local scan)");
    expect(out).not.toContain("React (local scan)");
  });

  test("a hostile origin value is not marked", () => {
    const out = capture(() =>
      generateConsoleReport(report([item("vue", "Vue", 'local"/><injected/>')]))
    );
    expect(out).not.toContain("(local scan)");
  });
});
