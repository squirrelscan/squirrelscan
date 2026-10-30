// `discoveryDeadlineAt` (#1271): the crawl's discovery budget is cut to the deadline, never widened.

import { describe, expect, test } from "bun:test";

import { discoveryBudgetMs, preambleBudgetMs } from "../src/core/crawler";

describe("discoveryBudgetMs", () => {
  const timeoutMs = 30_000;
  const base = preambleBudgetMs(timeoutMs);

  test("no deadline keeps the preamble budget", () => {
    expect(discoveryBudgetMs(timeoutMs)).toBe(base);
  });

  test("a near deadline cuts it to what is left", () => {
    expect(discoveryBudgetMs(timeoutMs, 10_000, 7_000)).toBe(3_000);
  });

  test("a far deadline never widens it", () => {
    expect(discoveryBudgetMs(timeoutMs, 10_000_000, 0)).toBe(base);
  });

  test("a spent deadline leaves 1 ms, not zero (zero reads as no budget)", () => {
    expect(discoveryBudgetMs(timeoutMs, 5_000, 9_000)).toBe(1);
  });
});
