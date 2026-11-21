// pub#2098: carriedCheckAsFailure keeps the continuation mark on an extra item
// row, so a multi-item check converted to a failure still counts as ONE failed
// check on its page, not one per item.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import {
  addChecksToTally,
  carriedCheckAsFailure,
  emptyTally,
  isCarriedContinuation,
  markCarriedContinuations,
} from "../src/scoring";

function itemRow(n: number): CheckResult {
  return {
    name: "images-missing-alt",
    status: "warn",
    message: `image ${n} has no alt`,
    pageUrl: "https://example.com/",
    items: [{ id: `https://example.com/img-${n}.png` }],
  };
}

describe("carriedCheckAsFailure continuation mark", () => {
  test("converted continuation rows keep the mark and the first row does not have it", () => {
    const rows = [itemRow(1), itemRow(2), itemRow(3)];
    markCarriedContinuations(rows);
    const failures = rows.map(carriedCheckAsFailure);

    expect(failures.every((c) => c.status === "fail")).toBe(true);
    expect(failures.map(isCarriedContinuation)).toEqual([false, true, true]);
  });

  test("one check name with several items counts as one failed check", () => {
    const rows = [itemRow(1), itemRow(2), itemRow(3), itemRow(4)];
    markCarriedContinuations(rows);
    const tally = emptyTally();
    addChecksToTally(tally, rows.map(carriedCheckAsFailure));

    expect(tally.failed).toBe(1);
    // Item units still feed the density penalty: one per item row.
    expect(tally.failUnits).toBe(rows.length);
  });
});
