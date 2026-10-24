import { describe, expect, test } from "bun:test";

import { filterRules } from "../src/filter";
import { loadAllRules } from "../src/loader";
import { createRunner } from "../src/runner";

const GAP_RULES = ["gaps/keywords", "gaps/content"];

function selected(
  enable: string[],
  ruleOptions: Record<string, { enabled?: boolean }> = {}
): string[] {
  const registry = loadAllRules({ includeOptIn: true });
  return filterRules([...registry.keys()], enable, [], ruleOptions, registry);
}

describe("opt-in rules", () => {
  test("the default registry omits opt-in rules", () => {
    const registry = loadAllRules();
    expect(GAP_RULES.filter((id) => registry.has(id))).toEqual([]);
  });

  test("the default wildcard does not select paid gap rules", () => {
    const ids = selected(["*"]);
    expect(GAP_RULES.filter((id) => ids.includes(id))).toEqual([]);
  });

  test("an exact or category enable pattern selects gap rules", () => {
    expect(selected(["gaps/keywords"])).toContain("gaps/keywords");
    expect(selected(["gaps/*"])).toEqual(GAP_RULES);
  });

  test("rule_options enabled = true selects an opt-in rule", () => {
    expect(
      selected(["*"], { "gaps/content": { enabled: true } })
    ).toContain("gaps/content");
  });

  test("the runner uses the same opt-in selection", () => {
    const defaultRunner = createRunner({
      rules: { enable: ["*"], disable: [] },
      rule_options: {},
    });
    const defaultIds = defaultRunner.getEnabledRules().map((rule) => rule.meta.id);
    expect(GAP_RULES.filter((id) => defaultIds.includes(id))).toEqual([]);

    const gapRunner = createRunner({
      rules: { enable: ["gaps/*"], disable: [] },
      rule_options: {},
    });
    expect(gapRunner.getEnabledRules().map((rule) => rule.meta.id)).toEqual(
      GAP_RULES
    );
  });
});
