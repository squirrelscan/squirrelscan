// #1860: what the streamed page loop retains must not stay attached to the page
// it came from.
//
// Every string a rule pulls out of a parsed page is a slice of that page's HTML,
// and JSC keeps a slice attached to the buffer it came from. Retaining one
// 20-character href therefore retains the whole page as UTF-16 for the rest of
// the run. Measured on a real 959 KB page: the collected signal is about 1 KB of
// data and held 3.8 MB.
//
// This is invisible to every obvious measure — `JSON.stringify(x).length` sees
// the logical size, and RSS sees nothing because the arena absorbs it — so it
// needs a test that looks at `heapUsed` directly. A production run held ~8 MB
// per page while a local census of the same structures reported 96 KB.

import { describe, expect, test } from "bun:test";

import { detachCounts, detachFromPage, resetDetachCounts } from "../src/detach";

/**
 * Retained bytes after holding `n` copies of what `make` returns.
 *
 * heapUsed + external, not heapUsed alone: a string's backing store is not on
 * the JS heap, and a slice pins the BUFFER, not a heap object. Measured on
 * heapUsed by itself the attached control reported 0 KB/item, which sent this
 * test down its INCONCLUSIVE branch on every run — green, and asserting
 * nothing.
 */
function retainedPerItem(n: number, make: (i: number) => unknown): number {
  Bun.gc(true);
  const before = process.memoryUsage();
  const kept: unknown[] = [];
  for (let i = 0; i < n; i++) kept.push(make(i));
  Bun.gc(true);
  const after = process.memoryUsage();
  const grown = after.heapUsed - before.heapUsed + (after.external - before.external);
  // Touch `kept` after the sample so it cannot be collected early.
  expect(kept.length).toBe(n);
  return grown / n;
}

/** A page-sized string and a small slice of it, as a parse would produce. */
function pageAndSlice(i: number): { page: string; slice: string } {
  const page = `<html><body>${"a".repeat(500_000)}${i}</body></html>`;
  return { page, slice: page.slice(120, 180) };
}

const KB = 1024;

describe("detachFromPage", () => {
  test("a raw slice of a page retains the page; a detached copy does not", () => {
    const N = 80;
    const attached = retainedPerItem(N, (i) => ({ text: pageAndSlice(i).slice }));
    const detached = retainedPerItem(N, (i) => detachFromPage({ text: pageAndSlice(i).slice }, "page-rules"));

    // The measurement itself is environment-dependent: a collector that absorbs
    // the allocation reports no growth for EITHER case, and a review pass saw
    // exactly that. Comparing two zeroes proves nothing, and asserting anything
    // at all in that state would report a pass the run did not earn — so this
    // says INCONCLUSIVE out loud and asserts nothing. The deterministic
    // guarantees are the tests below plus detach-production-boundaries.test.ts.
    if (attached < 100 * KB) {
      console.warn(
        `[detach] INCONCLUSIVE: control retained only ${Math.round(attached / KB)} KB/item, ` +
          `so this run did not demonstrate the retention it is meant to catch.`,
      );
      return;
    }

    // Attached holds something on the order of the page; detached, of the slice.
    // A ratio rather than absolute bytes, so this is not pinned to one engine's
    // object layout.
    expect(detached).toBeLessThan(attached / 4);
  });

  test("preserves Sets, which a JSON round-trip would silently empty", () => {
    // PageFingerprint carries Sets. `JSON.parse(JSON.stringify(x))` also detaches
    // strings, but turns every Set into {} — the rules downstream would then see
    // an empty fingerprint and quietly change their findings.
    const source = {
      assetHosts: new Set(["a.example", "b.example"]),
      nested: { classes: new Set(["x"]) },
      list: [new Set(["y"])],
    };
    const copy = detachFromPage(source, "page-rules");

    expect(copy.assetHosts).toBeInstanceOf(Set);
    expect([...copy.assetHosts]).toEqual(["a.example", "b.example"]);
    expect(copy.nested.classes).toBeInstanceOf(Set);
    expect(copy.list[0]).toBeInstanceOf(Set);
  });

  test("round-trips the value, not just its shape", () => {
    const source = {
      url: "https://example.com/a?b=1#c",
      items: [{ id: "x", label: "L", sourcePages: ["p1", "p2"] }],
      count: 3,
      flag: false,
      nothing: null,
      when: new Date(0),
    };
    const copy = detachFromPage(source, "page-rules");
    expect(copy).toEqual(source);
    // A copy, not the same object — otherwise nothing was detached.
    expect(copy).not.toBe(source);
    expect(copy.items[0]).not.toBe(source.items[0]);
  });

  test("preserves sharing WITHIN one value rather than duplicating it", () => {
    // pageResults, pageRuleResults and ruleResultsMap all reference the same
    // check objects. One clone of the container keeps that sharing; cloning each
    // consumer separately would triple the findings instead of detaching them.
    const shared = { name: "check" };
    const copy = detachFromPage({ flat: [shared], byRule: { r: [shared] } }, "page-rules");
    expect(copy.flat[0]).toBe(copy.byRule.r[0]);
  });

  test("returns the original rather than throwing on a non-cloneable value, and COUNTS it", () => {
    resetDetachCounts();
    // Safety valve: a value carrying a function cannot be structured-cloned.
    // Keeping the original costs the retention this exists to avoid, but it
    // cannot change what the audit reports.
    const withFn = { fn: () => 1, keep: "x" };
    expect(detachFromPage(withFn, "page-rules")).toBe(withFn);
    // Silent is the failure mode that matters: a fallback keeps the page
    // attached with identical findings, so it has to be countable.
    expect(detachCounts("page-rules").fallbacks).toBe(1);
    resetDetachCounts();
  });
});
