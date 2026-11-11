// #1735: security/csp names the page the header was read from, the header, and the directive
// carrying 'unsafe-inline' with its value, as structured details (not only prose in `value`).

import { describe, expect, test } from "bun:test";

import { cspRule } from "../src/security/csp";
import type { CheckResult, RuleContext } from "../src/types";

function checks(headers: Record<string, string>): CheckResult[] {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    site: {
      baseUrl: "https://example.com",
      pages: [{ url: "https://example.com/", statusCode: 200, headers }],
    },
    options: {},
  } as unknown as RuleContext;
  const result = cspRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks;
}

const byName = (list: CheckResult[], name: string) => list.find((c) => c.name === name)!;

describe("security/csp evidence (#1735)", () => {
  test("unsafe-inline names the page, the header and the directive carrying it", () => {
    const list = checks({
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.example.com",
    });
    const check = byName(list, "csp-unsafe-scripts");
    expect(check.pages).toEqual(["https://example.com/"]);
    expect(check.details).toMatchObject({
      pageUrl: "https://example.com/",
      header: "content-security-policy",
      directive: "script-src",
      value: "'self' 'unsafe-inline' https://cdn.example.com",
    });
    expect((check.details as { directives: unknown[] }).directives).toEqual([
      {
        directive: "script-src",
        value: "'self' 'unsafe-inline' https://cdn.example.com",
        sources: ["'unsafe-inline'"],
      },
    ]);
  });

  test("the directive is the one browsers read: default-src fallback, script-src-elem override", () => {
    const fallback = byName(
      checks({ "content-security-policy": "default-src 'self' 'unsafe-inline'" }),
      "csp-unsafe-scripts",
    );
    expect(fallback.details).toMatchObject({ directive: "default-src", value: "'self' 'unsafe-inline'" });

    const elem = byName(
      checks({ "content-security-policy": "script-src 'self'; script-src-elem 'self' 'unsafe-inline'" }),
      "csp-unsafe-scripts",
    );
    expect(elem.details).toMatchObject({ directive: "script-src-elem", value: "'self' 'unsafe-inline'" });
  });

  test("a report-only policy names the report-only header", () => {
    const list = checks({ "content-security-policy-report-only": "script-src 'unsafe-inline'" });
    expect(byName(list, "csp-report-only").details).toMatchObject({
      header: "content-security-policy-report-only",
      pageUrl: "https://example.com/",
    });
    expect(byName(list, "csp-unsafe-scripts").details).toMatchObject({
      header: "content-security-policy-report-only",
      directive: "script-src",
    });
  });

  test("a missing header still names the page it looked at", () => {
    const check = byName(checks({}), "csp-missing");
    expect(check.pages).toEqual(["https://example.com/"]);
    expect(check.details).toMatchObject({ pageUrl: "https://example.com/", header: "content-security-policy" });
  });

  test("the directive value kept as evidence is bounded", () => {
    const long = `script-src 'unsafe-inline' ${"https://a.example.com ".repeat(40)}`;
    const check = byName(checks({ "content-security-policy": long }), "csp-unsafe-scripts");
    expect(String((check.details as { value: string }).value).length).toBeLessThanOrEqual(300);
  });
});
