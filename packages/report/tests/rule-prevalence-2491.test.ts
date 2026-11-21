import type { ReportRuleResult } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import {
  flattenIssuesBySeverity,
  groupIssuesByCategory,
} from "../src/grouping";
import {
  isNearUniversal,
  prevalenceNote,
  rulePrevalence,
  type RulePrevalenceData,
} from "../src/rule-prevalence";
import prevalenceJson from "../src/rule-prevalence.json";

const sample: RulePrevalenceData = {
  generatedAt: "2026-11-15",
  sites: 10,
  prevalence: { "core/common": 0.9, "core/rare": 0.1, "core/edge": 0.7 },
  kept: {},
};

describe("rule prevalence (#2491)", () => {
  test("above 70% is near-universal, exactly 70% and unknown are not", () => {
    expect(isNearUniversal("core/common", sample)).toBe(true);
    expect(isNearUniversal("core/edge", sample)).toBe(false);
    expect(isNearUniversal("core/unknown", sample)).toBe(false);
    expect(rulePrevalence("core/rare", sample)).toBe(0.1);
    expect(rulePrevalence("constructor", sample)).toBeUndefined();
  });

  test("the note states the share and only exists for near-universal rules", () => {
    expect(prevalenceNote("core/common", sample)).toContain("90% of sites");
    expect(prevalenceNote("core/rare", sample)).toBeUndefined();
  });

  test("the shipped data file has the expected shape", () => {
    expect(typeof prevalenceJson.sites).toBe("number");
    for (const p of Object.values(
      prevalenceJson.prevalence as Record<string, number>
    )) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe("ranking by prevalence (#2491)", () => {
  // The shipped data is empty until a corpus run lands, so exercise the sort
  // through the real data file only when it names a near-universal rule.
  const results = (ids: string[]): Record<string, ReportRuleResult> =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          meta: {
            id,
            name: id,
            description: "",
            category: "core",
            scope: "page",
            severity: "warning",
            weight: 5,
          },
          checks: [
            {
              name: "C",
              status: "warn",
              message: "m",
              pageUrl: "https://e.com/",
            },
          ],
        } as ReportRuleResult,
      ])
    );

  test("without prevalence data order is unchanged (weight then id)", () => {
    const flat = flattenIssuesBySeverity(
      groupIssuesByCategory(results(["core/b", "core/a"]))
    );
    expect(flat.map((r) => r.id)).toEqual(["core/a", "core/b"]);
    expect(flat.every((r) => r.prevalenceNote === undefined)).toBe(true);
  });

  test("a near-universal rule sorts after a distinctive one of equal severity, with a note", () => {
    const grouped = groupIssuesByCategory(
      results(["core/common", "core/rare", "core/z-rare"]),
      undefined,
      sample
    );
    const flat = flattenIssuesBySeverity(grouped);
    expect(flat.map((r) => r.id)).toEqual([
      "core/rare",
      "core/z-rare",
      "core/common",
    ]);
    expect(flat[2].prevalenceNote).toContain("90% of sites");
    expect(grouped[0].rules.map((r) => r.id)).toEqual([
      "core/rare",
      "core/z-rare",
      "core/common",
    ]);
  });

  test("prevalence never outranks severity", () => {
    const r = results(["core/common", "core/rare"]);
    r["core/common"].meta.severity = "error";
    (r["core/common"].checks[0] as { status: string }).status = "fail";
    const flat = flattenIssuesBySeverity(
      groupIssuesByCategory(r, undefined, sample)
    );
    expect(flat.map((x) => x.id)).toEqual(["core/common", "core/rare"]);
  });
});
