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
// needs a test that looks at the allocator directly. A production run held ~8 MB
// per page while a local census of the same structures reported 96 KB.
//
// The measurement itself lives in helpers/retention.ts, which explains why it
// reads `external` rather than `heapUsed`, why it subtracts a retain-nothing
// control, and why an unusable run fails rather than passing quietly.

import { describe, expect, test } from "bun:test";

import { detachCounts, detachFromPage, resetDetachCounts } from "../src/detach";
import { compareRetention, expectDetached, MB } from "./helpers/retention";

/**
 * A page-sized string and a small slice of it, as a parse would produce.
 *
 * Built from per-source UNIQUE chunks rather than one repeated character: JSC
 * ropes share backing storage, so a corpus made with `.repeat()` is nearly free
 * to hold and the attached arm would look detached.
 */
function pageAndSlice(i: number, bytes: number): { page: string; slice: string } {
  const chunk = 20_000;
  const body = Array.from(
    { length: Math.max(1, Math.ceil(bytes / chunk)) },
    (_, k) => `${i}-${k} `.padEnd(chunk, "abcdefghij"),
  ).join("");
  const page = `<html><body>${body}</body></html>`;
  return { page, slice: page.slice(120, 180) };
}

describe("detachFromPage", () => {
  test("a raw slice of a page retains the page; a detached copy does not", () => {
    // Three arms with a retain-nothing control subtracted, on multi-megabyte
    // sources — see helpers/retention.ts. The previous version compared the two
    // real arms against each other on 500 KB pages and, when they landed on top
    // of one another, printed INCONCLUSIVE and passed. It did that on every run.
    const N = 48;
    const SOURCE_BYTES = 6_000_000;

    const result = compareRetention({
      iterations: N,
      // The control builds the same source and takes the same slice, then keeps
      // only its length: the allocation is identical, the retention is not.
      control: (i) => pageAndSlice(i, SOURCE_BYTES).slice.length,
      attached: (i) => ({ text: pageAndSlice(i, SOURCE_BYTES).slice }),
      detached: (i) => detachFromPage({ text: pageAndSlice(i, SOURCE_BYTES).slice }, "page-rules"),
    });

    // Attached holds something on the order of the source; detached, of the
    // slice. A ratio rather than absolute bytes, so this is not pinned to one
    // engine's object layout.
    expectDetached(result, {
      marginBytes: 150 * MB,
      ratio: 4,
      label: `raw slices of ${N} sources of ${(SOURCE_BYTES / MB).toFixed(0)} MB`,
    });
  }, 300_000);

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
