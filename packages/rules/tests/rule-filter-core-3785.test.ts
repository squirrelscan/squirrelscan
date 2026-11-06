import { describe, expect, test } from "bun:test";

import {
  findUnmatchedRulePatterns,
  loadAllRules,
  parseRuleFilters,
  selectRuleIds,
} from "../src";

describe("rule-filter core (shared by the CLI and the cloud API, private#3785)", () => {
  test("parseRuleFilters expands bare categories and validates the category half", () => {
    const ok = parseRuleFilters("ax,core/robots-meta", undefined);
    expect(ok.errors).toEqual([]);
    expect(ok.enable).toEqual(["ax/*", "core/robots-meta"]);
    expect(parseRuleFilters("bogus/thing", undefined).errors).toHaveLength(1);
  });

  test("findUnmatchedRulePatterns lists exactly the dead patterns (typo'd rule id, same category)", () => {
    const ids = [...loadAllRules().keys()];
    expect(
      findUnmatchedRulePatterns(["ax/*", "core/robots-meta", "core/robots-metaa", "ax/nope"], ids)
    ).toEqual(["core/robots-metaa", "ax/nope"]);
    expect(findUnmatchedRulePatterns([], ids)).toEqual([]);
  });

  test("selectRuleIds is the matcher's own selection: ax/* + core/robots-meta", () => {
    const rules = loadAllRules();
    const selected = selectRuleIds(["ax/*", "core/robots-meta"]);
    const expected = [...rules.values()]
      .filter((r) => r.meta.category === "ax" || r.meta.id === "core/robots-meta")
      .map((r) => r.meta.id);
    expect(selected.toSorted()).toEqual(expected.toSorted());
    // Legacy `ai/` ids filed under category ax ARE ax rules: ax/* reaches them
    // through the category alias, exactly as `--rule-include ax` does.
    expect(selected).toContain("ai/site-metadata");
    expect(selected).toContain("ai/page-type-match");
    expect(selected).not.toContain("core/meta-title");
  });

  test("an exact legacy-prefixed id selects only itself", () => {
    expect(selectRuleIds(["ai/site-metadata"])).toEqual(["ai/site-metadata"]);
  });
});
