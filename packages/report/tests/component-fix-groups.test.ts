import { describe, expect, test } from "bun:test";
import type { AuditReport, CheckResult, ComponentOccurrence, ReportRuleResult } from "../src/types";
import { componentFixGroupDigest } from "../src/component-fix-groups";
import { groupIssuesByCategory } from "../src/grouping";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderText } from "../src/output/text";

function occurrence(pageUrl: string, overrides: Partial<ComponentOccurrence> = {}): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: new URL(pageUrl).origin,
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: "region" },
    family: { key: "family", structuralSignature: "family" },
    variant: { key: "variant", structuralSignature: "variant", contentHash: "content" },
    element: { locator: "footer>a:1", structuralSignature: "element" },
    defect: { kind: "link-text-generic", values: { text: "Read more" }, valueHashes: { text: "h" } },
    ...overrides,
  };
}

function report(checks: CheckResult[]): AuditReport {
  const rule: ReportRuleResult = {
    meta: {
      id: "a11y/link-text", name: "Link text", description: "desc", solution: "sol",
      category: "accessibility", scope: "page", severity: "warning", weight: 1,
    },
    checks,
  };
  return {
    baseUrl: "https://example.test", timestamp: "2026-09-18T00:00:00.000Z", totalPages: 3,
    passed: 0, warnings: checks.length, failed: 0, ruleResults: { "a11y/link-text": rule },
    healthScore: { overall: 80, categories: [], groups: [], errorCount: 0, warningCount: 1, passedCount: 0 },
  } as unknown as AuditReport;
}

function check(pageUrl: string, evidence: ComponentOccurrence[]): CheckResult {
  return { name: "generic-link-text", status: "warn", message: "Generic link text found", pageUrl, componentOccurrences: evidence };
}

