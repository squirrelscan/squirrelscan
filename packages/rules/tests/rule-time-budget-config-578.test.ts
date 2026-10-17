// #578 — `[rules] time_budget_ms` sets the per-rule time budget, and `0` turns it
// off. `RunnerOptions.ruleTimeBudgetMs` (what tests and the cloud pass) still wins.

import { describe, expect, test } from "bun:test";

import type { RuleNamespace } from "../src/loader";
import { RULE_TIME_BUDGET_MS } from "../src/rule-budget";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData, Rule } from "../src/types";

/** A page rule that spins for `ms` of wall-clock time. */
function spinRule(id: string, ms: number): Rule {
  return {
    meta: { id, name: id, description: "test rule", category: "core", scope: "page", severity: "info", weight: 1 },
    run: () => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        // spin
      }
      return { checks: [{ name: id, status: "pass", message: "ok" }] };
    },
  };
}

function makeRunner(rule: Rule, timeBudgetMs?: number, optionBudgetMs?: number): RuleRunner {
  const config: RulesConfig = {
    rule_options: {},
    rules: { enable: [rule.meta.id], ...(timeBudgetMs === undefined ? {} : { time_budget_ms: timeBudgetMs }) },
  };
  const ns: RuleNamespace = { name: "test", rules: [rule] };
  return new RuleRunner({ config, additionalNamespaces: [ns], ruleTimeBudgetMs: optionBudgetMs });
}

const page: PageData = {
  url: "https://example.com/",
  html: "<html><body><p>hi</p></body></html>",
  statusCode: 200,
  loadTime: 0,
  headers: {},
};

describe("[rules] time_budget_ms (#578)", () => {
  test("unset keeps the engine default", () => {
    expect(makeRunner(spinRule("test/spin", 0)).ruleTimeBudgetMs).toBe(RULE_TIME_BUDGET_MS);
  });

  test("the config key sets the budget, and the runner option wins over it", () => {
    expect(makeRunner(spinRule("test/spin", 0), 2500).ruleTimeBudgetMs).toBe(2500);
    expect(makeRunner(spinRule("test/spin", 0), 2500, 400).ruleTimeBudgetMs).toBe(400);
  });

  test("a rule past the configured budget is abandoned with that budget in its error", async () => {
    const runner = makeRunner(spinRule("test/spin", 5_000), 50);
    const started = performance.now();
    const { checks } = await runner.runPageRules(page);
    expect(performance.now() - started).toBeLessThan(4_000);
    const err = checks.find((c) => c.name === "test/spin-error");
    expect(err?.message).toContain("exceeded its 50 ms time budget");
    expect(err?.details).toEqual({ timedOut: true, budgetMs: 50, pages: 1 });
  });

  test("0 turns the budget off: a rule slower than the default still finishes", async () => {
    const runner = makeRunner(spinRule("test/spin", RULE_TIME_BUDGET_MS + 200), 0);
    const { checks } = await runner.runPageRules(page);
    expect(checks.find((c) => c.name === "test/spin")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "test/spin-error")).toBeUndefined();
  }, 10_000);
});
