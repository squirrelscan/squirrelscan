// squirrelscan/repo#3368: a check's skipReason is a page-derived string, so a
// prototype name must get the default hint, the same as any unknown reason.

import { describe, expect, test } from "bun:test";

import { hintFor } from "../src/not-checked";

describe("not-checked hints use own-property lookups (#3368)", () => {
  const unknownHint = hintFor({ skipReason: "no-such-reason" });

  test("an unknown reason gets a string default hint", () => {
    expect(typeof unknownHint).toBe("string");
  });

  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    test(`${name} gets the same hint as an unknown reason`, () => {
      expect(hintFor({ skipReason: name })).toBe(unknownHint);
    });
  }

  test("a known reason keeps its own hint", () => {
    expect(hintFor({ skipReason: "discovery-probe-no-answer" })).toContain("nothing answered");
  });
});
