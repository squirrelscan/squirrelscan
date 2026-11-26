// #2343: every RuleResult a declared rule returns during the packages/rules tests is checked against
// `meta.checks`, problem runs included. The preload installs it by wrapping `run` on each loaded rule, so a
// rule test needs no per-test assertion. A rule without `meta.checks` is skipped until its tranche declares it.
import type { CheckResult } from "@squirrelscan/core-contracts";

import type { Rule, RuleResult } from "../../src/types";

export const GUARDED = Symbol.for("squirrelscan.undeclaredCheckGuard");

/** Names a result carries that the rule does not declare. Empty for an undeclared rule. */
export function undeclaredNames(
  rule: Pick<Rule, "meta">,
  checks: readonly Pick<CheckResult, "name">[]
): string[] {
  const declared = rule.meta.checks;
  if (!declared) return [];
  const names = new Set(declared.map((d) => d.name));
  return [...new Set(checks.map((c) => c.name))].filter((n) => !names.has(n));
}

export function assertDeclaredResult(
  rule: Pick<Rule, "meta">,
  result: RuleResult | undefined
): void {
  const bad = undeclaredNames(rule, result?.checks ?? []);
  if (bad.length > 0) {
    throw new Error(
      `${rule.meta.id} emitted undeclared check ${bad.map((n) => `"${n}"`).join(", ")}: add it to meta.checks`
    );
  }
}

/** Wrap `run` once; sync stays sync, async stays async. */
export function guardRule(rule: Rule): void {
  const run = rule.run as Rule["run"] & { [GUARDED]?: true };
  if (run[GUARDED] || !rule.meta.checks) return;
  const original = run.bind(rule);
  const wrapped = ((ctx) => {
    const out = original(ctx);
    if (out && typeof (out as Promise<RuleResult>).then === "function") {
      return (out as Promise<RuleResult>).then((r) => {
        assertDeclaredResult(rule, r);
        return r;
      });
    }
    assertDeclaredResult(rule, out as RuleResult);
    return out;
  }) as Rule["run"] & { [GUARDED]?: true };
  wrapped[GUARDED] = true;
  rule.run = wrapped;
}
