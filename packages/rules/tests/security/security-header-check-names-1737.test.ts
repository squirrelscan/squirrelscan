// #1737: security/hsts and security/x-frame-options give every outcome its own check name, as security/csp does,
// so a consumer reading check names can tell "missing" from "present but weak". The name is the outcome.

import { describe, expect, test } from "bun:test";

import { hstsRule } from "../../src/security/hsts";
import { xFrameOptionsRule } from "../../src/security/x-frame-options";
import type { RuleContext } from "../../src/types";

const ctxFor = (url: string, headers: Record<string, string>, pages = true) =>
  ({
    site: { baseUrl: url, pages: pages ? [{ url, statusCode: 200, headers }] : [] },
    options: {},
  }) as unknown as RuleContext;

const one = (rule: { run: (c: RuleContext) => unknown }, ctx: RuleContext) => {
  const { checks } = rule.run(ctx) as { checks: Array<{ name: string; status: string }> };
  expect(checks).toHaveLength(1);
  return checks[0]!;
};

const HTTPS = "https://example.com/";
const HTTP = "http://example.com/";

/** Every outcome of security/hsts: the input that produces it, and the name and status it must have. */
const HSTS_OUTCOMES: Array<{ outcome: string; url: string; headers: Record<string, string>; pages?: boolean; name: string; status: string }> = [
  { outcome: "no pages", url: HTTPS, headers: {}, pages: false, name: "hsts-no-pages", status: "skipped" },
  { outcome: "not served over HTTPS", url: HTTP, headers: {}, name: "hsts-not-applicable", status: "info" },
  { outcome: "header missing", url: HTTPS, headers: {}, name: "hsts-missing", status: "warn" },
  { outcome: "no valid max-age", url: HTTPS, headers: { "strict-transport-security": "includeSubDomains" }, name: "hsts-malformed", status: "warn" },
  { outcome: "max-age=0", url: HTTPS, headers: { "strict-transport-security": "max-age=0" }, name: "hsts-disabled", status: "warn" },
  { outcome: "max-age too short", url: HTTPS, headers: { "strict-transport-security": "max-age=3600" }, name: "hsts-max-age-short", status: "warn" },
  { outcome: "present and adequate", url: HTTPS, headers: { "strict-transport-security": "max-age=31536000; includeSubDomains" }, name: "hsts", status: "pass" },
];

const XFO_OUTCOMES: Array<{ outcome: string; headers: Record<string, string>; pages?: boolean; name: string; status: string }> = [
  { outcome: "no pages", headers: {}, pages: false, name: "x-frame-options-no-pages", status: "skipped" },
  { outcome: "no clickjacking protection", headers: {}, name: "x-frame-options-missing", status: "warn" },
  { outcome: "protected by X-Frame-Options", headers: { "x-frame-options": "DENY" }, name: "x-frame-options", status: "pass" },
  { outcome: "protected by CSP frame-ancestors", headers: { "content-security-policy": "frame-ancestors 'self'" }, name: "x-frame-options-csp-frame-ancestors", status: "pass" },
  { outcome: "deprecated ALLOW-FROM", headers: { "x-frame-options": "ALLOW-FROM https://a.test" }, name: "x-frame-options-allow-from", status: "warn" },
  { outcome: "present but invalid value", headers: { "x-frame-options": "ALLOWALL" }, name: "x-frame-options-invalid", status: "warn" },
];

describe("security/hsts check names (#1737)", () => {
  for (const o of HSTS_OUTCOMES) {
    test(`${o.outcome}: ${o.name} (${o.status})`, () => {
      const c = one(hstsRule, ctxFor(o.url, o.headers, o.pages));
      expect(c.name).toBe(o.name);
      expect(c.status).toBe(o.status);
    });
  }
  test("no two outcomes share a check name", () => {
    const names = HSTS_OUTCOMES.map((o) => one(hstsRule, ctxFor(o.url, o.headers, o.pages)).name);
    expect(new Set(names).size).toBe(names.length);
  });
  test("a present-but-weak header never reads as the adequate one", () => {
    const weak = one(hstsRule, ctxFor(HTTPS, { "strict-transport-security": "max-age=3600" }));
    const missing = one(hstsRule, ctxFor(HTTPS, {}));
    expect(weak.name).not.toBe(missing.name);
    expect(weak.name).not.toBe("hsts");
  });
});

describe("security/x-frame-options check names (#1737)", () => {
  for (const o of XFO_OUTCOMES) {
    test(`${o.outcome}: ${o.name} (${o.status})`, () => {
      const c = one(xFrameOptionsRule, ctxFor("https://acme.test/", o.headers, o.pages));
      expect(c.name).toBe(o.name);
      expect(c.status).toBe(o.status);
    });
  }
  test("a valid CSP frame-ancestors beside an unrecognised X-Frame-Options value is the CSP outcome", () => {
    const c = one(
      xFrameOptionsRule,
      ctxFor("https://acme.test/", { "x-frame-options": "ALLOWALL", "content-security-policy": "frame-ancestors 'self'" }),
    );
    expect(c.name).toBe("x-frame-options-csp-frame-ancestors");
  });
  test("no two outcomes share a check name", () => {
    const names = XFO_OUTCOMES.map((o) => one(xFrameOptionsRule, ctxFor("https://acme.test/", o.headers, o.pages)).name);
    expect(new Set(names).size).toBe(names.length);
  });
});
