import { describe, expect, test } from "bun:test";

import { getRandomUserAgent, resolveUserAgent } from "@/utils/user-agent";

describe("user-agent utilities", () => {
  test("resolveUserAgent returns random UA for empty string", () => {
    const ua = resolveUserAgent("");
    expect(ua).not.toBe("");
    expect(ua.length).toBeGreaterThan(10);
  });

  test("resolveUserAgent returns custom value when provided", () => {
    const custom = "MyBot/1.0";
    expect(resolveUserAgent(custom)).toBe(custom);
  });

  test("getRandomUserAgent returns valid UA string", () => {
    const ua = getRandomUserAgent();
    expect(ua).not.toBe("");
    expect(typeof ua).toBe("string");
    // Should contain browser-like info
    expect(ua).toMatch(/Mozilla|Chrome|Safari|Firefox|Edge/);
  });

  test("getRandomUserAgent returns different values", () => {
    const uas = new Set<string>();
    for (let i = 0; i < 10; i++) {
      uas.add(getRandomUserAgent());
    }
    // Should have at least 2 different UAs in 10 tries
    expect(uas.size).toBeGreaterThan(1);
  });
});
