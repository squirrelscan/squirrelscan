// #1778: csp, hsts and x-frame-options judge the first REAL page (2xx, HTML, not a redirect entry), not the first
// entry of `site.pages`, which can be a redirect's 3xx headers or an error page. Each finding names the page.

import { describe, expect, test } from "bun:test";

import { cspRule } from "../src/security/csp";
import { hstsRule } from "../src/security/hsts";
import { xFrameOptionsRule } from "../src/security/x-frame-options";
import type { CheckResult, RuleContext } from "../src/types";

const GOOD = {
  "content-type": "text/html",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self'",
};
const redirectEntry = { url: "https://example.com/about", statusCode: 301, redirectSource: true, headers: { location: "/about/" }, parsed: {} };
const landing = { url: "https://example.com/about/", statusCode: 200, headers: GOOD, parsed: {} };
const bare = { url: "https://example.com/bare", statusCode: 200, headers: { "content-type": "text/html" }, parsed: {} };

const ctx = (pages: unknown[]): RuleContext =>
  ({
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    site: { baseUrl: "https://example.com", pages, robotsTxt: null, sitemaps: null },
    options: {},
  }) as unknown as RuleContext;

const rules = [
  ["security/csp", cspRule, ["csp-missing"]],
  ["security/hsts", hstsRule, ["hsts-missing"]],
  ["security/x-frame-options", xFrameOptionsRule, ["x-frame-options-missing"]],
] as const;

describe("the header rules judge the first real page (#1778)", () => {
  for (const [id, rule, missing] of rules) {
    test(`${id}: a redirecting first entry is not judged by its 3xx headers`, () => {
      const checks = (rule.run(ctx([redirectEntry, landing])) as { checks: CheckResult[] }).checks;
      expect(checks.some((c) => missing.includes(c.name)), id).toBe(false);
      expect(checks.every((c) => c.status !== "warn" && c.status !== "fail"), id).toBe(true);
    });

    test(`${id}: a page without the header is reported, and the finding names the page it was read from`, () => {
      const checks = (rule.run(ctx([redirectEntry, bare])) as { checks: CheckResult[] }).checks;
      const finding = checks.find((c) => c.status === "warn" || c.status === "fail");
      expect(finding, id).toBeDefined();
      expect(finding!.details?.pageUrl).toBe("https://example.com/bare");
      // Not page-addressable: hsts and x-frame-options findings stay whole-site ones (csp's own evidence names its
      // page in `pages`, as it always did).
      if (id !== "security/csp") expect(finding!.pages).toBeUndefined();
    });
  }

  test("with no real page the first entry is judged, as before", () => {
    const checks = (cspRule.run(ctx([redirectEntry])) as { checks: CheckResult[] }).checks;
    expect(checks.length).toBeGreaterThan(0);
  });
});
