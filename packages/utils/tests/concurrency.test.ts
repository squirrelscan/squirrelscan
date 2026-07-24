// Unit tests for the shared bounded-concurrency map (extracted from the rules
// runner, now reused by audit-engine cloud prefetch).

import { describe, expect, test } from "bun:test";

import { mapWithConcurrency } from "../src/concurrency";

describe("mapWithConcurrency", () => {
  test("empty task list returns empty results", async () => {
    const res = await mapWithConcurrency<number>([], 4);
    expect(res).toEqual([]);
  });

  test("results are in input order even when tasks finish out of order", async () => {
    // Later tasks resolve sooner; output must still match input order.
    const tasks = [40, 10, 30, 0, 20].map((delay, i) => async () => {
      await new Promise((r) => setTimeout(r, delay));
      return i;
    });
    const res = await mapWithConcurrency(tasks, 5);
    expect(res).toEqual([0, 1, 2, 3, 4]);
  });

  test("concurrency <= 1 runs sequentially (max one in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 5 }, () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 1;
    });
    await mapWithConcurrency(tasks, 1);
    expect(maxInFlight).toBe(1);
  });

  test("bounds in-flight tasks to the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 12 }, () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 1;
    });
    await mapWithConcurrency(tasks, 3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("first rejection propagates; pool stops pulling new tasks", async () => {
    let started = 0;
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      started++;
      if (i === 0) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
      return i;
    });
    await expect(mapWithConcurrency(tasks, 2)).rejects.toThrow("boom");
    // After the first error no new tasks are pulled: not all 6 started.
    expect(started).toBeLessThan(6);
  });
});