describe("component-aware actionable groups (#2307)", () => {
  test("groups the same evidenced element across pages with complete membership", () => {
    const r = report([
      check("https://example.test/a", [occurrence("https://example.test/a")]),
      check("https://example.test/b", [occurrence("https://example.test/b")]),
    ]);
    const group = groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!.componentFixGroups![0]!;
    expect(group.affectedPages).toEqual(["https://example.test/a", "https://example.test/b"]);
    expect(group.affectedPageCount).toBe(2);
    expect(group.occurrences).toHaveLength(2);

    const issue = JSON.parse(renderJson(r)).issues[0];
    const json = issue.componentFixGroups[0];
    expect(json.affectedPageCount).toBe(2);
    // The group does NOT repeat the occurrence objects: they are serialized once
    // under the owning check, and the group points at them.
    expect(json.occurrences).toBeUndefined();
    expect(json.occurrenceCount).toBe(2);
    expect(json.occurrenceRefs).toHaveLength(2);
    for (const ref of json.occurrenceRefs) {
      expect(issue.checks[ref.checkIndex].componentOccurrences[ref.occurrenceIndex]).toBeDefined();
    }
    // Signatures are HOISTED: the shared region/family/variant triple is stored
    // once in `componentShapes`, not once per occurrence. So the signature count
    // must not scale with the number of occurrences.
    expect(issue.checks[0].componentShapes.shapes).toHaveLength(1);
    expect(issue.checks[0].componentOccurrences).toHaveLength(2);
    expect(issue.checks[0].componentOccurrences[0].shape).toBe(0);
    const signatures = JSON.stringify(issue).split('"structuralSignature"').length - 1;
    // 3 in the one shape + 1 element signature per occurrence + 2 on the group's
    // representative region/element. Repeating the triple per occurrence would
    // add 3 more for the second occurrence.
    expect(signatures).toBe(3 + issue.checks[0].componentOccurrences.length + 2);
    expect(json.id).toMatch(/^component-fix:[0-9a-f]{32}$/);
    expect(json.defect).toEqual({ kind: "link-text-generic", values: { text: "Read more" }, valueHashes: { text: "h" } });
    expect(json.region).toMatchObject({ role: "footer", nestedIn: "none" });
    expect(json.semanticSlot).toBe("footer>a:1");
    expect(renderLlm(r)).toContain('<component-fix-group');
    expect(renderLlm(r)).toContain('affected_pages="2"');
    expect(renderLlm(r)).toContain('<defect-values>{&quot;text&quot;:&quot;Read more&quot;}</defect-values>');
    expect(renderText(r)).toContain("Actionable component fix target: link-text-generic in footer (none), slot footer>a:1; 2 affected page(s)");
  });

  test("keeps variant, element, check status, and site boundaries separate", () => {
    const r = report([
      check("https://example.test/a", [occurrence("https://example.test/a")]),
      check("https://example.test/b", [occurrence("https://example.test/b", { element: { locator: "footer>a:2", structuralSignature: "other" } })]),
      check("https://other.test/c", [occurrence("https://other.test/c")]),
      { ...check("https://example.test/d", [occurrence("https://example.test/d")]), status: "fail" },
    ]);
    expect(groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!.componentFixGroups).toHaveLength(4);
  });

  test("does not promote uncertain evidence or legacy checks into a fix group", () => {
    const r = report([
      check("https://example.test/a", [occurrence("https://example.test/a", { groupable: false, confidence: "uncertain", family: { key: "page:a", structuralSignature: "x" } })]),
      { name: "generic-link-text", status: "warn", message: "Generic link text found", pageUrl: "https://example.test/b" },
    ]);
    expect(groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!.componentFixGroups).toBeUndefined();
    const issue = JSON.parse(renderJson(r)).issues[0];
    expect(issue.componentFixGroups).toBeUndefined();
    expect(issue.checks[0].componentOccurrences).toHaveLength(1);
  });

  test("retains an explicit bounded-storage evidence omission in JSON", () => {
    const r = report([{ name: "generic-link-text", status: "warn", message: "Generic link text found", pageUrl: "https://example.test/a", componentEvidence: { state: "omitted", reason: "payload-limit", occurrenceCount: 1001 } }]);
    const issue = JSON.parse(renderJson(r)).issues[0];
    expect(issue.checks[0].componentEvidence).toEqual({ state: "omitted", reason: "payload-limit", occurrenceCount: 1001 });
    expect(issue.componentFixGroups).toBeUndefined();
    expect(renderText(r)).toContain(
      "Component fix evidence unavailable for 1001 occurrence(s): they exceeded the stored finding payload limit.",
    );
  });

  test("a group id is a short digest, and a digest collision still yields distinct ids", () => {
    const r = report([
      check("https://example.test/a", [occurrence("https://example.test/a")]),
      check("https://example.test/b", [
        occurrence("https://example.test/b", {
          element: { locator: "footer>a:2", structuralSignature: "other" },
        }),
      ]),
    ]);
    const groups = groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!.componentFixGroups!;
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(group.id).toMatch(/^component-fix:[0-9a-f]{32}$/);
    expect(new Set(groups.map((g) => g.id)).size).toBe(2);
    // The id must not carry the whole canonical identity: that ran to ~800 bytes
    // per group and rode on every serialized report.
    for (const group of groups) expect(group.id.length).toBeLessThan(64);
  });

  test("the digest is stable, and distinct inputs do not alias", () => {
    expect(componentFixGroupDigest("a")).toBe(componentFixGroupDigest("a"));
    expect(componentFixGroupDigest("a")).not.toBe(componentFixGroupDigest("b"));
    expect(componentFixGroupDigest("")).toMatch(/^[0-9a-f]{32}$/);
    // Non-ASCII must hash by its UTF-8 bytes, not by UTF-16 code units.
    expect(componentFixGroupDigest("é")).not.toBe(componentFixGroupDigest("e"));
    const digests = new Set(
      Array.from({ length: 2000 }, (_, i) => componentFixGroupDigest(`identity-${i}`)),
    );
    expect(digests.size).toBe(2000);
  });

  test("occurrenceRefs resolve even when grouping kept a different copy", () => {
    // `groupIssuesByCategory` dedupes by identity key, so the object the group
    // holds can be a DIFFERENT allocation from the one serialized under the
    // check. Resolving refs by object identity silently dropped those, leaving
    // occurrenceCount > occurrenceRefs.length.
    const a = occurrence("https://example.test/a");
    const aCopy = JSON.parse(JSON.stringify(a)) as ComponentOccurrence;
    const r = report([
      check("https://example.test/a", [a]),
      check("https://example.test/a", [aCopy]),
      check("https://example.test/b", [occurrence("https://example.test/b")]),
    ]);
    const issue = JSON.parse(renderJson(r)).issues[0];
    for (const group of issue.componentFixGroups) {
      expect(group.occurrenceRefs).toHaveLength(group.occurrenceCount);
      for (const ref of group.occurrenceRefs) {
        expect(issue.checks[ref.checkIndex]?.componentOccurrences?.[ref.occurrenceIndex]).toBeDefined();
      }
    }
  });

  test("evidence for the same observation seen twice is not double counted", () => {
    const shared = occurrence("https://example.test/a");
    // The same page's check merged twice: a carried finding re-observed fresh.
    const r = report([check("https://example.test/a", [shared]), check("https://example.test/a", [shared])]);
    const rule = groupIssuesByCategory(r.ruleResults)[0]!.rules[0]!;
    expect(rule.checks[0]!.componentOccurrences).toHaveLength(1);
  });
});
