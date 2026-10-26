// squirrelscan/repo#3346: header names are case-insensitive. Spreading records
// kept `User-Agent` and `user-agent` side by side, and `new Headers(record)`
// appended them into one combined value.

import { describe, expect, test } from "bun:test";

import { mergeHeaderRecords } from "../src/headers";

describe("mergeHeaderRecords", () => {
  test("a later record replaces a name that differs only in case, in its own spelling", () => {
    const merged = mergeHeaderRecords(
      { "User-Agent": "squirrel", Accept: "text/html" },
      { "user-agent": "custom-agent", "X-Api-Key": "k" },
    );
    expect(merged).toEqual({ Accept: "text/html", "user-agent": "custom-agent", "X-Api-Key": "k" });
    expect(new Headers(merged).get("user-agent")).toBe("custom-agent");
  });

  test("spread records, by contrast, send both values", () => {
    const spread = { "User-Agent": "squirrel", ...{ "user-agent": "custom-agent" } };
    expect(new Headers(spread).get("user-agent")).toBe("squirrel, custom-agent");
  });

  test("skips absent records and keeps distinct names", () => {
    expect(mergeHeaderRecords(undefined, { A: "1" }, null, { b: "2" })).toEqual({ A: "1", b: "2" });
    expect(mergeHeaderRecords()).toEqual({});
  });
});
