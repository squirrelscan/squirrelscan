// repo#3093: a11y issues carry their WCAG criteria and level in JSON, grouped by level.

import { describe, expect, test } from "bun:test";

import { wcag } from "@squirrelscan/core-contracts/wcag";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport } from "../src/types";

function rule(id: string, category: string, criteria?: ReturnType<typeof wcag>[]) {
  return {
    meta: {
      id,
      name: id,
      description: "d",
      category,
      scope: "page" as const,
      severity: "warning" as const,
      weight: 5,
      ...(criteria ? { wcag: criteria } : {}),
    },
    checks: [{ name: "c", status: "warn" as const, message: "m", pageUrl: "https://example.com/" }],
  };
}

function report(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 3,
    failed: 0,
    ruleResults: {
      "a11y/color-contrast": rule("a11y/color-contrast", "a11y", [wcag("1.4.3")]),
      "a11y/touch-targets": rule("a11y/touch-targets", "a11y", [wcag("2.5.5")]),
      "a11y/form-labels": rule("a11y/form-labels", "a11y", [wcag("1.3.1"), wcag("3.3.2")]),
      "core/meta-title": rule("core/meta-title", "core"),
    },
  } as unknown as AuditReport;
}

describe("renderJson wcag (repo#3093)", () => {
  test("a11y issues carry wcag and the easiest level; other rules carry none", () => {
    const json = JSON.parse(renderJson(report()));
    const by = Object.fromEntries(json.issues.map((i: { ruleId: string }) => [i.ruleId, i]));
    expect(by["a11y/color-contrast"].wcag).toEqual([{ sc: "1.4.3", level: "AA", version: "2.0" }]);
    expect(by["a11y/color-contrast"].wcagLevel).toBe("AA");
    expect(by["a11y/touch-targets"].wcagLevel).toBe("AAA");
    expect(by["a11y/form-labels"].wcagLevel).toBe("A");
    expect("wcag" in by["core/meta-title"]).toBe(false);
  });

  test("wcagByLevel groups the a11y rule ids by level", () => {
    const json = JSON.parse(renderJson(report()));
    expect(json.wcagByLevel.A).toEqual(["a11y/form-labels"]);
    expect(json.wcagByLevel.AA).toEqual(["a11y/color-contrast"]);
    expect(json.wcagByLevel.AAA).toEqual(["a11y/touch-targets"]);
  });

  test("a report with no a11y criteria has no wcagByLevel", () => {
    const r = report();
    r.ruleResults = { "core/meta-title": r.ruleResults["core/meta-title"]! };
    expect("wcagByLevel" in JSON.parse(renderJson(r))).toBe(false);
  });

  test("markdown shows the criterion and level", () => {
    expect(renderMarkdown(report())).toContain("**WCAG:** 1.4.3 Contrast (Minimum), Level AA (WCAG 2.0)");
  });
});

describe("html wcag line (pub#2024 review)", () => {
  test("says the counts are of accessibility rules with findings", () => {
    const html = renderHtml(report());
    expect(html).toContain("Accessibility rules with findings, by WCAG level: Level A: 1, Level AA: 1, Level AAA: 1");
  });
});

describe("a run narrowed by a WCAG level is marked partial (pub#2024 review)", () => {
  const narrowed = (): AuditReport => ({
    ...report(),
    partialAudit: { include: [], exclude: [], includedCategories: ["a11y", "core"], wcagLevel: "AA" },
  });

  test("json meta.partialAudit carries the level", () => {
    const meta = JSON.parse(renderJson(narrowed())).meta;
    expect(meta.partialAudit).toEqual({
      include: [],
      exclude: [],
      includedCategories: ["a11y", "core"],
      wcagLevel: "AA",
    });
  });

  test("text, markdown and xml name the level", () => {
    expect(renderText(narrowed())).toContain("Partial audit: accessibility rules narrowed to WCAG Level AA.");
    expect(renderMarkdown(narrowed())).toContain("accessibility rules narrowed to WCAG Level AA");
    expect(renderXml(narrowed())).toContain('wcag-level="AA"');
  });

  test("a stored level that is not A, AA or AAA is dropped", () => {
    const r = narrowed();
    (r.partialAudit as unknown as { wcagLevel: string }).wcagLevel = "<b>";
    expect("partialAudit" in JSON.parse(renderJson(r)).meta).toBe(false);
    expect(renderXml(r)).not.toContain("wcag-level");
  });
});
