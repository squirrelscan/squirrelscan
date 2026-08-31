// The console renderer is where the original crash landed: a stored editor's
// summary whose `prose` is not a usable string reached `es.prose.split(...)`
// and killed a finished audit with "undefined is not an object". It must render
// as "no editor-summary section" instead, never as a throw.
//
// Sibling of packages/report/tests/editor-summary-malformed.test.ts, which
// covers the other five formats; console lives here, in the CLI.

import { describe, expect, test, spyOn } from "bun:test";

import type { AuditReport, EditorSummary } from "@/types";

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

function reportWith(editorSummary: unknown): AuditReport {
  const report = createMinimalReport();
  report.editorSummary = editorSummary as EditorSummary;
  return report;
}

/** Same body shapes the report-package renderer matrix pins. */
const MALFORMED: Array<[string, unknown]> = [
  [
    "missing prose",
    { bigTicket: [], verdict: "v", model: "m", generatedAt: "t" },
  ],
  ["the whole body replaced by an envelope", { ok: true }],
  [
    "prose is not a string",
    { prose: 42, bigTicket: [], verdict: "", model: "", generatedAt: "" },
  ],
  [
    "prose is blank",
    {
      prose: "   \n\n  ",
      bigTicket: [],
      verdict: "",
      model: "",
      generatedAt: "",
    },
  ],
  [
    "prose is null",
    { prose: null, bigTicket: [], verdict: "", model: "", generatedAt: "" },
  ],
];

describe("console editor's summary", () => {
  test.each(MALFORMED)(
    "renders without the section and without throwing: %s",
    (_label, body) => {
      const out = capture(reportWith(body));
      expect(out).not.toContain("EDITOR'S SUMMARY");
      // The rest of the report still renders — the audit is not discarded.
      expect(out).toContain("85");
    }
  );

  test("renders a well-formed summary in full", () => {
    const out = capture(
      reportWith({
        prose: "First paragraph.\n\nSecond paragraph.",
        bigTicket: ["Fix the titles"],
        verdict: "Ship it",
        model: "test-model",
        generatedAt: "2026-06-16T14:30:00.000Z",
      })
    );
    expect(out).toContain("EDITOR'S SUMMARY");
    expect(out).toContain("First paragraph.");
    expect(out).toContain("Second paragraph.");
    expect(out).toContain("Fix the titles");
    expect(out).toContain("Verdict: Ship it");
  });

  test("a summary carrying only prose renders it with no bullet list", () => {
    // `bigTicket.length` was the second unguarded dereference here.
    const out = capture(reportWith({ prose: "Body text." }));
    expect(out).toContain("EDITOR'S SUMMARY");
    expect(out).toContain("Body text.");
    expect(out).not.toContain("Big-ticket items:");
  });
});
