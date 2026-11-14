import { describe, expect, test } from "bun:test";

import { lowercaseHeaderNames } from "./index";

describe("lowercaseHeaderNames (repo#2240)", () => {
  test("stores ETag and Cache-Control under lowercase keys", () => {
    const out = lowercaseHeaderNames({ ETag: '"a"', "Cache-Control": "max-age=0", "content-type": "text/html" });
    expect(out["etag"]).toBe('"a"');
    expect(out["cache-control"]).toBe("max-age=0");
    expect(out["content-type"]).toBe("text/html");
  });

  test("tolerates a missing record", () => {
    expect(Object.keys(lowercaseHeaderNames(undefined))).toEqual([]);
  });
});
