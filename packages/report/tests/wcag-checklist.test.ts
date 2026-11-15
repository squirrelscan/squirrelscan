// repo#3094: the accessibility checklist lists every WCAG 2.2 A/AA criterion with what the rules found,
// says every row still needs a manual check, and makes no conformance or regulation claim.

import { describe, expect, test } from "bun:test";

import { WCAG_CRITERIA, wcag } from "@squirrelscan/core-contracts/wcag";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";
import {
  WCAG_CHECKLIST_DISCLAIMER,
  buildWcagChecklist,
  wcagChecklistCsv,
  wcagChecklistMarkdown,
  type WcagChecklistRule,
} from "../src/wcag-checklist";

/** A rule result shaped like the engine writes it: its meta carries no `wcag` (repo#3094 review). */
function result(id: string, status: "pass" | "warn" | "fail" | "skipped", skipReason?: string) {
  return {
    meta: {
      id,
      name: id,
      description: "desc",
      solution: "fix it",
      category: "a11y",
      scope: "page",
      severity: "warning",
      weight: 5,
    },
    checks: [{ name: "x", status, message: "", ...(skipReason ? { skipReason } : {}) }],
  } satisfies ReportRuleResult;
}

function report(ruleResults: Record<string, ReportRuleResult>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-17T00:00:00.000Z",
    totalPages: 1,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults,
  };
}

const rules: WcagChecklistRule[] = [
  { id: "a11y/skip-link", wcag: [wcag("2.4.1")] },
  { id: "a11y/html-lang-valid", wcag: [wcag("3.1.1")] },
  { id: "a11y/never-ran", wcag: [wcag("1.4.3")] },
  { id: "a11y/coverage-gap", wcag: [wcag("2.4.7")] },
  { id: "seo/untagged" },
];

const ran = report({
  "a11y/skip-link": result("a11y/skip-link", "fail"),
  "a11y/html-lang-valid": result("a11y/html-lang-valid", "pass"),
  "a11y/coverage-gap": result("a11y/coverage-gap", "skipped", "rule-timed-out"),
});

const aOrAa = Object.entries(WCAG_CRITERIA).filter(([, e]) => e.level !== "AAA");

function row(sc: string) {
  return buildWcagChecklist(ran, rules).find((r) => r.sc === sc)!;
}

describe("buildWcagChecklist (repo#3094)", () => {
  test("lists every WCAG 2.2 A and AA criterion from the WCAG table once, in order, without 4.1.1 or AAA", () => {
    const rows = buildWcagChecklist(ran, rules);
    expect(rows.map((r) => r.sc)).toEqual(aOrAa.map(([sc]) => sc));
    expect(rows).toHaveLength(55);
    expect(rows.some((r) => r.sc === "4.1.1")).toBe(false);
    expect(rows.every((r) => r.level === "A" || r.level === "AA")).toBe(true);
    expect(row("2.4.2").title).toBe("Page Titled");
  });

  test("a rule that ran with a warning or failure marks its criterion as a finding", () => {
    expect(row("2.4.1")).toMatchObject({
      status: "finding",
      rules: ["a11y/skip-link"],
      findings: ["a11y/skip-link"],
    });
  });

  test("rules that ran with no finding mark the criterion no-finding, never tested or passed", () => {
    expect(row("3.1.1")).toMatchObject({
      status: "no-finding",
      rules: ["a11y/html-lang-valid"],
      findings: [],
    });
  });

  test("a mapped rule absent from the results, or one that only timed out, did not run", () => {
    expect(row("1.4.3")).toMatchObject({
      status: "not-run",
      rules: [],
      notRun: ["a11y/never-ran"],
    });
    expect(row("2.4.7")).toMatchObject({ status: "not-run", notRun: ["a11y/coverage-gap"] });
  });

  test("a rule that ran and was not applicable on every page answered: no issue, not did not run", () => {
    const notApplicable = report({
      "a11y/autocomplete-tokens": result("a11y/autocomplete-tokens", "skipped", "not-applicable"),
      "a11y/page-gated": result("a11y/page-gated", "skipped", "page-type"),
    });
    const rows = buildWcagChecklist(notApplicable, [
      { id: "a11y/autocomplete-tokens", wcag: [wcag("1.3.5")] },
      { id: "a11y/page-gated", wcag: [wcag("2.4.2")] },
    ]);
    expect(rows.find((r) => r.sc === "1.3.5")).toMatchObject({
      status: "no-finding",
      rules: ["a11y/autocomplete-tokens"],
      notRun: [],
    });
    expect(rows.find((r) => r.sc === "2.4.2")).toMatchObject({ status: "no-finding", notRun: [] });
    expect(rows.some((r) => r.status === "not-run")).toBe(false);
  });

  test("a criterion with one rule that ran and one excluded reads no issue and names the excluded rule", () => {
    const partial = buildWcagChecklist(
      report({ "a11y/html-lang-valid": result("a11y/html-lang-valid", "pass") }),
      [
        { id: "a11y/html-lang-valid", wcag: [wcag("3.1.1")] },
        { id: "a11y/excluded", wcag: [wcag("3.1.1")] },
      ],
    );
    expect(partial.find((r) => r.sc === "3.1.1")).toMatchObject({
      status: "no-finding",
      rules: ["a11y/html-lang-valid"],
      notRun: ["a11y/excluded"],
    });
    expect(wcagChecklistMarkdown(partial)).toContain(
      "| 3.1.1 Language of Page | A | Rules found no issue | a11y/html-lang-valid | a11y/excluded | none | [ ] Still needed |",
    );
  });

  test("a criterion no rule maps to says so", () => {
    expect(row("2.1.1")).toMatchObject({ status: "no-rule", rules: [], notRun: [], findings: [] });
  });
});

