// repo#3094: the CLI hands the accessibility checklist every rule's `meta.wcag`, so a report built like the
// engine builds it (its rule metas carry no `wcag`) gets correct statuses on every markdown path.

import { buildWcagChecklist } from "@squirrelscan/report";
import { loadAllRules } from "@squirrelscan/rules";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditReport } from "@/types";

import {
  generateMarkdownReport,
  wcagChecklistRules,
} from "@/reports/output/markdown";

describe("wcagChecklistRules (repo#3094)", () => {
  test("carries every rule's declared criteria, from the rule metadata", () => {
    const rules = wcagChecklistRules();
    const all = [...loadAllRules({ includeOptIn: true }).values()];
    expect(rules).toHaveLength(all.length);
    expect(rules.find((r) => r.id === "a11y/color-contrast")?.wcag).toEqual([
      { sc: "1.4.3", level: "AA", version: "2.0" },
    ]);
  });

  test("a criterion whose rules did not run reads as not run", () => {
    const rows = buildWcagChecklist({ ruleResults: {} }, wcagChecklistRules());
    expect(rows.find((r) => r.sc === "1.4.3")).toMatchObject({
      status: "not-run",
      notRun: ["a11y/color-contrast"],
    });
  });
});

/** Rule meta keys exactly as the engine writes them: no `wcag`. */
function engineResult(
  id: string,
  status: "pass" | "warn" | "fail" | "skipped",
  skipReason?: string
) {
  return {
    meta: {
      id,
      name: id,
      description: "d",
      solution: "s",
      category: "a11y",
      scope: "page",
      severity: "warning",
      weight: 5,
    },
    checks: [
      {
        name: "x",
        status,
        message: "m",
        pageUrl: "https://example.com/",
        ...(skipReason ? { skipReason } : {}),
      },
    ],
  };
}

/** An engine-shaped report: a contrast failure, autocomplete-tokens not applicable, focus-visible absent. */
function engineShapedReport(status?: string): AuditReport {
  return {
    crawlId: "crawl-1",
    baseUrl: "https://example.com/",
    timestamp: "2026-11-17T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 1,
    failed: 0,
    pages: [],
    siteChecks: [],
    ...(status ? { status } : {}),
    ruleResults: {
      "a11y/color-contrast": engineResult("a11y/color-contrast", "warn"),
      "a11y/autocomplete-tokens": engineResult(
        "a11y/autocomplete-tokens",
        "skipped",
        "not-applicable"
      ),
    },
  } as unknown as AuditReport;
}

describe("generateMarkdownReport, the audit run's markdown path (repo#3094)", () => {
  let dir: string;
  const originalLog = console.log;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "squirrel-wcag-md-"));
    console.log = () => {};
  });
  afterEach(() => {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an engine-shaped report gets correct checklist statuses", () => {
    const out = join(dir, "report.md");
    generateMarkdownReport(engineShapedReport(), out);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("## Accessibility checklist");
    expect(md).toContain(
      "| 1.4.3 Contrast (Minimum) | AA | Rules found an issue | a11y/color-contrast | none | a11y/color-contrast | [ ] Still needed |"
    );
    expect(md).toContain(
      "| 1.3.5 Identify Input Purpose | AA | Rules found no issue | a11y/autocomplete-tokens | none | none | [ ] Still needed |"
    );
    expect(md).toContain(
      "| 2.4.7 Focus Visible | AA | Rules did not run | none | a11y/focus-visible | none | [ ] Still needed |"
    );
    expect(md).toContain("| 2.1.1 Keyboard | A | No rule covers it |");
  });

  test("a blocked audit has no checklist", () => {
    const out = join(dir, "report.md");
    generateMarkdownReport(engineShapedReport("blocked"), out);
    expect(readFileSync(out, "utf8")).not.toContain("Accessibility checklist");
  });
});
