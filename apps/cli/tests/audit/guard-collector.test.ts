// pub#401: a collector folded into the pre-rules walk cannot fail the audit,
// and the first failure drops its result whole rather than building one from
// the batches that survived.

import { describe, expect, test } from "bun:test";

import { guardCollector } from "@/audit/guard-collector";

/** Sums its batches; throws on any batch listed in `throwOn`. */
function summingCollector(throwOn: number[] = [], buildThrows = false) {
  const absorbed: number[] = [];
  return {
    absorbed,
    absorb(batch: number): void {
      if (throwOn.includes(batch)) throw new Error(`bad batch ${batch}`);
      absorbed.push(batch);
    },
    build(scale: number): number {
      if (buildThrows) throw new Error("bad build");
      return absorbed.reduce((sum, n) => sum + n, 0) * scale;
    },
  };
}

describe("guardCollector", () => {
  test("passes batches and the build through when nothing fails", () => {
    const inner = summingCollector();
    const failures: string[] = [];
    const guarded = guardCollector(inner, (_, phase) => failures.push(phase));
    for (const batch of [1, 2, 3]) guarded.absorb(batch);
    expect(guarded.build(10)).toBe(60);
    expect(guarded.failed).toBe(false);
    expect(failures).toEqual([]);
  });

  test("a throwing batch poisons the result: no partial build, later batches skipped", () => {
    const inner = summingCollector([2]);
    const failures: unknown[] = [];
    const guarded = guardCollector(inner, (error) => failures.push(error));
    for (const batch of [1, 2, 3, 4]) guarded.absorb(batch);
    expect(guarded.failed).toBe(true);
    expect(guarded.build(10)).toBeUndefined();
    // Batch 1 was folded in before the failure; nothing after it was.
    expect(inner.absorbed).toEqual([1]);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("bad batch 2");
  });

  test("a failure on every batch is reported once, not once per batch", () => {
    const batches = Array.from({ length: 500 }, (_, i) => i);
    const inner = summingCollector(batches);
    let calls = 0;
    const guarded = guardCollector(inner, () => {
      calls++;
    });
    for (const batch of batches) guarded.absorb(batch);
    guarded.build(1);
    expect(calls).toBe(1);
  });

  test("a throwing build returns undefined and is reported", () => {
    const failures: string[] = [];
    const guarded = guardCollector(summingCollector([], true), (_, phase) =>
      failures.push(phase)
    );
    guarded.absorb(1);
    expect(guarded.build(1)).toBeUndefined();
    expect(guarded.failed).toBe(true);
    expect(failures).toEqual(["build"]);
  });

  test("a throwing failure callback does not escape either", () => {
    const guarded = guardCollector(summingCollector([1]), () => {
      throw new Error("logger broke");
    });
    expect(() => guarded.absorb(1)).not.toThrow();
    expect(guarded.build(1)).toBeUndefined();
  });
});
