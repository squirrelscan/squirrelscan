import { describe, expect, test } from "bun:test";

import { createRng, pickExcluding, pickFewExcluding } from "../src/prng";

describe("pickFewExcluding", () => {
  test("never includes the excluded value", () => {
    const rng = createRng("pick-few-exclude");
    const pool = Array.from({ length: 50 }, (_, i) => i);
    for (let trial = 0; trial < 30; trial++) {
      const picks = pickFewExcluding(rng, pool, 7, 4);
      expect(picks).not.toContain(7);
    }
  });

  test("returns distinct elements", () => {
    const rng = createRng("pick-few-distinct");
    const pool = Array.from({ length: 20 }, (_, i) => i);
    const picks = pickFewExcluding(rng, pool, -1, 5);
    expect(new Set(picks).size).toBe(picks.length);
  });

  test("returns up to count elements, fewer when the pool is too small", () => {
    const rng = createRng("pick-few-small-pool");
    expect(pickFewExcluding(rng, [1, 2, 3], -1, 5).length).toBeLessThanOrEqual(3);
    expect(pickFewExcluding(rng, [], -1, 5)).toEqual([]);
    expect(pickFewExcluding(rng, [1, 2], 1, 5)).toEqual([2]); // only non-excluded element
  });

  test("deterministic given the same rng sequence", () => {
    const poolA = Array.from({ length: 30 }, (_, i) => i);
    const poolB = Array.from({ length: 30 }, (_, i) => i);
    const a = pickFewExcluding(createRng("pick-few-determinism"), poolA, 5, 3);
    const b = pickFewExcluding(createRng("pick-few-determinism"), poolB, 5, 3);
    expect(a).toEqual(b);
  });

  test("cost is independent of pool size (O(count), not O(pool.length))", () => {
    // Not a strict timing assertion (flaky in CI) — just confirms a huge pool
    // doesn't hang or scale badly for a tiny pick, which is the whole point
    // of this primitive existing (see wireDefaultLinks in page-model.ts).
    const rng = createRng("pick-few-scale");
    const bigPool = Array.from({ length: 500_000 }, (_, i) => i);
    const start = performance.now();
    const picks = pickFewExcluding(rng, bigPool, 123, 4);
    const elapsedMs = performance.now() - start;
    expect(picks.length).toBe(4);
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe("pickExcluding", () => {
  test("NEVER returns the excluded value when an alternative exists — a hard guarantee, not probabilistic", () => {
    const rng = createRng("pick-exclude-hard");
    const pool = [1, 2, 3];
    for (let trial = 0; trial < 500; trial++) {
      expect(pickExcluding(rng, pool, 2)).not.toBe(2);
    }
  });

  test("falls back to the excluded value only when it's the sole element", () => {
    const rng = createRng("pick-exclude-sole");
    expect(pickExcluding(rng, [5], 5)).toBe(5);
  });

  test("deterministic given the same rng sequence", () => {
    const a = pickExcluding(createRng("pick-exclude-determinism"), [1, 2, 3, 4], 2);
    const b = pickExcluding(createRng("pick-exclude-determinism"), [1, 2, 3, 4], 2);
    expect(a).toBe(b);
  });
});
