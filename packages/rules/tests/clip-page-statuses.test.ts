// clipPageStatusesToBytes (#1028): `pageStatuses` lists every non-2xx page, so it
// is sized by pages crawled and per-check sampling cannot shrink it. The
// resolution publish builder (buildPublishResolution) clips it to a byte budget.

import { describe, expect, test } from "bun:test";

import { clipPageStatusesToBytes } from "../src/fold";

const BUDGET = 4 * 1024 * 1024;

describe("clipPageStatusesToBytes (#1028)", () => {
  const budget = BUDGET;
  const statuses = (n: number, urlLen = 40) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://x.test/p/${i}`.padEnd(urlLen, "a"),
      status: 404,
    }));
  const bytes = (arr: unknown) =>
    new TextEncoder().encode(JSON.stringify(arr)).length;

  test("leaves an array already inside the budget completely alone", () => {
    const r = { pageStatuses: statuses(100) };
    const before = r.pageStatuses;
    clipPageStatusesToBytes(r, budget);
    expect(r.pageStatuses).toBe(before);
    expect(r.pageStatuses).toHaveLength(100);
  });

  test("clips an over-budget array to fit, and the result really is under", () => {
    const r = { pageStatuses: statuses(20_000, 300) };
    expect(bytes(r.pageStatuses)).toBeGreaterThan(budget);
    clipPageStatusesToBytes(r, budget);
    expect(r.pageStatuses.length).toBeLessThan(20_000);
    expect(bytes(r.pageStatuses)).toBeLessThanOrEqual(budget);
  });

  // The point of budgeting BYTES rather than entries: entry size varies by three
  // orders of magnitude with URL length, so a fixed count is either wasteful for
  // short URLs or useless for long ones.
  test("keeps far more short URLs than long ones for the same budget", () => {
    // A budget both arrays overrun, so the comparison is about entry size and
    // not about one of them happening to fit.
    const small = 100_000;
    const shortR = { pageStatuses: statuses(20_000, 40) };
    const longR = { pageStatuses: statuses(20_000, 2000) };
    clipPageStatusesToBytes(shortR, small);
    clipPageStatusesToBytes(longR, small);
    expect(shortR.pageStatuses.length).toBeGreaterThan(
      longR.pageStatuses.length * 10
    );
    expect(bytes(shortR.pageStatuses)).toBeLessThanOrEqual(small);
    expect(bytes(longR.pageStatuses)).toBeLessThanOrEqual(small);
  });

  test("idempotent: a second pass changes nothing", () => {
    const r = { pageStatuses: statuses(20_000, 300) };
    clipPageStatusesToBytes(r, budget);
    const once = r.pageStatuses.length;
    const ref = r.pageStatuses;
    clipPageStatusesToBytes(r, budget);
    expect(r.pageStatuses).toBe(ref);
    expect(r.pageStatuses).toHaveLength(once);
  });

  test("tolerates a report with no pageStatuses at all", () => {
    expect(() =>
      clipPageStatusesToBytes({ pageStatuses: null }, budget)
    ).not.toThrow();
    expect(() =>
      clipPageStatusesToBytes({ pageStatuses: [] }, budget)
    ).not.toThrow();
  });
});