describe("checklist output (repo#3094)", () => {
  const rows = buildWcagChecklist(ran, rules);

  test("markdown leads with the disclaimer and gives every row a manual check", () => {
    const md = wcagChecklistMarkdown(rows);
    expect(md.indexOf(WCAG_CHECKLIST_DISCLAIMER)).toBeGreaterThan(0);
    expect(md.indexOf(WCAG_CHECKLIST_DISCLAIMER)).toBeLessThan(md.indexOf("| Criterion |"));
    const tableRows = md.split("\n").filter((l) => /^\| \d/.test(l));
    expect(tableRows).toHaveLength(rows.length);
    for (const line of tableRows) expect(line.endsWith("| [ ] Still needed |")).toBe(true);
    expect(md).toContain(
      "| Criterion | Level | What the rules found | Rules that ran | Rules that did not run | Rules with findings | Manual check |",
    );
    expect(md).toContain(
      "| 2.4.1 Bypass Blocks | A | Rules found an issue | a11y/skip-link | none | a11y/skip-link | [ ] Still needed |",
    );
    expect(md).toContain(
      "| 2.4.7 Focus Visible | AA | Rules did not run | none | a11y/coverage-gap | none | [ ] Still needed |",
    );
  });

  test("the did-not-run note names why and what to do", () => {
    expect(wcagChecklistMarkdown(rows)).toContain(
      "Rules did not run: rules are mapped to it, but none ran on this audit (excluded, filtered by --wcag-level, timed out or errored). Re-run without the exclusion to check it.",
    );
  });

  test("no regulation mapping, no tested status and no compliance claim", () => {
    const text = `${wcagChecklistMarkdown(rows)}\n${wcagChecklistCsv(rows)}`;
    for (const banned of [
      "ADA",
      "Section 508",
      "EAA",
      "EN 301 549",
      "AODA",
      "Cited by",
      "Tested",
      "compliant",
      "needs render",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
    expect(WCAG_CHECKLIST_DISCLAIMER).toContain("not a conformance claim");
    expect(WCAG_CHECKLIST_DISCLAIMER).toContain("does not mean a site conforms");
    expect(text).not.toContain("—");
  });

  test("CSV has one row per criterion with reviewer columns, and neutralises formulas and quotes", () => {
    const csv = wcagChecklistCsv(rows).trimEnd().split("\n");
    expect(csv[0]).toBe(
      "criterion,title,level,rules_found,rules_ran,rules_not_run,rules_with_findings,manual_check,manual_result,reviewer_notes",
    );
    expect(csv).toHaveLength(rows.length + 1);
    expect(csv.find((l) => l.startsWith("3.3.4,"))).toBe(
      '3.3.4,"Error Prevention (Legal, Financial, Data)",AA,No rule covers it,,,,Still needed,,',
    );
    const evil = buildWcagChecklist(report({ "=cmd|x": result("=cmd|x", "fail") }), [
      { id: "=cmd|x", wcag: [wcag("1.1.1")] },
    ]);
    const line = wcagChecklistCsv(evil)
      .split("\n")
      .find((l) => l.startsWith("1.1.1,"))!;
    expect(line).toContain(",'=cmd|x,");
    expect(wcagChecklistMarkdown(evil)).toContain("=cmd\\|x");
  });
});

describe("markdown reports carry the checklist when the rules' declarations are passed (repo#3094)", () => {
  test("it sits before Report detail, which stays last, and survives white-label", () => {
    const md = renderMarkdown(ran, {
      branding: { whiteLabel: true, orgName: "Acme" },
      wcagRules: rules,
    });
    expect(md).toContain("## Accessibility checklist");
    expect(md.indexOf("## Accessibility checklist")).toBeLessThan(md.indexOf("## Report detail"));
  });

  test("a failed audit, which ran no rules, has none", () => {
    expect(renderMarkdown({ ...ran, status: "failed" }, { wcagRules: rules })).not.toContain(
      "## Accessibility checklist",
    );
  });

  test("a blocked audit, which ran no rules, has none", () => {
    expect(renderMarkdown({ ...ran, status: "blocked" }, { wcagRules: rules })).not.toContain(
      "## Accessibility checklist",
    );
  });

  test("an engine-built report (no meta.wcag) gets correct statuses from the rules passed in", () => {
    const md = renderMarkdown(ran, { wcagRules: rules });
    expect(md).toContain(WCAG_CHECKLIST_DISCLAIMER);
    expect(md).toContain("| 2.4.1 Bypass Blocks | A | Rules found an issue |");
    expect(md).toContain("| 3.1.1 Language of Page | A | Rules found no issue |");
    expect(md).toContain("| 1.4.3 Contrast (Minimum) | AA | Rules did not run |");
    expect(md).toContain("| 2.1.1 Keyboard | A | No rule covers it |");
  });

  test("with no rule declarations there is no checklist, never one of all 'No rule covers it'", () => {
    expect(renderMarkdown(ran)).not.toContain("## Accessibility checklist");
    expect(renderMarkdown(ran, { wcagRules: [{ id: "seo/untagged" }] })).not.toContain(
      "## Accessibility checklist",
    );
    expect(renderMarkdown(ran)).not.toContain("No rule covers it");
  });
});
