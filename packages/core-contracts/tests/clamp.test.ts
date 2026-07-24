// #996 / #1216 / #1228: check-item id/string clamping. Ids feed dedup + are
// rendered as hrefs, so the clamp must (a) never orphan a surrogate pair
// (#1228 nitpick), (b) stay within the UTF-16 cap zod enforces, and (c) keep
// two distinct oversize ids distinct so the fold/merge dedupe does not collapse
// unrelated findings (#1228 finding 3).

import { describe, expect, test } from "bun:test";

import { clampDetailsRecord, clampItemId, clampItemString } from "../src/clamp";
import { CHECK_DETAILS_LIMITS, REPORT_LIMITS } from "../src/limits";

const MAX = REPORT_LIMITS.maxMediumString;

describe("clampItemString", () => {
  test("leaves short strings untouched", () => {
    expect(clampItemString("hello", MAX)).toBe("hello");
  });

  test("truncates to at most `max` UTF-16 units", () => {
    const out = clampItemString("a".repeat(MAX + 100), MAX);
    expect(out.length).toBe(MAX);
  });

  test("does not orphan a surrogate pair at the boundary", () => {
    // "😀" is U+1F600 = 2 UTF-16 units (high+low surrogate). Build a string
    // whose cut point falls between the two halves of an emoji.
    const value = "a".repeat(MAX - 1) + "😀" + "tail";
    const out = clampItemString(value, MAX);
    // Stays within the cap and never ends on a lone high surrogate.
    expect(out.length).toBeLessThanOrEqual(MAX);
    const lastCode = out.charCodeAt(out.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    // The dangling high surrogate was dropped rather than kept half-formed.
    expect(out).toBe("a".repeat(MAX - 1));
  });

  test("keeps a full emoji when it fits exactly at the boundary", () => {
    const value = "a".repeat(MAX - 2) + "😀" + "tail";
    const out = clampItemString(value, MAX);
    expect(out.length).toBe(MAX);
    expect(out).toBe("a".repeat(MAX - 2) + "😀");
  });
});

describe("clampItemId uniqueness (#1228 finding 3)", () => {
  test("short ids pass through unchanged", () => {
    expect(clampItemId("https://e.com/a", MAX)).toBe("https://e.com/a");
  });

  test("clamped ids stay within the cap", () => {
    const out = clampItemId("https://e.com/" + "p".repeat(MAX + 500), MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  test("two ids identical in their first <cap> chars but differing later stay distinct", () => {
    // Same prefix well past `max`, differing only in the tail — plain
    // truncation would collapse these to one and merge two distinct findings.
    const prefix = "https://example.com/" + "x".repeat(MAX);
    const a = prefix + "AAA";
    const b = prefix + "ZZZ";
    const clampedA = clampItemId(a, MAX);
    const clampedB = clampItemId(b, MAX);
    expect(clampedA).not.toBe(clampedB);
    expect(clampedA.length).toBeLessThanOrEqual(MAX);
    expect(clampedB.length).toBeLessThanOrEqual(MAX);
  });

  test("deterministic: same input yields same clamp (cross-runtime dedup parity)", () => {
    const id = "https://example.com/" + "y".repeat(MAX + 200);
    expect(clampItemId(id, MAX)).toBe(clampItemId(id, MAX));
  });

  test("hash suffix does not split a surrogate pair in the retained prefix", () => {
    const id = "😀".repeat(MAX) + "tail";
    const out = clampItemId(id, MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
    // The join point between prefix and "~hash" must not be a lone surrogate.
    const suffixStart = out.indexOf("~");
    const beforeSuffix = suffixStart >= 0 ? out.slice(0, suffixStart) : out;
    const lastCode = beforeSuffix.charCodeAt(beforeSuffix.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });
});

// #1288: `details` is free-form (`z.record(z.unknown())`) at the publish
// schema — the remaining unclamped hole after #1216/#1263. Small explicit
// limits (not the production 8KB/depth-3/20-key constants) keep these tests
// fast and make the cap+1 boundary exact and easy to read.
describe("clampDetailsRecord", () => {
  const limits = {
    maxDepth: 2,
    maxKeysPerLevel: 3,
    maxStringLength: 10,
    maxNodes: 100,
    maxBytes: 500,
  };

  test("returns the SAME reference when nothing needs clamping", () => {
    const details = { additional: 5, note: "short" };
    expect(clampDetailsRecord(details, limits)).toBe(details);
  });

  test("numbers/booleans/null pass through untouched, at any depth within bounds", () => {
    const details = { additional: 5, occurrences: 12, pagesTruncated: 3, flag: true, empty: null };
    // maxKeysPerLevel raised to 5 here — the point of this test is the scalar
    // pass-through, not the key-count cap (covered separately below).
    const clamped = clampDetailsRecord(details, { ...limits, maxKeysPerLevel: 5 }) as Record<
      string,
      unknown
    >;
    expect(clamped).toEqual(details);
  });

  test("string length cap+1: truncates to exactly maxStringLength, cap fits untouched", () => {
    const clamped = clampDetailsRecord(
      { fits: "a".repeat(limits.maxStringLength), over: "a".repeat(limits.maxStringLength + 1) },
      limits,
    ) as Record<string, string>;
    expect(clamped.fits.length).toBe(limits.maxStringLength);
    expect(clamped.over.length).toBe(limits.maxStringLength);
  });

  test("object key-count cap+1: keeps exactly maxKeysPerLevel keys, drops the rest", () => {
    const details = { a: 1, b: 2, c: 3, d: 4 }; // 4 keys, cap is 3
    const clamped = clampDetailsRecord(details, limits) as Record<string, unknown>;
    expect(Object.keys(clamped)).toHaveLength(limits.maxKeysPerLevel);
    expect(Object.keys(clamped)).toEqual(["a", "b", "c"]);
  });

  test("object key-count AT cap: untouched, same reference", () => {
    const details = { a: 1, b: 2, c: 3 }; // exactly maxKeysPerLevel
    expect(clampDetailsRecord(details, limits)).toBe(details);
  });

  test("key-count cap+1: a late-ordered scalar bookkeeping key survives a trim over non-scalar keys ordered before it", () => {
    // Mirrors the real risk: packages/rules/src/fold.ts's
    // clampCheckItemsOverflow/foldOverflowChecks read details.additional —
    // a naive insertion-order slice(0, maxKeysPerLevel) would drop it here
    // since it's ordered AFTER 3 string keys against a cap of 3.
    const details = { note1: "x", note2: "y", note3: "z", additional: 40 };
    const clamped = clampDetailsRecord(details, limits) as Record<string, unknown>;
    expect(clamped.additional).toBe(40);
    expect(Object.keys(clamped)).toHaveLength(limits.maxKeysPerLevel);
  });

  test("array length cap+1: keeps exactly maxKeysPerLevel elements", () => {
    const clamped = clampDetailsRecord({ list: ["a", "b", "c", "d"] }, limits) as {
      list: string[];
    };
    expect(clamped.list).toEqual(["a", "b", "c"]);
  });

  test("depth cap+1: an over-deep CONTAINER is pruned; primitives at any depth survive", () => {
    // depth: details(0) -> a(1) -> b(2, at cap) -> c(3, OVER cap=2) -> d(4)
    const details = { a: { b: { c: { d: "too deep" } } } };
    const clamped = clampDetailsRecord(details, limits) as Record<string, unknown>;
    // `c` (an object, depth 3 > maxDepth 2) is pruned entirely.
    expect((clamped.a as Record<string, unknown>).b).toEqual({});
  });

  test("depth: a primitive leaf survives even past maxDepth (only containers are pruned)", () => {
    // details(0) -> a(1) -> b(2, array, AT cap=2) -> element(3, string). The
    // string branch has no depth gate at all, so it's kept regardless of
    // whether its own depth (3) would have been over cap for a container.
    const details = { a: { b: ["still here"] } };
    const clamped = clampDetailsRecord(details, limits) as {
      a: { b: string[] };
    };
    expect(clamped.a.b).toEqual(["still here"]);
  });

  test("maxNodes cap+1: a total-visit-budget overshoot is pruned rather than fully processed", () => {
    // maxDepth/maxKeysPerLevel alone would allow this (2 levels, well under
    // maxKeysPerLevel=3 wide at each) — maxNodes is the ONLY thing that cuts
    // it off, proving the budget is actually wired in, not just declared.
    const budgeted = { ...limits, maxKeysPerLevel: 10, maxNodes: 5 };
    const details = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }; // 7 top-level nodes > maxNodes=5
    const clamped = clampDetailsRecord(details, budgeted) as Record<string, unknown>;
    expect(Object.keys(clamped).length).toBeLessThan(7);
  });

  test("maxNodes AT the total (no overshoot): untouched, same reference", () => {
    const budgeted = { ...limits, maxKeysPerLevel: 10, maxNodes: 10 };
    const details = { a: 1, b: 2, c: 3 }; // 1 (details itself) + 3 = 4 nodes, well under 10
    expect(clampDetailsRecord(details, budgeted)).toBe(details);
  });

  test("maxNodes: an earlier-ordered decoy subtree cannot drain the budget away from later scalar bookkeeping keys", () => {
    // #1288 round-2 review finding: `state.visited` is global and DFS-ordered,
    // and the budget cutoff runs before the scalar passthrough — so a NESTED
    // decoy within every per-axis cap (depth 2 ≤ maxDepth 3, width 10 ≤
    // maxKeysPerLevel 20, but 1+10+100 = 111 nodes > maxNodes 50), ordered
    // BEFORE the scalars, exhausted the budget and dropped exactly the keys
    // the scalars-survive invariant protects. Key order is attacker-controlled
    // at the publish boundary. Fixed by unconditional scalars-first visiting.
    const buildDecoy = (depth: number, width: number): unknown => {
      if (depth === 0) return true; // scalar leaf: isolates the DFS-order interaction from string clamping
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < width; i++) obj[`k${i}`] = buildDecoy(depth - 1, width);
      return obj;
    };
    const budgeted = { ...limits, maxDepth: 3, maxKeysPerLevel: 20, maxNodes: 50 };
    const details = {
      decoy: buildDecoy(2, 10),
      additional: 40,
      occurrences: 12,
      pagesTruncated: 1837,
    };
    const clamped = clampDetailsRecord(details, budgeted) as Record<string, unknown>;
    expect(clamped).not.toBe(details); // the decoy really did trip the budget
    expect(clamped.additional).toBe(40);
    expect(clamped.occurrences).toBe(12);
    expect(clamped.pagesTruncated).toBe(1837);
  });

  test("byte-budget cap+1: shrinks to fit, keeps scalar keys unconditionally", () => {
    const tinyLimits = {
      maxDepth: 3,
      maxKeysPerLevel: 20,
      maxStringLength: 200,
      maxNodes: 100,
      maxBytes: 80,
    };
    const details = {
      additional: 7,
      occurrences: 3,
      big1: "x".repeat(60),
      big2: "y".repeat(60),
    };
    const clamped = clampDetailsRecord(details, tinyLimits) as Record<string, unknown>;
    expect(clamped.additional).toBe(7);
    expect(clamped.occurrences).toBe(3);
    expect(new TextEncoder().encode(JSON.stringify(clamped)).length).toBeLessThanOrEqual(
      tinyLimits.maxBytes,
    );
  });

  test("byte-budget AT the limit: untouched", () => {
    const details = { additional: 5 };
    const size = new TextEncoder().encode(JSON.stringify(details)).length;
    const tightLimits = { ...limits, maxBytes: size };
    expect(clampDetailsRecord(details, tightLimits)).toBe(details);
  });

  test("undefined/function values are stripped (not JSON-safe anyway)", () => {
    const details = { keep: 1, fn: () => {}, missing: undefined };
    const clamped = clampDetailsRecord(details, limits) as Record<string, unknown>;
    expect(clamped).toEqual({ keep: 1 });
  });

  test("non-object input (wrong shape) is returned unchanged — this is a bound, not a type check", () => {
    expect(clampDetailsRecord("oops", limits)).toBe("oops");
    expect(clampDetailsRecord(null, limits)).toBeNull();
    expect(clampDetailsRecord(undefined, limits)).toBeUndefined();
    expect(clampDetailsRecord(["a", "b"], limits)).toEqual(["a", "b"]);
  });

  test("under production defaults: real rule-shaped details survive intact", () => {
    // Mirrors packages/rules/src/ax/content-signals.ts's contradictions shape —
    // details -> contradictions[] -> {signal, blockedTokens[]} -> string leaves.
    const details = {
      contradictions: [
        { signal: "ai-train", blockedTokens: ["GPTBot", "CCBot"] },
        { signal: "search", blockedTokens: ["Amazonbot"] },
      ],
    };
    expect(clampDetailsRecord(details)).toEqual(details);
  });

  test("under production defaults: additional/occurrences/pagesTruncated bookkeeping numbers always survive", () => {
    const details = { additional: 40, occurrences: 12, pagesTruncated: 1837 };
    expect(clampDetailsRecord(details)).toBe(details);
    expect(CHECK_DETAILS_LIMITS.maxDepth).toBeGreaterThan(0);
  });
});

// #1288 review finding: `details` is attacker-controlled input at a public
// publish endpoint, delivered via JSON.parse — which legitimately creates a
// key literally named "__proto__" as a normal OWN enumerable property
// (JSON.parse never invokes the exotic Object.prototype.__proto__ accessor;
// this is standard, spec-guaranteed behavior, not a JSON.parse bug). But the
// clamp's own object-rebuild loops used PLAIN bracket assignment
// (`out[key] = value`) onto a normal `{}` accumulator — and bracket
// assignment DOES walk the prototype chain ([[Set]], unlike object-literal
// spread/Object.fromEntries which use CreateDataProperty), so assigning
// through a "__proto__" key there repoints the accumulator's OWN prototype
// to the attacker-supplied value instead of creating an own property. Fixed
// via Object.create(null) accumulators (no inherited accessor to trigger).
describe("clampDetailsRecord prototype-pollution safety (#1288 review finding)", () => {
  test("a __proto__ key survives the structural rebuild path as a plain own property, prototype untouched", () => {
    // Forcing the rebuild: `big` needs string-length clamping, so
    // state.changed becomes true and the WHOLE object rebuilds — including
    // the __proto__ entry, which must go through the vulnerable assignment.
    const raw = JSON.parse(
      `{"__proto__":{"additional":999999},"big":"${"x".repeat(20)}"}`,
    ) as Record<string, unknown>;
    expect(Object.hasOwn(raw, "__proto__")).toBe(true); // sanity: real delivery vector
    const injectedProto = raw["__proto__"]; // the {additional: 999999} the attacker is trying to install

    const smallStrings = {
      maxDepth: 2,
      maxKeysPerLevel: 5,
      maxStringLength: 10,
      maxNodes: 100,
      maxBytes: 500,
    };
    const clamped = clampDetailsRecord(raw, smallStrings) as Record<string, unknown>;

    // The clamped record's OWN prototype must NOT be the attacker-supplied
    // object — asserted against the injected value itself (not a specific
    // fix implementation like Object.prototype vs null) so this test holds
    // regardless of which safe accumulator strategy is used.
    expect(Object.getPrototypeOf(clamped)).not.toBe(injectedProto);
    // The sharpest edge: packages/audit-engine's checkAdditional() does a
    // plain `check.details?.additional` read, which walks the prototype
    // chain — a polluted prototype would let this resolve to 999999 without
    // "additional" ever being an own property (invisible to Object.keys).
    expect(Object.hasOwn(clamped, "additional")).toBe(false);
    expect((clamped as { additional?: unknown }).additional).toBeUndefined();
    // "__proto__" itself must survive as a normal OWN key, not vanish.
    expect(Object.hasOwn(clamped, "__proto__")).toBe(true);
  });

  test("a __proto__ key survives the byte-budget rebuild path, prototype untouched", () => {
    // maxStringLength/maxKeysPerLevel wide enough that the STRUCTURAL pass
    // alone changes nothing (isolates the clampToByteBudget rebuild path).
    const tinyBudget = {
      maxDepth: 3,
      maxKeysPerLevel: 20,
      maxStringLength: 200,
      maxNodes: 100,
      maxBytes: 60,
    };
    const raw = JSON.parse(
      `{"__proto__":{"additional":999999},"padding":"${"x".repeat(100)}"}`,
    ) as Record<string, unknown>;
    const injectedProto = raw["__proto__"];

    const clamped = clampDetailsRecord(raw, tinyBudget) as Record<string, unknown>;
    expect(Object.getPrototypeOf(clamped)).not.toBe(injectedProto);
    expect(Object.hasOwn(clamped, "additional")).toBe(false);
    expect((clamped as { additional?: unknown }).additional).toBeUndefined();
  });
});
