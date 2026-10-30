// Cross-impl fingerprint parity (#195).
//
// The smart-audits finding fingerprint is computed in two places that MUST agree
// byte-for-byte: the CLI's local store (via `fingerprint` re-exported from the
// merge core) and the API Worker's cloud store (via `findingFingerprint`). They
// are the SAME underlying function today — these tests guard against a future
// fork (which would orphan every stored fingerprint, making all findings read as
// "changed") and pin the algorithm with a golden value.

import { describe, expect, test } from "bun:test";

import { findingFingerprint } from "../src/fingerprint";
import { fingerprint } from "../src/merge-core";

const TUPLES: Array<[string, string, string | null, string | null]> = [
  ["fail", "Missing meta description", null, null],
  ["warn", "Title too long", "72", "≤ 60"],
  ["fail", "Broken link", "https://x.test/a", null],
  ["warn", "msg with | pipe and \"quotes\"", null, "expected|value"],
  ["fail", "", "", ""],
];

describe("fingerprint cross-impl parity", () => {
  test("CLI `fingerprint` === Worker `findingFingerprint` for every tuple", () => {
    for (const [s, m, v, e] of TUPLES) {
      expect(fingerprint(s, m, v, e)).toBe(findingFingerprint(s, m, v, e));
    }
  });

  test("always 64 lowercase hex chars", () => {
    for (const [s, m, v, e] of TUPLES) {
      expect(findingFingerprint(s, m, v, e)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("deterministic across calls", () => {
    const once = findingFingerprint("fail", "msg", "v", "e");
    const twice = findingFingerprint("fail", "msg", "v", "e");
    expect(once).toBe(twice);
  });

  test("sensitive to every field (status/message/value/expected)", () => {
    const base = findingFingerprint("fail", "msg", null, null);
    expect(findingFingerprint("warn", "msg", null, null)).not.toBe(base);
    expect(findingFingerprint("fail", "other", null, null)).not.toBe(base);
    expect(findingFingerprint("fail", "msg", "v", null)).not.toBe(base);
    expect(findingFingerprint("fail", "msg", null, "e")).not.toBe(base);
  });

  test("null value/expected collapses to empty-string (intentional, matches #194)", () => {
    expect(findingFingerprint("fail", "m", null, null)).toBe(
      findingFingerprint("fail", "m", "", "")
    );
  });

  test("field boundaries are injective (a separator inside a field can't masquerade)", () => {
    // ["fail","m","ab",""] vs ["fail","m","a","b"] — JSON encoding keeps the
    // field split unambiguous, so these must differ.
    expect(findingFingerprint("fail", "m", "ab", "")).not.toBe(
      findingFingerprint("fail", "m", "a", "b")
    );
  });

  // GOLDEN: pins the algorithm. If this changes, every stored fingerprint is
  // orphaned — only bump deliberately + document the one-time re-fingerprint.
  test("golden value is stable", () => {
    expect(findingFingerprint("fail", "Missing meta description", null, null)).toBe(
      "b40bb59e3f90d1aa479ed006308d70e1892d5214aabe12894448e9444b77b617"
    );
  });
});
