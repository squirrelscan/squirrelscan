// security/csp matches script-src sources as whole tokens (#427). The `*` in a
// host wildcard like `https://*.example.com` scopes the source to one domain's
// subdomains; only a bare `*` source lets scripts load from any host.

import { describe, expect, test } from "bun:test";

import { cspRule } from "../src/security/csp";
import type { RuleContext } from "../src/types";

function checkNames(policy: string, header = "content-security-policy"): string[] {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    site: {
      baseUrl: "https://example.com",
      pages: [{ url: "https://example.com/", statusCode: 200, headers: { [header]: policy } }],
    },
    options: {},
  } as unknown as RuleContext;
  const result = cspRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks.map((c) => c.name);
}

describe("security/csp csp-wildcard (#427)", () => {
  test.each([
    ["host wildcard", "script-src 'self' https://*.posthog.com"],
    ["several host wildcards", "default-src 'self'; script-src 'self' https://*.posthog.com *.googletagmanager.com"],
    ["host wildcard with a port wildcard", "script-src https://cdn.example.com:*"],
    ["host wildcard in default-src", "default-src 'self' https://*.example.com"],
  ])("%s: no csp-wildcard", (_name, policy) => {
    expect(checkNames(policy)).not.toContain("csp-wildcard");
  });

  test.each([
    ["bare * in script-src", "script-src *"],
    ["bare * next to other sources", "script-src 'self' https://*.example.com *"],
    ["bare * in default-src with no script-src", "default-src *"],
    ["tab-separated bare *", "script-src 'self'\t*"],
    ["any host over https", "script-src 'self' https://*"],
    ["any host, any port", "script-src *:*"],
    ["any host on one port", "script-src *:443"],
    ["any host with a path", "script-src https://*/js/"],
    ["a comma-joined second policy that does not restrict scripts", "script-src *, img-src 'self'"],
  ])("%s: csp-wildcard", (_name, policy) => {
    expect(checkNames(policy)).toContain("csp-wildcard");
  });

  test("report-only policies are matched the same way", () => {
    const hostWildcard = checkNames(
      "script-src 'self' https://*.posthog.com",
      "content-security-policy-report-only"
    );
    expect(hostWildcard).toContain("csp-report-only");
    expect(hostWildcard).not.toContain("csp-wildcard");
    expect(checkNames("script-src *", "content-security-policy-report-only")).toContain(
      "csp-wildcard"
    );
  });
});

describe("security/csp csp-unsafe-scripts", () => {
  test("keywords match as whole tokens, case-insensitively", () => {
    expect(checkNames("script-src 'self' 'unsafe-inline'")).toContain("csp-unsafe-scripts");
    expect(checkNames("script-src 'self' 'UNSAFE-EVAL'")).toContain("csp-unsafe-scripts");
  });

  test("a comma-joined second policy does not hide the keyword", () => {
    expect(checkNames("script-src 'unsafe-inline', img-src 'self'")).toContain("csp-unsafe-scripts");
  });

  test("a keyword-like host is not the keyword", () => {
    expect(checkNames("script-src 'self' https://unsafe-inline.example.com")).not.toContain(
      "csp-unsafe-scripts"
    );
  });

  test("unsafe keywords outside script-src are not script weaknesses", () => {
    expect(checkNames("script-src 'self'; style-src 'self' 'unsafe-inline'")).not.toContain(
      "csp-unsafe-scripts"
    );
  });
});
