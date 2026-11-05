// #1604: security/csp reports a first-party proxy path that loads third-party code under 'self'.

import { describe, expect, test } from "bun:test";

import { cspRule, CSP_PROXY_PATHS } from "../src/security/csp";
import type { RuleContext } from "../src/types";

function run(policy: string, scriptUrls: string[], header = "content-security-policy") {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    site: {
      baseUrl: "https://example.com",
      pages: [{ url: "https://example.com/", statusCode: 200, headers: { [header]: policy } }],
      scripts: scriptUrls.map((url) => ({ url, status: 200, error: null, contentType: null, sizeBytes: 1, content: null, sourcePages: [] })),
    },
    options: {},
  } as unknown as RuleContext;
  const result = cspRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks.find((c) => c.name === "csp-self-proxy-script");
}

const SELF = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";

describe("security/csp first-party proxy paths (#1604)", () => {
  test("the constant lists the documented paths", () => {
    expect([...CSP_PROXY_PATHS]).toEqual([
      "/_vercel/insights",
      "/_vercel/speed-insights",
      "/ingest",
      "/stats",
      "/plausible",
      "/umami",
    ]);
  });

  for (const path of CSP_PROXY_PATHS) {
    test(`flags ${path}`, () => {
      const check = run(SELF, [`https://example.com${path}/script.js`]);
      expect(check?.status).toBe("info");
      expect(check?.message).toContain(path);
    });
  }

  test("exact path and query also match", () => {
    expect(run(SELF, ["https://example.com/ingest?x=1"])).toBeDefined();
  });

  test("ordinary first-party script paths get no check", () => {
    expect(run(SELF, ["https://example.com/assets/app.js", "https://example.com/statsig/a.js", "https://example.com/ingestor.js"])).toBeUndefined();
  });

  test("a third-party host with a proxy-looking path is not first-party", () => {
    expect(run(SELF, ["https://cdn.other.com/ingest/a.js"])).toBeUndefined();
  });

  test("no check when 'self' is not in the effective script list", () => {
    expect(run("script-src https://example.com", ["https://example.com/ingest/a.js"])).toBeUndefined();
  });

  test("script-src-elem decides over script-src", () => {
    expect(run("script-src 'self'; script-src-elem https://x.test", ["https://example.com/ingest/a.js"])).toBeUndefined();
    expect(run("script-src https://x.test; script-src-elem 'self'", ["https://example.com/ingest/a.js"])).toBeDefined();
  });

  test("bounded: many scripts list at most 10 paths", () => {
    const urls = Array.from({ length: 5000 }, (_, i) => `https://example.com/ingest/${i}.js`);
    const check = run(SELF, [...urls, "https://example.com/stats/a.js"]);
    expect(check).toBeDefined();
    expect(String(check?.value).length).toBeLessThan(500);
  }, 20000);
});
