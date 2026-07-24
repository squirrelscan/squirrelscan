// #150 — groupIssuesByCategory must emit a stable order for repeat audits.
// #114's bounded-concurrency rule execution feeds checks/rules in a
// nondeterministic order; grouping now sorts each check's pages/items, the
// per-rule check list, equal-weight/equal-subcategory rules (by id), and
// equal-priority categories (by code). These tests shuffle the input and
// assert byte-identical (JSON.stringify-equal) output.

import { describe, expect, test } from "bun:test";
import type { ReportRuleResult } from "@squirrelscan/core-contracts";

import { groupIssuesByCategory } from "../src/grouping";

function rule(
  id: string,
  category: string,
  weight: number,
  checks: ReportRuleResult["checks"]
): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "",
      category,
      scope: "page",
      severity: "error",
      weight,
    },
    checks,
  };
}

describe("groupIssuesByCategory deterministic ordering (#150)", () => {
  test("a check's affected pages are sorted regardless of check order", () => {
    const results: Record<string, ReportRuleResult> = {
      "core/x": rule("core/x", "core", 5, [
        { name: "C", status: "fail", message: "broken", pageUrl: "https://e.com/z" },
        { name: "C", status: "fail", message: "broken", pageUrl: "https://e.com/a" },
        { name: "C", status: "fail", message: "broken", pageUrl: "https://e.com/m" },
      ]),
    };
    const grouped = groupIssuesByCategory(results);
    const check = grouped[0].rules[0].checks[0];
    expect(check.pages).toEqual([
      "https://e.com/a",
      "https://e.com/m",
      "https://e.com/z",
    ]);
  });

  test("a check's items are sorted by id", () => {
    const results: Record<string, ReportRuleResult> = {
      "core/x": rule("core/x", "core", 5, [
        {
          name: "C",
          status: "fail",
          message: "broken",
          items: [
            { id: "z", label: "Z" },
            { id: "a", label: "A" },
            { id: "m", label: "M" },
          ],
        },
      ]),
    };
    const grouped = groupIssuesByCategory(results);
    const items = grouped[0].rules[0].checks[0].items ?? [];
    expect(items.map((i) => i.id)).toEqual(["a", "m", "z"]);
  });

  test("equal-weight rules in a category tie-break by id; weight stays primary", () => {
    // bbb (w5), aaa (w5), zzz (w9). zzz has the higher weight so it must lead
    // even though its id sorts last — weight is the PRIMARY key. The two w5
    // rules then sort aaa before bbb by id.
    const failCheck = [
      { name: "C", status: "fail" as const, message: "x", pageUrl: "https://e.com/p" },
    ];
    const results: Record<string, ReportRuleResult> = {
      "core/bbb": rule("core/bbb", "core", 5, failCheck),
      "core/aaa": rule("core/aaa", "core", 5, failCheck),
      "core/zzz": rule("core/zzz", "core", 9, failCheck),
    };
    const grouped = groupIssuesByCategory(results);
    expect(grouped[0].rules.map((r) => r.id)).toEqual([
      "core/zzz", // weight 9 wins (primary key)
      "core/aaa", // weight 5, id tie-break
      "core/bbb",
    ]);
  });

  test("shuffled input → byte-identical grouped output", () => {
    const failCheck = (page: string) => [
      { name: "C", status: "fail" as const, message: "broken", pageUrl: page },
    ];
    const base: Array<[string, ReportRuleResult]> = [
      ["core/a", rule("core/a", "core", 5, failCheck("https://e.com/2"))],
      ["core/b", rule("core/b", "core", 5, failCheck("https://e.com/1"))],
      ["perf/c", rule("perf/c", "perf", 5, failCheck("https://e.com/3"))],
      ["security/d", rule("security/d", "security", 5, failCheck("https://e.com/4"))],
      ["core/e", rule("core/e", "core", 9, failCheck("https://e.com/5"))],
    ];

    const orderA: Record<string, ReportRuleResult> = Object.fromEntries(base);
    const orderB: Record<string, ReportRuleResult> = Object.fromEntries(
      [...base].reverse()
    );

    const a = JSON.stringify(groupIssuesByCategory(orderA));
    const b = JSON.stringify(groupIssuesByCategory(orderB));
    expect(a).toBe(b);
  });

  test("a rule's check list is sorted (name, status, message)", () => {
    // Three distinct checks fed in scrambled order; grouped output orders them
    // by name then status then message.
    const results: Record<string, ReportRuleResult> = {
      "core/x": rule("core/x", "core", 5, [
        { name: "Bravo", status: "warn", message: "m", pageUrl: "https://e.com/1" },
        { name: "Alpha", status: "fail", message: "m", pageUrl: "https://e.com/2" },
        { name: "Alpha", status: "fail", message: "a", pageUrl: "https://e.com/3" },
      ]),
    };
    const grouped = groupIssuesByCategory(results);
    const checks = grouped[0].rules[0].checks;
    expect(checks.map((c) => `${c.name}|${c.status}|${c.message}`)).toEqual([
      "Alpha|fail|a",
      "Alpha|fail|m",
      "Bravo|warn|m",
    ]);
  });
});
