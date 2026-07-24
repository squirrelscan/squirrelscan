// Tarpit-aware fetch budget (#1252). Fake clock so budget/tarpit transitions are
// deterministic — no real timers.

import { describe, expect, test } from "bun:test";

import { createFetchBudget } from "../src/fetch-budget";

/** Controllable clock: `set`/`advance` drive `now`. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (dv: number) => {
      t += dv;
    },
  };
}

describe("createFetchBudget", () => {
  test("inert with no options — never skips, never degrades", () => {
    const b = createFetchBudget();
    expect(b.shouldSkip("https://a.com/x")).toBe(false);
    b.record("https://a.com/x", 999_999, "timeout");
    expect(b.shouldSkip("https://a.com/y")).toBe(false);
    expect(b.summary().degraded).toBe(false);
  });

  test("skips every fetch once the total budget is spent", () => {
    const clock = fakeClock();
    const b = createFetchBudget({ totalBudgetMs: 1000, now: clock.now });

    expect(b.shouldSkip("https://a.com/1")).toBe(false);
    clock.set(1000); // deadline reached
    expect(b.shouldSkip("https://a.com/2")).toBe(true);
    expect(b.shouldSkip("https://b.com/3")).toBe(true);

    const s = b.summary();
    expect(s.degraded).toBe(true);
    expect(s.reason).toBe("budget");
    expect(s.skipped).toBe(2);
  });

  test("skips a host after N consecutive slow/errored strikes, sparing others", () => {
    const b = createFetchBudget({ tarpitLatencyMs: 5000, tarpitStrikes: 3 });
    const slow = "https://slow.com/";
    const fast = "https://fast.com/";

    // Two strikes: not yet flagged.
    b.record(slow + "1", 6000, "ok"); // slow → strike 1
    b.record(slow + "2", 0, "timeout"); // timeout → strike 2
    expect(b.shouldSkip(slow + "3")).toBe(false);

    // Third strike flags the host.
    b.record(slow + "3", 7000, "ok"); // strike 3 → tarpit
    expect(b.shouldSkip(slow + "4")).toBe(true);
    // A different host is unaffected.
    expect(b.shouldSkip(fast + "1")).toBe(false);

    const s = b.summary();
    expect(s.degraded).toBe(true);
    expect(s.reason).toBe("tarpit");
    expect(s.tarpitHosts).toEqual(["slow.com"]);
    expect(s.skipped).toBe(1);
  });

  test("a fast success clears the strike streak — transient slowness is not a tarpit", () => {
    const b = createFetchBudget({ tarpitLatencyMs: 5000, tarpitStrikes: 3 });
    const h = "https://h.com/";
    b.record(h + "1", 6000, "ok"); // strike 1
    b.record(h + "2", 6000, "ok"); // strike 2
    b.record(h + "3", 100, "ok"); // fast → resets streak
    b.record(h + "4", 6000, "ok"); // strike 1 again
    b.record(h + "5", 6000, "ok"); // strike 2
    expect(b.shouldSkip(h + "6")).toBe(false); // never reached 3 consecutive
    expect(b.summary().degraded).toBe(false);
  });

  test("budget exhaustion outranks a later tarpit in the reported reason", () => {
    const clock = fakeClock();
    const b = createFetchBudget({
      totalBudgetMs: 1000,
      tarpitLatencyMs: 1,
      tarpitStrikes: 1,
      now: clock.now,
    });
    clock.set(1000);
    b.shouldSkip("https://a.com/x"); // budget skip → reason "budget"
    b.record("https://a.com/y", 5000, "timeout"); // would flag tarpit
    expect(b.summary().reason).toBe("budget");
  });

  test("counts attempted vs skipped and reports elapsed", () => {
    const clock = fakeClock(100);
    const b = createFetchBudget({ totalBudgetMs: 50, now: clock.now });
    b.record("https://a.com/1", 10, "ok");
    b.record("https://a.com/2", 10, "ok");
    clock.set(150); // deadline
    b.shouldSkip("https://a.com/3");
    const s = b.summary();
    expect(s.attempted).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.elapsedMs).toBe(50);
  });
});
