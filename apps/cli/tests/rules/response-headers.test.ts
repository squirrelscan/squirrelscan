// Response-header rules: HSTS max-age=0/malformed + HTTP/3 nudge (squirrelscan/squirrelscan#20).

import type { RuleContext } from "@squirrelscan/rules";

import { perf, security } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

const { hstsRule } = security;
const { http2Rule } = perf;

function siteCtx(url: string, headers: Record<string, string>): RuleContext {
  return {
    site: { pages: [{ url, headers }] },
    options: {},
  } as unknown as RuleContext;
}

function pageCtx(url: string, headers: Record<string, string>): RuleContext {
  return { page: { url, headers }, options: {} } as unknown as RuleContext;
}

const HTTPS = "https://example.com/";

describe("security/hsts", () => {
  function hsts(value: string | undefined, url = HTTPS) {
    const headers: Record<string, string> = value
      ? { "strict-transport-security": value }
      : {};
    const { checks } = hstsRule.run(siteCtx(url, headers)) as { checks: any[] };
    return checks.find((c) => c.name === "hsts");
  }

  test("max-age=0 is flagged as disabled, not 'too short'", () => {
    const c = hsts("max-age=0");
    expect(c.status).toBe("warn");
    expect(c.message).toContain("disabled");
    expect(c.message).not.toContain("too short");
  });

  test("max-age=0; preload (real-world reset) flagged as disabled", () => {
    const c = hsts("max-age=0; preload");
    expect(c.status).toBe("warn");
    expect(c.message).toContain("disabled");
  });

  test("header without a max-age directive is malformed", () => {
    const c = hsts("preload; includeSubDomains");
    expect(c.status).toBe("warn");
    expect(c.message).toContain("Malformed");
  });

  test("short max-age still warns as too short", () => {
    const c = hsts("max-age=3600");
    expect(c.status).toBe("warn");
    expect(c.message).toContain("too short");
  });

  test("long max-age passes", () => {
    const c = hsts("max-age=31536000; includeSubDomains");
    expect(c.status).toBe("pass");
  });

  test("missing header warns", () => {
    const c = hsts(undefined);
    expect(c.status).toBe("warn");
    expect(c.message).toContain("Missing");
  });

  test("not applicable on plain HTTP", () => {
    const c = hsts("max-age=0", "http://example.com/");
    expect(c.status).toBe("info");
  });
});

describe("perf/http2 HTTP/3 hint", () => {
  function run(altSvc: string) {
    const { checks } = http2Rule.run(pageCtx(HTTPS, { "alt-svc": altSvc })) as {
      checks: any[];
    };
    return checks;
  }

  test("h2-only Alt-Svc adds an HTTP/3 recommendation", () => {
    const checks = run('h2=":443"; ma=3600');
    expect(
      checks.some((c) => c.name === "http-version" && c.status === "pass")
    ).toBe(true);
    const hint = checks.find((c) => c.name === "http3-hint");
    expect(hint?.status).toBe("info");
    expect(hint?.message).toContain("HTTP/3");
  });

  test("h3 Alt-Svc does not add the hint", () => {
    const checks = run('h3=":443"; h2=":443"');
    expect(
      checks.some(
        (c) => c.name === "http-version" && c.message.includes("HTTP/3")
      )
    ).toBe(true);
    expect(checks.find((c) => c.name === "http3-hint")).toBeUndefined();
  });
});
