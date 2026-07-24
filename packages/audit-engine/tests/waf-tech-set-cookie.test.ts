// withWafTech rehydrates a stored header record into a real Headers object to
// run WAF detection. `headers["set-cookie"]` may be "\n"-joined (one real
// Set-Cookie header per line) — a naive
// `new Headers()` + `.set()` loop THROWS on that value, dropping WAF
// detection for the whole page.

import { describe, expect, test } from "bun:test";

import type { DetectedTechnology } from "@squirrelscan/tech-detect";

import { withWafTech } from "../src/technologies";

const MULTI_COOKIE_HEADERS: Record<string, string> = {
  server: "cloudflare",
  "content-type": "text/html",
  "set-cookie": "session=abc123; Path=/; HttpOnly\nconsent=1; Path=/; Secure",
};

describe("withWafTech (#973/#1035)", () => {
  test('does not throw when set-cookie is "\\n"-joined', () => {
    expect(() => withWafTech([], MULTI_COOKIE_HEADERS, "<html></html>")).not.toThrow();
  });

  test("still detects the WAF from the other headers alongside a multi-cookie set-cookie", () => {
    const result = withWafTech([], MULTI_COOKIE_HEADERS, "<html></html>");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "waf-cloudflare",
      category: "security",
      detectedBy: "waf-detect",
    });
  });

  test("does not add a duplicate WAF tech if one is already present", () => {
    const existing: DetectedTechnology[] = [
      {
        id: "waf-cloudflare",
        name: "Cloudflare",
        category: "security",
        version: null,
        confidence: "high",
        detectedBy: "waf-detect",
      },
    ];
    const result = withWafTech(existing, MULTI_COOKIE_HEADERS, "<html></html>");
    expect(result).toHaveLength(1);
  });

  test("no WAF headers: passes through the input list unchanged", () => {
    const result = withWafTech([], { "set-cookie": "a=1\nb=2" }, "<html></html>");
    expect(result).toEqual([]);
  });
});
