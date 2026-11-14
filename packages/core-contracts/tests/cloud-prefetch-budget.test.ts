// #2129: the full-coverage prefetch budget rule (600 ms a page, at most 25% of
// the run, never more than half of it) lives in core-contracts, so the engine
// and the hosted runtime read one rule.

import { describe, expect, test } from "bun:test";

import {
  AUDIT_RUNTIME,
  CLOUD_PREFETCH_PER_PAGE_MS,
  CLOUD_PREFETCH_RUN_SHARE,
  resolveCloudPrefetchBudgetMs,
} from "../src/limits";

const HOUR = 3_600_000;

describe("resolveCloudPrefetchBudgetMs", () => {
  test("documents the rate and the share", () => {
    expect(CLOUD_PREFETCH_PER_PAGE_MS).toBe(600);
    expect(CLOUD_PREFETCH_RUN_SHARE).toBe(0.25);
  });

  test("no page count, or a bad one, gives the per-coverage floor", () => {
    expect(resolveCloudPrefetchBudgetMs("full", undefined, HOUR)).toBe(600_000);
    expect(resolveCloudPrefetchBudgetMs("surface", 0, HOUR)).toBe(300_000);
    expect(resolveCloudPrefetchBudgetMs("quick", Number.NaN, HOUR)).toBe(45_000);
    expect(AUDIT_RUNTIME.cloudPrefetchBudgetByCoverageMs.full).toBe(600_000);
  });

  test("a small crawl never gets less than its floor", () => {
    expect(resolveCloudPrefetchBudgetMs("full", 100, HOUR)).toBe(600_000);
  });

  test("scales at 600 ms a page above the floor", () => {
    // 2,000 pages x 600 ms = 1,200 s, under 25% of a 2 h run (1,800 s).
    expect(resolveCloudPrefetchBudgetMs("full", 2_000, 2 * HOUR)).toBe(1_200_000);
  });

  test("is capped at 25% of the run", () => {
    // 10,000 pages would ask for 6,000 s; a 2 h run allows 1,800 s.
    expect(resolveCloudPrefetchBudgetMs("full", 10_000, 2 * HOUR)).toBe(1_800_000);
  });

  test("never exceeds half the run, when the runtime was overridden down", () => {
    // 700 s runtime: floor 600 s would outlive half of it.
    expect(resolveCloudPrefetchBudgetMs("full", 2_000, 700_000)).toBe(350_000);
  });

  test("an unknown coverage reads as quick", () => {
    expect(resolveCloudPrefetchBudgetMs("nope" as never, undefined, HOUR)).toBe(45_000);
  });
});
