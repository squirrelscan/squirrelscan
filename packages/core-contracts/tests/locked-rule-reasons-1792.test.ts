// #1792: the locked-rule reason set, and the guard that nothing outside it is a reason. `credits` sits beside
// the others; a reader that predates it sees an unknown value and reads it as no reason.

import { describe, expect, test } from "bun:test";

import { isLockedRuleReason, LOCKED_RULE_REASONS } from "../src";

describe("LOCKED_RULE_REASONS", () => {
  test("holds credits beside plan, provider_error and unsupported_environment, in the documented order", () => {
    expect([...LOCKED_RULE_REASONS]).toEqual(["plan", "credits", "provider_error", "unsupported_environment"]);
  });

  test("isLockedRuleReason accepts each and nothing else", () => {
    for (const reason of LOCKED_RULE_REASONS) expect(isLockedRuleReason(reason)).toBe(true);
    for (const other of ["Credits", "credit", "outage", "", undefined, null, 1, {}]) {
      expect(isLockedRuleReason(other)).toBe(false);
    }
  });
});
