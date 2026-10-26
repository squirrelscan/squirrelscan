import { describe, expect, test } from "bun:test";

import { filterRules, isRuleEnabled } from "../src/filter";

describe("opt-in rule filtering", () => {
  test("the default wildcard does not select an opt-in rule", () => {
    expect(
      isRuleEnabled("gaps/keywords", ["*"], [], undefined, true)
    ).toBe(false);
  });

  test("a concrete rule or category pattern selects an opt-in rule", () => {
    expect(
      isRuleEnabled(
        "gaps/keywords",
        ["gaps/keywords"],
        [],
        undefined,
        true
      )
    ).toBe(true);
    expect(
      isRuleEnabled("gaps/keywords", ["gaps/*"], [], undefined, true)
    ).toBe(true);
  });

  test("per-rule enabled true selects an opt-in rule", () => {
    expect(
      isRuleEnabled("gaps/keywords", ["*"], [], { enabled: true }, true)
    ).toBe(true);
  });

  test("filterRules reads opt-in metadata from the registry", () => {
    const registry = new Map([
      ["core/meta-title", { meta: {} }],
      ["gaps/keywords", { meta: { optIn: true } }],
    ]);

    expect(filterRules([...registry.keys()], ["*"], [], {}, registry)).toEqual([
      "core/meta-title",
    ]);
    expect(
      filterRules([...registry.keys()], ["gaps/*"], [], {}, registry)
    ).toEqual(["gaps/keywords"]);
  });
});
