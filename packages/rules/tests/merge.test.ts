import { describe, expect, test } from "bun:test";
import { mergeRuleRunResult } from "../src/merge";
import type { CheckResult, RuleMeta, RuleRunResult } from "../src/types";

// The helper never reads check/meta internals — minimal cast fixtures are enough.
const check = (id: string): CheckResult => ({ id }) as unknown as CheckResult;
const ids = (rr: RuleRunResult | undefined) =>
  (rr?.checks ?? []).map((c) => (c as unknown as { id: string }).id);
const rr = (metaId: string, checks: CheckResult[]): RuleRunResult => ({
  meta: { id: metaId } as unknown as RuleMeta,
  checks,
});

describe("mergeRuleRunResult", () => {
  test("concatenates checks across pages in order", () => {
    const map = new Map<string, RuleRunResult>();
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [check("a1")]));
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [check("a2"), check("a3")]));
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [check("a4")]));
    expect(ids(map.get("ruleA"))).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("keeps distinct ruleIds separate", () => {
    const map = new Map<string, RuleRunResult>();
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [check("a1")]));
    mergeRuleRunResult(map, "ruleB", rr("ruleB", [check("b1"), check("b2")]));
    expect(ids(map.get("ruleA"))).toEqual(["a1"]);
    expect(ids(map.get("ruleB"))).toEqual(["b1", "b2"]);
  });

  test("preserves meta from the first insert", () => {
    const map = new Map<string, RuleRunResult>();
    mergeRuleRunResult(map, "ruleA", rr("metaX", [check("a1")]));
    mergeRuleRunResult(map, "ruleA", rr("metaY", [check("a2")]));
    expect((map.get("ruleA")!.meta as unknown as { id: string }).id).toBe(
      "metaX"
    );
  });

  // The core regression guard: first insert must store a PRIVATE copy so the
  // source array (shared by reference with per-page storage) is never mutated
  // when a later page accumulates into the same rule.
  test("does not mutate the source per-page checks arrays", () => {
    const map = new Map<string, RuleRunResult>();
    const page1 = [check("a1")]; // simulates pageRuleResults[page1][ruleA]
    mergeRuleRunResult(map, "ruleA", rr("ruleA", page1));
    const page2 = [check("a2"), check("a3")];
    mergeRuleRunResult(map, "ruleA", rr("ruleA", page2));

    expect(page1).toHaveLength(1); // page-1 view untouched
    expect(ids({ meta: {} as RuleMeta, checks: page1 })).toEqual(["a1"]);
    expect(page2).toHaveLength(2); // page-2 view untouched
    // ...while the accumulator has everything
    expect(ids(map.get("ruleA"))).toEqual(["a1", "a2", "a3"]);
  });

  test("mutating the accumulator does not leak back into the source", () => {
    const map = new Map<string, RuleRunResult>();
    const source = [check("a1")];
    mergeRuleRunResult(map, "ruleA", rr("ruleA", source));
    map.get("ruleA")!.checks.push(check("x")); // mutate accumulator
    expect(source).toHaveLength(1); // source unaffected
  });

  test("handles empty checks arrays (first insert and accumulation)", () => {
    const map = new Map<string, RuleRunResult>();
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [])); // empty first insert
    expect(ids(map.get("ruleA"))).toEqual([]);
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [])); // empty accumulation
    expect(ids(map.get("ruleA"))).toEqual([]);
    mergeRuleRunResult(map, "ruleA", rr("ruleA", [check("a1")])); // then non-empty
    expect(ids(map.get("ruleA"))).toEqual(["a1"]);
  });

  test("matches the previous spread-merge output exactly", () => {
    const pages = [["a"], ["b", "c"], ["d"], ["e", "f"]];

    // old behavior: re-spread the whole array each page (O(N²))
    const oldMap = new Map<string, RuleRunResult>();
    for (const p of pages) {
      const r = rr("r", p.map(check));
      const e = oldMap.get("r");
      if (e) oldMap.set("r", { meta: e.meta, checks: [...e.checks, ...r.checks] });
      // First insert intentionally stores `r` without copying — faithfully
      // reproducing the OLD behaviour we're asserting parity against (not a
      // missing copy; the new helper deliberately copies, see test below).
      else oldMap.set("r", r);
    }

    // new behavior
    const newMap = new Map<string, RuleRunResult>();
    for (const p of pages) mergeRuleRunResult(newMap, "r", rr("r", p.map(check)));

    expect(ids(newMap.get("r"))).toEqual(ids(oldMap.get("r")));
    expect(ids(newMap.get("r"))).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});
