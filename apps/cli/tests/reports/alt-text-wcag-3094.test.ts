// repo#3094 (Nik, 11-18): images/alt-text cites WCAG 1.1.1 Non-text Content, so the accessibility checklist
// counts it on the 1.1.1 row and the JSON report tags its issue, with the rule metadata as the engine loads it.

import { buildWcagChecklist, renderJson } from "@squirrelscan/report";
import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "@/types";

import { wcagChecklistRules } from "@/reports/output/markdown";

const altText = loadAllRules().get("images/alt-text")!;

/** A report where images/alt-text is the only rule that ran, and it failed. */
function altTextOnlyReport(meta: unknown): AuditReport {
  return {
    crawlId: "crawl-1",
    baseUrl: "https://example.com/",
    timestamp: "2026-11-18T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 1,
    failed: 0,
    pages: [],
    siteChecks: [],
    ruleResults: {
      "images/alt-text": {
        meta,
        checks: [
          {
            name: "alt-text",
            status: "warn",
            message: "1 image with no alt attribute",
            pageUrl: "https://example.com/",
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

describe("images/alt-text on the accessibility checklist (repo#3094)", () => {
  test("the 1.1.1 row shows an issue when only images/alt-text fails", () => {
    // Engine-shaped: the stored rule meta carries no `wcag`; the checklist reads it from the rules.
    const { wcag: _omit, ...engineMeta } = altText.meta;
    const rows = buildWcagChecklist(
      altTextOnlyReport(engineMeta),
      wcagChecklistRules()
    );
    expect(rows.find((r) => r.sc === "1.1.1")).toMatchObject({
      status: "finding",
      rules: ["images/alt-text"],
      findings: ["images/alt-text"],
      notRun: [
        "a11y/aria-meter-name",
        "a11y/aria-progressbar-name",
        "a11y/input-image-alt",
        "a11y/object-alt",
        "a11y/svg-img-alt",
      ],
    });
  });
});

describe("images/alt-text in the JSON report (repo#3094)", () => {
  test("its issue carries wcag 1.1.1 at Level A and wcagByLevel lists it", () => {
    const json = JSON.parse(renderJson(altTextOnlyReport(altText.meta)));
    const issue = json.issues.find(
      (i: { ruleId: string }) => i.ruleId === "images/alt-text"
    );
    expect(issue.wcag).toEqual([{ sc: "1.1.1", level: "A", version: "2.0" }]);
    expect(issue.wcagLevel).toBe("A");
    expect(json.wcagByLevel).toEqual({ A: ["images/alt-text"] });
  });
});
