// #2343: the guard that checks every declared rule's results against meta.checks.
import { describe, expect, test } from "bun:test";

import type { Rule, RuleContext } from "../src/types";

import { loadKnownRules } from "../src/loader";
import {
  GUARDED,
  assertDeclaredResult,
  guardRule,
  undeclaredNames,
} from "./helpers/undeclared-check-guard";

const check = (name: string, status: "pass" | "fail") => ({
  name,
  status,
  message: "m",
});

function fake(checks: Rule["meta"]["checks"], emit: string): Rule {
  return {
    meta: { id: "test/fake", checks } as Rule["meta"],
    run: () => ({ checks: [check(emit, "fail")] }),
  };
}

const declared: Rule["meta"]["checks"] = [
  { name: "fake", outcome: "clean", clears: ["fake-bad"] },
  { name: "fake-bad", outcome: "problem" },
];

describe("undeclared check guard (#2343)", () => {
  test("a declared rule emitting an undeclared problem name fails", () => {
    const rule = fake(declared, "fake-typo");
    guardRule(rule);
    expect(() => rule.run({} as RuleContext)).toThrow(
      /undeclared check "fake-typo"/
    );
  });

  test("an async declared rule is checked too", async () => {
    const rule = fake(declared, "fake-typo");
    const sync = rule.run;
    rule.run = async (ctx) => sync(ctx);
    guardRule(rule);
    await expect(rule.run({} as RuleContext)).rejects.toThrow(/fake-typo/);
  });

  test("a declared problem name passes", () => {
    const rule = fake(declared, "fake-bad");
    guardRule(rule);
    expect(rule.run({} as RuleContext)).toEqual({
      checks: [check("fake-bad", "fail")],
    });
  });

  test("an undeclared rule is skipped", () => {
    const rule = fake(undefined, "anything");
    const before = rule.run;
    guardRule(rule);
    expect(rule.run).toBe(before);
    expect(undeclaredNames(rule, [check("anything", "fail")])).toEqual([]);
    expect(() =>
      assertDeclaredResult(rule, rule.run({} as RuleContext) as never)
    ).not.toThrow();
  });

  test("the preload wraps every declared built-in rule and no other", () => {
    for (const rule of loadKnownRules().values()) {
      const wrapped = (rule.run as unknown as Record<symbol, unknown>)[GUARDED];
      expect(wrapped === true, rule.meta.id).toBe(
        rule.meta.checks !== undefined
      );
    }
  });
});
