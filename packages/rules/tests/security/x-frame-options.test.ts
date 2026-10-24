// security/x-frame-options: invalid values warn, repeats collapse, and
// frame-ancestors is matched as a parsed directive name (pub#1080).

import { describe, expect, test } from "bun:test";

import { xFrameOptionsRule } from "../../src/security/x-frame-options";
import type { RuleContext } from "../../src/types";

function run(headers: Record<string, string>, pages = true) {
  const ctx = {
    site: {
      baseUrl: "https://acme.test/",
      pages: pages ? [{ url: "https://acme.test/", statusCode: 200, headers }] : [],
    },
    options: {},
  } as unknown as RuleContext;
  const { checks } = xFrameOptionsRule.run(ctx) as { checks: any[] };
  expect(checks).toHaveLength(1);
  return checks[0];
}

const FA_PASS = "Clickjacking protection via CSP frame-ancestors";

describe("x-frame-options", () => {
  test("no pages is skipped", () => {
    expect(run({}, false).status).toBe("skipped");
  });

  test.each(["DENY", "SAMEORIGIN", "deny", "  SameOrigin  "])("valid %p passes", (v) => {
    const c = run({ "x-frame-options": v });
    expect(c.status).toBe("pass");
    expect(c.message).toBe("X-Frame-Options header present");
  });

  test.each(["DENY, DENY", "SAMEORIGIN, SAMEORIGIN", "deny,DENY", "DENY ,  deny"])(
    "joined repeat %p is one value",
    (v) => {
      expect(run({ "x-frame-options": v }).status).toBe("pass");
    },
  );

  test.each(["ALLOWALL", "DENNY", "DENY, SAMEORIGIN", "*"])("invalid %p warns and names the value", (v) => {
    const c = run({ "x-frame-options": v });
    expect(c.status).toBe("warn");
    expect(c.message).toBe(`Unrecognised X-Frame-Options value: ${v}`);
  });

  test("long and control-char values are sanitised in the message", () => {
    const c = run({ "x-frame-options": "BAD\r\n" + "x".repeat(200) });
    expect(c.message).not.toMatch(/[\r\n]/);
    expect(c.message.length).toBeLessThan(140);
  });

  test("invalid value passes via CSP frame-ancestors", () => {
    const c = run({
      "x-frame-options": "ALLOWALL",
      "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
    });
    expect(c.status).toBe("pass");
    expect(c.message).toBe(FA_PASS);
  });

  test("invalid value with a substring-only CSP still warns", () => {
    const c = run({
      "x-frame-options": "ALLOWALL",
      "content-security-policy": "img-src https://frame-ancestors.example.com",
    });
    expect(c.status).toBe("warn");
    expect(c.message).toContain("Unrecognised");
  });

  test("ALLOW-FROM still warns as deprecated", () => {
    const c = run({ "x-frame-options": "ALLOW-FROM https://a.test" });
    expect(c.status).toBe("warn");
    expect(c.message).toBe("ALLOW-FROM is deprecated");
  });

  test("no XFO: frame-ancestors directive passes, case-insensitive, any position", () => {
    for (const csp of ["frame-ancestors 'none'", "default-src 'self';  Frame-Ancestors 'self' ", "script-src 'self'; frame-ancestors"]) {
      expect(run({ "content-security-policy": csp }).message).toBe(FA_PASS);
    }
  });

  test("no XFO: substring in a source value or other directive does not count", () => {
    for (const csp of [
      "img-src https://frame-ancestors.example.com",
      "default-src 'self'; report-uri /frame-ancestors",
      "frame-ancestorsx 'self'",
    ]) {
      const c = run({ "content-security-policy": csp });
      expect(c.status).toBe("warn");
      expect(c.message).toBe("No clickjacking protection");
    }
  });

  test("no XFO and no CSP warns", () => {
    expect(run({}).message).toBe("No clickjacking protection");
  });
});
