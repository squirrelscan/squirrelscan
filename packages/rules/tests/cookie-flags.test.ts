// security/cookie-flags — Secure/HttpOnly/SameSite on Set-Cookie headers.
// #748: false-positive caution — pages with no Set-Cookie header at all must
// pass cleanly.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { cookieFlagsRule } from "../src/security/cookie-flags";
import type { RuleContext } from "../src/types";

function ctx(setCookie: string | undefined, url = "https://example.com/"): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body>content</body></html>`;
  const headers: Record<string, string> = {};
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function checksByName(checks: ReturnType<typeof cookieFlagsRule.run>["checks"], name: string) {
  return checks.find((c) => c.name === name);
}

describe("security/cookie-flags", () => {
  test("no Set-Cookie header at all: passes cleanly", () => {
    const { checks } = cookieFlagsRule.run(ctx(undefined));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.message).toContain("No cookies");
  });

  test("empty Set-Cookie value: passes cleanly", () => {
    const { checks } = cookieFlagsRule.run(ctx(""));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("cookie with all flags set correctly: passes cleanly", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax"),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("missing Secure on an HTTPS page: flagged as warn", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; HttpOnly; SameSite=Lax"));
    const check = checksByName(checks, "cookie-secure");
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("session");
  });

  test("missing Secure on an HTTP page: not flagged (no secure connection to restrict to)", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=abc123; Path=/; HttpOnly; SameSite=Lax", "http://example.com/"),
    );
    expect(checksByName(checks, "cookie-secure")).toBeUndefined();
  });

  test("missing HttpOnly: flagged as warn", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; Secure; SameSite=Lax"));
    const check = checksByName(checks, "cookie-httponly");
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("session");
  });

  test("missing SameSite: flagged as info (browsers default to Lax)", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; Secure; HttpOnly"));
    const check = checksByName(checks, "cookie-samesite");
    expect(check?.status).toBe("info");
  });

  test("SameSite=None without Secure: flagged as fail (browsers reject this)", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; HttpOnly; SameSite=None"));
    const check = checksByName(checks, "cookie-samesite-none-insecure");
    expect(check?.status).toBe("fail");
    // Not double-counted under the generic missing-SameSite info check.
    expect(checksByName(checks, "cookie-samesite")).toBeUndefined();
  });

  test("SameSite=None WITH Secure: not flagged as broken", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly; SameSite=None"),
    );
    expect(checksByName(checks, "cookie-samesite-none-insecure")).toBeUndefined();
  });

  test("multiple cookies newline-joined (future-fixed fetcher format): each evaluated independently", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("a=1; Path=/; Secure; HttpOnly; SameSite=Lax\nb=2; Path=/"),
    );
    const secureCheck = checksByName(checks, "cookie-secure");
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["b"]);
  });

  test("three cookies newline-joined (fetcher's real getSetCookie() output, #973): all three evaluated independently", () => {
    const value = [
      "session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax",
      "csrftoken=xyz789; Path=/; Secure",
      "optout=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
    ].join("\n");
    const { checks } = cookieFlagsRule.run(ctx(value));
    // "csrftoken" is missing HttpOnly, "optout" is missing both Secure and
    // HttpOnly — if any cookie were silently dropped (the pre-#973 "last
    // cookie wins" bug) these counts would undercount.
    const httpOnlyCheck = checksByName(checks, "cookie-httponly");
    expect(httpOnlyCheck?.items?.map((i) => i.id)).toEqual(["csrftoken", "optout"]);
    const secureCheck = checksByName(checks, "cookie-secure");
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["optout"]);
  });

  test("multiple cookies comma-joined with an Expires date: split correctly, not corrupted by the comma", () => {
    const value =
      "a=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure; HttpOnly; SameSite=Lax, b=2; Path=/; HttpOnly";
    const { checks } = cookieFlagsRule.run(ctx(value));
    const secureCheck = checksByName(checks, "cookie-secure");
    // Only "b" is missing Secure — "a" has it. If the Expires comma were
    // mishandled, this would either merge the two cookies into one bogus
    // name or miss "b" entirely.
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["b"]);
  });

  test("bare cookie with no attributes: flagged for Secure, HttpOnly, and SameSite", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123"));
    expect(checksByName(checks, "cookie-secure")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-samesite")?.status).toBe("info");
  });
});
