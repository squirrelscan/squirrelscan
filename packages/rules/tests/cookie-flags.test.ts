// security/cookie-flags — Secure/HttpOnly/SameSite on Set-Cookie headers.
// #748: false-positive caution — pages with no Set-Cookie header at all must
// pass cleanly.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { cookieFlagsRule } from "../src/security/cookie-flags";
import type { RuleContext } from "../src/types";

function ctx(setCookie: string | undefined, url = "https://example.com/"): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body>content</body></html>`;
  const headers: Record<string, string> = {};
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function checksByName(checks: ReturnType<typeof cookieFlagsRule.run>["checks"], name: string) {
  return checks.find((c) => c.name === name);
}

describe("security/cookie-flags", () => {
  test("no Set-Cookie header at all: passes cleanly", () => {
    const { checks } = cookieFlagsRule.run(ctx(undefined));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.message).toContain("No cookies");
  });

  test("empty Set-Cookie value: passes cleanly", () => {
    const { checks } = cookieFlagsRule.run(ctx(""));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("cookie with all flags set correctly: passes cleanly", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax"),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("missing Secure on an HTTPS page: flagged as warn", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; HttpOnly; SameSite=Lax"));
    const check = checksByName(checks, "cookie-secure");
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("session");
  });

  test("missing Secure on an HTTP page: not flagged (no secure connection to restrict to)", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=abc123; Path=/; HttpOnly; SameSite=Lax", "http://example.com/"),
    );
    expect(checksByName(checks, "cookie-secure")).toBeUndefined();
  });

  test("missing HttpOnly: flagged as warn", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; Secure; SameSite=Lax"));
    const check = checksByName(checks, "cookie-httponly");
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("session");
  });

  test("missing SameSite: flagged as info (browsers default to Lax)", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; Secure; HttpOnly"));
    const check = checksByName(checks, "cookie-samesite");
    expect(check?.status).toBe("info");
  });

  test("SameSite=None without Secure: flagged as fail (browsers reject this)", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123; Path=/; HttpOnly; SameSite=None"));
    const check = checksByName(checks, "cookie-samesite-none-insecure");
    expect(check?.status).toBe("fail");
    // Not double-counted under the generic missing-SameSite info check.
    expect(checksByName(checks, "cookie-samesite")).toBeUndefined();
  });

  test("SameSite=None WITH Secure: not flagged as broken", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly; SameSite=None"),
    );
    expect(checksByName(checks, "cookie-samesite-none-insecure")).toBeUndefined();
  });

  test("multiple cookies newline-joined (future-fixed fetcher format): each evaluated independently", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("a=1; Path=/; Secure; HttpOnly; SameSite=Lax\nb=2; Path=/"),
    );
    const secureCheck = checksByName(checks, "cookie-secure");
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["b"]);
  });

  test("three cookies newline-joined (fetcher's real getSetCookie() output, #973): all three evaluated independently", () => {
    const value = [
      "session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax",
      "csrftoken=xyz789; Path=/; Secure",
      "optout=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
    ].join("\n");
    const { checks } = cookieFlagsRule.run(ctx(value));
    // "csrftoken" is missing HttpOnly (a CSRF cookie: info since #1378, still
    // evaluated), "optout" is missing both Secure and HttpOnly — if any cookie
    // were silently dropped (the pre-#973 "last cookie wins" bug) these would
    // undercount.
    const httpOnlyCheck = checksByName(checks, "cookie-httponly");
    expect(httpOnlyCheck?.items?.map((i) => i.id)).toEqual(["optout"]);
    expect(checksByName(checks, "cookie-httponly-csrf")?.items?.map((i) => i.id)).toEqual([
      "csrftoken",
    ]);
    const secureCheck = checksByName(checks, "cookie-secure");
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["optout"]);
  });

  test("multiple cookies comma-joined with an Expires date: split correctly, not corrupted by the comma", () => {
    const value =
      "a=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure; HttpOnly; SameSite=Lax, b=2; Path=/; HttpOnly";
    const { checks } = cookieFlagsRule.run(ctx(value));
    const secureCheck = checksByName(checks, "cookie-secure");
    // Only "b" is missing Secure — "a" has it. If the Expires comma were
    // mishandled, this would either merge the two cookies into one bogus
    // name or miss "b" entirely.
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["b"]);
  });

  test("bare cookie with no attributes: flagged for Secure, HttpOnly, and SameSite", () => {
    const { checks } = cookieFlagsRule.run(ctx("session=abc123"));
    expect(checksByName(checks, "cookie-secure")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-samesite")?.status).toBe("info");
  });
});

// #1378: a hosting platform's own routing cookie is not an XSS cookie-theft risk.
describe("security/cookie-flags: platform cookies (#1378)", () => {
  test("a page whose only cookie is __dpl: info naming the platform, no HttpOnly warning", () => {
    const { checks } = cookieFlagsRule.run(ctx("__dpl=dpl_abc123; Path=/; Secure; SameSite=Lax"));
    expect(checksByName(checks, "cookie-httponly")).toBeUndefined();
    const info = checksByName(checks, "cookie-httponly-platform");
    expect(info?.status).toBe("info");
    expect(info?.message).toContain("Lovable");
    expect(info?.message).toContain("__dpl");
    expect(info?.message).toContain("does not document");
    expect(info?.items?.[0]?.id).toBe("__dpl");
    expect(checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(false);
  });

  test("a session cookie beside __dpl still warns, naming only the session cookie", () => {
    const { checks } = cookieFlagsRule.run(
      ctx(
        "__dpl=dpl_abc123; Path=/; Secure; SameSite=Lax, session=" +
          "a1b2c3d4".repeat(4) +
          "; Path=/; Secure; SameSite=Lax",
      ),
    );
    const warn = checksByName(checks, "cookie-httponly");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.map((i) => i.id)).toEqual(["session"]);
    expect(checksByName(checks, "cookie-httponly-platform")?.items?.map((i) => i.id)).toEqual([
      "__dpl",
    ]);
  });

  test("a session cookie alone without HttpOnly warns as before", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("session=" + "a1b2c3d4".repeat(4) + "; Path=/; Secure; SameSite=Lax"),
    );
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-httponly-platform")).toBeUndefined();
  });

  test("Secure and SameSite results for __dpl are unchanged", () => {
    const bare = cookieFlagsRule.run(ctx("__dpl=dpl_abc123; Path=/")).checks;
    expect(checksByName(bare, "cookie-secure")?.items?.[0]?.id).toBe("__dpl");
    expect(checksByName(bare, "cookie-samesite")?.items?.[0]?.id).toBe("__dpl");
    const none = cookieFlagsRule.run(ctx("__dpl=dpl_abc123; Path=/; SameSite=None")).checks;
    expect(checksByName(none, "cookie-samesite-none-insecure")?.status).toBe("fail");
  });

  test("a platform cookie with HttpOnly set adds no platform info", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("__dpl=dpl_abc123; Path=/; Secure; HttpOnly; SameSite=Lax"),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("the exempt names live in one list, each with a platform, docs link and evidence", async () => {
    const { PLATFORM_COOKIES } = await import("../src/security/platform-cookies");
    expect(PLATFORM_COOKIES.length).toBeGreaterThan(0);
    for (const c of PLATFORM_COOKIES) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.platform.length).toBeGreaterThan(0);
      for (const d of c.docs) expect(d).toMatch(/^https:\/\//);
      expect(c.docs.length).toBeGreaterThan(0);
      expect(["platform", "csrf"]).toContain(c.kind);
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(typeof c.documented).toBe("boolean");
    }
  });

  test("names match exactly: __dpl2 and a case variant are ordinary cookies", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("__dpl2=x; Path=/; Secure; SameSite=Lax, __DPL=y; Path=/; Secure; SameSite=Lax"),
    );
    expect(checksByName(checks, "cookie-httponly")?.items).toHaveLength(2);
  });
});

// #1378 follow-up: CSRF double-submit cookies are meant to be read by script.
describe("security/cookie-flags: CSRF token cookies (#1378)", () => {
  const SESSION = "a1b2c3d4".repeat(4);

  test("XSRF-TOKEN and csrftoken without HttpOnly: info with the reason and docs, no warning", () => {
    const { checks } = cookieFlagsRule.run(
      ctx(
        "XSRF-TOKEN=abc; Path=/; Secure; SameSite=Lax, csrftoken=def; Path=/; Secure; SameSite=Lax",
      ),
    );
    expect(checksByName(checks, "cookie-httponly")).toBeUndefined();
    const info = checksByName(checks, "cookie-httponly-csrf");
    expect(info?.status).toBe("info");
    expect(info?.items?.map((i) => i.id)).toEqual(["XSRF-TOKEN", "csrftoken"]);
    expect(info?.message).toContain("Angular");
    expect(info?.message).toContain("Django");
    expect(info?.message).toContain("https://docs.djangoproject.com/");
    expect(checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(false);
  });

  test("a session cookie beside a CSRF cookie still warns, naming only the session cookie", () => {
    const { checks } = cookieFlagsRule.run(
      ctx(
        `XSRF-TOKEN=abc; Path=/; Secure; SameSite=Lax, session=${SESSION}; Path=/; Secure; SameSite=Lax, sid=${SESSION}; Path=/; Secure; SameSite=Lax`,
      ),
    );
    expect(checksByName(checks, "cookie-httponly")?.items?.map((i) => i.id)).toEqual([
      "session",
      "sid",
    ]);
    expect(checksByName(checks, "cookie-httponly-csrf")?.items?.map((i) => i.id)).toEqual([
      "XSRF-TOKEN",
    ]);
  });

  test("names match exactly: a csrf-looking name outside the list warns", () => {
    const { checks } = cookieFlagsRule.run(
      ctx(
        "csrf_session=x; Path=/; Secure; SameSite=Lax, XSRF-TOKEN2=y; Path=/; Secure; SameSite=Lax, CSRFTOKEN=z; Path=/; Secure; SameSite=Lax, xsrf-token=w; Path=/; Secure; SameSite=Lax",
      ),
    );
    expect(checksByName(checks, "cookie-httponly")?.items).toHaveLength(4);
    expect(checksByName(checks, "cookie-httponly-csrf")).toBeUndefined();
  });

  test("Secure and SameSite are still checked on a CSRF cookie", () => {
    const bare = cookieFlagsRule.run(ctx("XSRF-TOKEN=abc; Path=/")).checks;
    expect(checksByName(bare, "cookie-secure")?.items?.[0]?.id).toBe("XSRF-TOKEN");
    expect(checksByName(bare, "cookie-samesite")?.items?.[0]?.id).toBe("XSRF-TOKEN");
    const none = cookieFlagsRule.run(ctx("csrftoken=abc; Path=/; SameSite=None")).checks;
    expect(checksByName(none, "cookie-samesite-none-insecure")?.status).toBe("fail");
  });

  test("prefixed names are not the listed names: __Host- and __Secure- variants still warn", () => {
    const { checks } = cookieFlagsRule.run(
      ctx(
        "__Host-XSRF-TOKEN=a; Path=/; Secure; SameSite=Lax, __Secure-csrftoken=b; Path=/; Secure; SameSite=Lax",
      ),
    );
    expect(checksByName(checks, "cookie-httponly")?.items?.map((i) => i.id)).toEqual([
      "__Host-XSRF-TOKEN",
      "__Secure-csrftoken",
    ]);
    expect(checksByName(checks, "cookie-httponly-csrf")).toBeUndefined();
  });

  test("a page with only CSRF cookies without HttpOnly has the info check and no pass check", () => {
    const { checks } = cookieFlagsRule.run(ctx("XSRF-TOKEN=a; Path=/; Secure; SameSite=Lax"));
    expect(checks.map((c) => c.name)).toEqual(["cookie-httponly-csrf"]);
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("the message says HttpOnly is needed only when the frontend reads the cookie, with no claim that it breaks, and ends on a bare URL", () => {
    const { checks } = cookieFlagsRule.run(ctx("csrftoken=a; Path=/; Secure; SameSite=Lax"));
    const message = checksByName(checks, "cookie-httponly-csrf")?.message ?? "";
    expect(message).toContain("if your frontend does not read it, you can set HttpOnly");
    expect(message).not.toMatch(/break/i);
    expect(message.endsWith("#csrf-cookie-httponly")).toBe(true);
    expect(message).not.toMatch(/\)$/);
  });

  test("a CSRF cookie that already has HttpOnly adds no CSRF info", () => {
    const { checks } = cookieFlagsRule.run(
      ctx("csrftoken=abc; Path=/; Secure; HttpOnly; SameSite=Lax"),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });
});
