import { describe, expect, test } from "bun:test";

import { customUserAgent } from "../src/headers";

describe("customUserAgent (#1152)", () => {
  test("reads the header whatever its casing", () => {
    expect(customUserAgent({ "user-agent": "X/1" })).toBe("X/1");
    expect(customUserAgent({ "User-Agent": " Y/2 " })).toBe("Y/2");
  });

  test("no header, an empty one or no headers is no agent", () => {
    expect(customUserAgent({ Accept: "*/*" })).toBe("");
    expect(customUserAgent({ "user-agent": "  " })).toBe("");
    expect(customUserAgent(undefined)).toBe("");
  });

  test("when two spellings are set the later one wins, as on the wire", () => {
    expect(customUserAgent({ "User-Agent": "first", "user-agent": "second" })).toBe("second");
  });
});
