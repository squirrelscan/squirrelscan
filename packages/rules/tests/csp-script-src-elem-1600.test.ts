// #1600: security/csp judges script elements on script-src-elem, which overrides script-src for them.

import { describe, expect, test } from "bun:test";

import { cspRule } from "../src/security/csp";
import type { RuleContext } from "../src/types";

function checkNames(policy: string): string[] {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    site: {
      baseUrl: "https://example.com",
      pages: [{ url: "https://example.com/", statusCode: 200, headers: { "content-security-policy": policy } }],
    },
    options: {},
  } as unknown as RuleContext;
  const result = cspRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks.map((c) => c.name);
}

describe("security/csp script-src-elem (#1600)", () => {
  test("stricter script-src-elem than script-src: script elements are judged on the strict list", () => {
    const names = checkNames("script-src 'self' 'unsafe-inline' *; script-src-elem 'self'; script-src-attr 'none'");
    expect(names).not.toContain("csp-unsafe-scripts");
    expect(names).not.toContain("csp-wildcard");
  });

  test("looser script-src-elem than script-src: script elements are judged on the loose list", () => {
    expect(checkNames("script-src 'self'; script-src-elem 'self' 'unsafe-inline'")).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src 'self'; script-src-elem 'self' https://*")).toContain("csp-wildcard");
  });

  test("script-src-elem overrides default-src too", () => {
    const names = checkNames("default-src 'self'; script-src-elem 'self' 'unsafe-inline'");
    expect(names).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src-elem 'self'; default-src 'self'")).not.toContain("csp-no-script-control");
  });

  test("unsafe-eval is a script-src matter: script-src-elem does not hide it", () => {
    expect(checkNames("script-src 'self' 'unsafe-eval'; script-src-elem 'self'")).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src 'self'; script-src-elem 'self' 'unsafe-eval'")).not.toContain("csp-unsafe-scripts");
  });

  test("without script-src-elem nothing changes", () => {
    expect(checkNames("script-src 'self' 'unsafe-inline'")).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src 'self'")).not.toContain("csp-unsafe-scripts");
  });
});

describe("security/csp inline event handlers stay judged on script-src-attr (#1600)", () => {
  test("a strict script-src-elem does not hide 'unsafe-inline' that still allows onerror= through script-src", () => {
    const names = checkNames(
      "script-src 'self' 'unsafe-inline'; script-src-elem 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    expect(names).toContain("csp-unsafe-scripts");
  });

  test("script-src-attr falls back to script-src, then default-src", () => {
    expect(checkNames("default-src 'self' 'unsafe-inline'; script-src-elem 'self'")).toContain("csp-unsafe-scripts");
    expect(checkNames("default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-elem 'self'")).toContain(
      "csp-unsafe-scripts",
    );
  });

  test("script-src-attr overrides script-src, in both directions", () => {
    expect(
      checkNames("script-src 'self' 'unsafe-inline'; script-src-elem 'self'; script-src-attr 'none'"),
    ).not.toContain("csp-unsafe-scripts");
    expect(checkNames("script-src 'self'; script-src-attr 'unsafe-inline'")).toContain("csp-unsafe-scripts");
  });

  test("a wildcard or data: source is an element matter: script-src-attr does not raise csp-wildcard", () => {
    expect(checkNames("script-src 'self'; script-src-attr *")).not.toContain("csp-wildcard");
  });
});

describe("security/csp an element-only directive is not script control (#1600)", () => {
  test("script-src-elem 'none' alone leaves handlers and eval uncontrolled: still no script control", () => {
    const names = checkNames("script-src-elem 'none'; object-src 'none'; frame-ancestors 'none'");
    expect(names).toContain("csp-no-script-control");
  });

  test("script-src-elem 'none' with script-src-attr 'none' still leaves eval uncontrolled", () => {
    const names = checkNames(
      "script-src-elem 'none'; script-src-attr 'none'; object-src 'none'; frame-ancestors 'none'",
    );
    expect(names).toContain("csp-no-script-control");
  });

  test("script-src or default-src next to script-src-elem is script control", () => {
    expect(checkNames("script-src 'self'; script-src-elem 'none'")).not.toContain("csp-no-script-control");
    expect(checkNames("default-src 'self'; script-src-elem 'none'")).not.toContain("csp-no-script-control");
  });
});
