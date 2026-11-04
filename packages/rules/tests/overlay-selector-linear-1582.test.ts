// #1582: the selector validity check is linear on hostile selectors. Each shape below was timed by hand at 22 ms or less; the
// bound here is generous (a quadratic reading of any of them takes minutes), so only a real regression trips it.

import { describe, expect, test } from "bun:test";

import { selectorListState } from "../src/integrity/overlay-style";

/** Far above the linear time on a slow CI machine, far below any quadratic one. */
const BOUND_MS = 1500;
const TEST_TIMEOUT_MS = 30_000;

const SHAPES: ReadonlyArray<readonly [name: string, build: () => string]> = [
  ["20,000 `:not(` opened and never closed", () => ".a" + ":not(".repeat(20_000)],
  ["20,000 `:not(` nested and closed", () => ".a" + ":not(".repeat(20_000) + ".b" + ")".repeat(20_000)],
  ["100,000 `[` opened and never closed", () => ".a" + "[".repeat(100_000)],
  ["100,000 commas", () => ",".repeat(100_000)],
  ["100,000 one-letter parts", () => "a,".repeat(100_000) + "b"],
  ["20,000 unknown pseudo-class parts in a list", () => ":bogus,".repeat(20_000) + ".a"],
  ["20,000 unknown pseudo-classes in one compound", () => ".a" + ":bogus".repeat(20_000)],
  ["5,000 nested `:is(`", () => ":is(".repeat(5_000) + ".a" + ")".repeat(5_000)],
  ["5,000 nested `:has(` and `:not(`", () => ":has(:not(".repeat(2_500) + ".a" + "))".repeat(2_500)],
  ["a 1 MB part", () => ".a" + "b".repeat(1_000_000)],
  ["a 1 MB part of unknown pseudo-classes", () => ".a" + ":x".repeat(500_000)],
  ["20,000 `:nth-child(` with an `of` list", () => ":nth-child(2n of ".repeat(20_000)],
  ["100,000 characters of nested `::slotted(`", () => "::slotted(".repeat(10_000)],
  ["100,000 characters of nested `:host(`", () => ":host(".repeat(16_667)],
  ["100,000 characters of nested `:host-context(`", () => ":host-context(".repeat(7_143)],
  ["`::slotted(` nested and closed", () => "::slotted(".repeat(10_000) + ".a" + ")".repeat(10_000)],
  ["`:host(` nested and closed", () => ":host(".repeat(16_667) + ".a" + ")".repeat(16_667)],
  ["`:host-context(` nested and closed", () => ":host-context(".repeat(7_143) + ".a" + ")".repeat(7_143)],
];

describe("selectorListState stays linear on hostile selectors (#1582)", () => {
  for (const [name, build] of SHAPES) {
    for (const relative of [false, true]) {
      test(`${name}${relative ? " (relative)" : ""} finishes under ${BOUND_MS} ms`, () => {
        const selector = build();
        const started = performance.now();
        const state = selectorListState(selector, relative);
        const elapsed = performance.now() - started;
        expect(["valid", "doubtful", "invalid"]).toContain(state);
        expect(elapsed, `${name}: ${elapsed.toFixed(0)} ms`).toBeLessThan(BOUND_MS);
      }, TEST_TIMEOUT_MS);
    }
  }

  test("doubling a shape does not much more than double the time (a quadratic shape would quadruple it)", () => {
    const time = (n: number): number => {
      const selector = ".a" + ":not(".repeat(n);
      const started = performance.now();
      selectorListState(selector, false);
      return performance.now() - started;
    };
    time(5_000);
    const small = Math.max(time(20_000), 5);
    const large = time(80_000);
    // a generous factor: linear is 4, quadratic is 16
    expect(large / small, `${small.toFixed(1)} ms to ${large.toFixed(1)} ms`).toBeLessThan(12);
  }, TEST_TIMEOUT_MS);
});
