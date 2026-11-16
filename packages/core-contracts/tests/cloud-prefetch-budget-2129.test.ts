// The cloud prefetch budget's scaling values live in core-contracts (repo#2129).
//
// They moved here from the private cloud runner as a pure move: same values, so
// no run's prefetch budget changed. This pins both, and the full-coverage floor
// they scale up from, so a change to any of them is a deliberate one.

import { describe, expect, test } from "bun:test";

import { AUDIT_RUNTIME } from "../src/limits";

describe("cloud prefetch budget (repo#2129)", () => {
  test("600 ms a page, at most a quarter of the run", () => {
    expect(AUDIT_RUNTIME.cloudPrefetchPerPageMs).toBe(600);
    expect(AUDIT_RUNTIME.cloudPrefetchRunShare).toBe(0.25);
  });

  test("the full-coverage floor the scaling starts from is unchanged", () => {
    expect(AUDIT_RUNTIME.cloudPrefetchBudgetByCoverageMs.full).toBe(600_000);
  });
});
