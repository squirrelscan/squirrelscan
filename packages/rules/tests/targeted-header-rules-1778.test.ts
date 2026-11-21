// #1778: on a targeted run the response-header rules (security/csp, security/hsts, security/x-frame-options)
// judge every listed page on its own, and each row names the pages it speaks for. A full audit still reads
// the entry page only, with the row shape it always had.

import { describe, expect, test } from "bun:test";

import type { CheckResult, Rule, RuleContext } from "../src/types";

import { cspRule } from "../src/security/csp";
import { hstsRule } from "../src/security/hsts";
import { xFrameOptionsRule } from "../src/security/x-frame-options";

const A = "https://example.com/a";
const B = "https://example.com/b";
const C = "https://example.com/c";
const GONE = "https://example.com/gone";

const SECURE = {
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
};

const PAGES = [
  { url: A, statusCode: 200, headers: SECURE },
  { url: B, statusCode: 200, headers: {} },
  { url: C, statusCode: 200, headers: {} },
  // A listed page that answered 404: an error response says nothing about the page's own headers.
  { url: GONE, statusCode: 404, headers: {} },
];

function run(rule: Rule, targetedRun: boolean): CheckResult[] {
  const ctx = {
    page: { url: A, html: "", statusCode: 200, loadTime: 0, headers: {} },
    site: {
      baseUrl: "https://example.com",
      pages: PAGES,
      ...(targetedRun ? { targetedRun: true } : {}),
    },
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks;
}

const named = (checks: CheckResult[], name: string) =>
  checks.filter((c) => c.name === name);

describe("header rules on a targeted run (#1778)", () => {
  test("security/hsts judges each listed page and names the pages of each row", () => {
    const checks = run(hstsRule, true);
    expect(named(checks, "hsts").map((c) => c.pages)).toEqual([[A]]);
    expect(named(checks, "hsts")[0]!.pageUrl).toBe(A);
    // The same finding on two pages is one row listing both, with no single pageUrl.
    const missing = named(checks, "hsts-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.pages).toEqual([B, C]);
    expect(missing[0]!.pageUrl).toBeUndefined();
    // The 404 page is not judged.
    expect(checks.some((c) => c.pages?.includes(GONE))).toBe(false);
  });

  test("security/x-frame-options judges each listed page", () => {
    const checks = run(xFrameOptionsRule, true);
    expect(named(checks, "x-frame-options").map((c) => c.pages)).toEqual([[A]]);
    expect(
      named(checks, "x-frame-options-missing").map((c) => c.pages)
    ).toEqual([[B, C]]);
  });

  test("security/csp judges each listed page; a row for several pages drops the one-page detail", () => {
    const checks = run(cspRule, true);
    const present = named(checks, "csp-present");
    expect(present.map((c) => c.pages)).toEqual([[A]]);
    expect(present[0]!.details).toMatchObject({ pageUrl: A });
    const missing = named(checks, "csp-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.pages).toEqual([B, C]);
    expect(missing[0]!.details).not.toHaveProperty("pageUrl");
    expect(missing[0]!.details).toMatchObject({
      header: "content-security-policy",
    });
  });

  test("a full audit reads the entry page only, rows unchanged", () => {
    for (const rule of [hstsRule, xFrameOptionsRule]) {
      const checks = run(rule, false);
      expect(checks.map((c) => c.status)).toEqual(["pass"]);
      // No page named: a full audit's header row speaks for the site, as it always did.
      expect(checks[0]!.pages).toBeUndefined();
      expect(checks[0]!.pageUrl).toBeUndefined();
    }
    const csp = run(cspRule, false);
    expect(csp.every((c) => c.pages?.length === 1 && c.pages[0] === A)).toBe(
      true
    );
    expect(named(csp, "csp-missing")).toHaveLength(0);
  });

  test("a targeted run whose listed pages all failed has nothing to judge", () => {
    const ctx = {
      site: {
        baseUrl: "https://example.com",
        pages: [PAGES[3]],
        targetedRun: true,
      },
      options: {},
    } as unknown as RuleContext;
    const result = hstsRule.run(ctx);
    if (result instanceof Promise) throw new Error("rule is async");
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ["hsts-no-pages", "skipped"],
    ]);
  });
});
