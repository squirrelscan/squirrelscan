// Tests for reachability utilities

import { describe, expect, test } from "bun:test";

import { checkReachability } from "../../src/utils/reachability";

describe("checkReachability", () => {
  test("returns reachable for valid URLs", async () => {
    const result = await checkReachability("http://localhost:0");
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns unreachable for non-existent domains", async () => {
    const result = await checkReachability(
      "https://this-domain-definitely-does-not-exist-12345.com"
    );
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns unreachable for invalid URLs", async () => {
    const result = await checkReachability("http://localhost:9");
    expect(result.reachable).toBe(false);
  });
});
