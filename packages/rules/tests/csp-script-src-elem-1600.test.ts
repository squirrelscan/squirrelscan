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
    const names = checkNames("script-src 'self' 'unsafe-inline' *; script-src-elem 'self'");
    expect(names).not.toContain("csp-unsafe-scripts");
    expect(names).not.toContain("csp-wildcard");
  });

  test("looser script-src-elem than script-src: script elements are judged on the loose list", () => {
    expect(checkNames("script-src 'self'; script-src-elem 'self' 'unsafe-inline'")).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src 'self'; script-src-elem 'self' https://*")).toContain("csp-wildcard");
  });

  test("script-src-elem overrides default-src too, and alone it is script control", () => {
    const names = checkNames("default-src 'self'; script-src-elem 'self' 'unsafe-inline'");
    expect(names).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src-elem 'self'")).not.toContain("csp-no-script-control");
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
