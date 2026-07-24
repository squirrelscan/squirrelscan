// #780: CLI footer must surface the locked-rules count + action so a signed-in
// run with skipped cloud rules (quick coverage, 0 credits) doesn't just show
// "Credits used: 0" and look like a complete audit.

import { describe, expect, test } from "bun:test";

import { lockedRulesFooterLine } from "../src/cli/banner";

const ONE_RULE = [{ id: "ai/llm-parsability", name: "LLM Parsability" }];

describe("lockedRulesFooterLine", () => {
  test("returns null when there are no locked rules", () => {
    expect(lockedRulesFooterLine({})).toBeNull();
    expect(lockedRulesFooterLine({ lockedRules: [] })).toBeNull();
  });

  test("anonymous run: count + signup action", () => {
    const line = lockedRulesFooterLine({ lockedRules: ONE_RULE });
    expect(line).toContain("1 more check with cloud audits");
    expect(line).toContain("free squirrelscan account");
    expect(line).toContain("https://squirrelscan.com");
  });

  test("signed-in + quick coverage: coverage hint, not signup/credits copy", () => {
    const line = lockedRulesFooterLine({
      lockedRules: ONE_RULE,
      cloudPlan: "paid",
      coverageMode: "quick",
    });
    expect(line).toContain("-C surface or -C full");
    expect(line).not.toContain("free squirrelscan account");
    expect(line).not.toContain("out of credits");
  });

  test("signed-in free plan out of credits: dashboard action, no signup copy", () => {
    const line = lockedRulesFooterLine({
      lockedRules: ONE_RULE,
      cloudPlan: "free",
    });
    expect(line).toContain("didn't run this audit");
    expect(line).toContain("Add credits in your dashboard");
    expect(line).not.toContain("free squirrelscan account");
  });
});
