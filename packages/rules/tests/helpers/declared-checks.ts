// A rule that declares `meta.checks` (#1741) emits only the names it declares, with a status the declared
// outcome allows. Used by the rule tests that exercise a declared rule, so drift fails where it happens.
import { expect } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import type { Rule } from "../../src/types";

const OUTCOME_OF_STATUS: Record<string, "problem" | "clean" | "skipped" | "any"> = {
  fail: "problem",
  warn: "problem",
  pass: "clean",
  skipped: "skipped",
  info: "any",
};

export function expectDeclaredChecks(rule: Rule, checks: readonly CheckResult[]): void {
  const declared = rule.meta.checks;
  if (!declared) return;
  for (const check of checks) {
    const outcomes = declared.filter((d) => d.name === check.name).map((d) => d.outcome);
    expect(outcomes.length, `${rule.meta.id} emitted undeclared check "${check.name}"`).toBeGreaterThan(0);
    const wanted = OUTCOME_OF_STATUS[check.status] ?? "any";
    if (wanted !== "any") {
      expect(
        outcomes,
        `${rule.meta.id} emitted "${check.name}" as ${check.status}, declared ${outcomes.join("/")}`,
      ).toContain(wanted);
    }
  }
}
