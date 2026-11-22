// security/cookie-flags — Secure/HttpOnly/SameSite on Set-Cookie headers.
// #748: false-positive caution — pages with no Set-Cookie header at all must
// pass cleanly.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import {
  cookieFlagsRule,
  isSessionLikeCookie,
} from "../src/security/cookie-flags";

function ctx(
  setCookie: string | undefined,
  url = "https://example.com/"
): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body>content</body></html>`;
  const headers: Record<string, string> = {};
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function checksByName(
  checks: Awaited<ReturnType<typeof cookieFlagsRule.run>>["checks"],
  name: string
) {
  return checks.find((c) => c.name === name);
}

describe("security/cookie-flags", () => {
  test("no Set-Cookie header at all: passes cleanly", async () => {
    const { checks } = await cookieFlagsRule.run(ctx(undefined));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.message).toContain("No cookies");
  });

  test("empty Set-Cookie value: passes cleanly", async () => {
    const { checks } = await cookieFlagsRule.run(ctx(""));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("cookie with all flags set correctly: passes cleanly", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax")
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("missing Secure on an HTTPS page: flagged as warn", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=abc123; Path=/; HttpOnly; SameSite=Lax")
    );
    const check = checksByName(checks, "cookie-secure");
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("session");
  });

  test("missing Secure on an HTTP page: not flagged (no secure connection to restrict to)", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        "session=abc123; Path=/; HttpOnly; SameSite=Lax",
        "http://example.com/"
      )
    );
    expect(checksByName(checks, "cookie-secure")).toBeUndefined();
  });

  test("missing HttpOnly: flagged as warn", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; SameSite=Lax")
    );
    const check = checksByName(checks, "cookie-httponly");
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("session");
  });

  test("missing SameSite: flagged as info (browsers default to Lax)", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly")
    );
    const check = checksByName(checks, "cookie-samesite");
    expect(check?.status).toBe("info");
  });

  test("SameSite=None without Secure: flagged as fail (browsers reject this)", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=abc123; Path=/; HttpOnly; SameSite=None")
    );
    const check = checksByName(checks, "cookie-samesite-none-insecure");
    expect(check?.status).toBe("fail");
    // Not double-counted under the generic missing-SameSite info check.
    expect(checksByName(checks, "cookie-samesite")).toBeUndefined();
  });

  test("SameSite=None WITH Secure: not flagged as broken", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=abc123; Path=/; Secure; HttpOnly; SameSite=None")
    );
    expect(
      checksByName(checks, "cookie-samesite-none-insecure")
    ).toBeUndefined();
  });

  test("multiple cookies newline-joined (future-fixed fetcher format): each evaluated independently", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("a=1; Path=/; Secure; HttpOnly; SameSite=Lax\nb=2; Path=/")
    );
    const secureCheck = checksByName(checks, "cookie-secure");
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["b"]);
  });

  test("three cookies newline-joined (fetcher's real getSetCookie() output, #973): all three evaluated independently", async () => {
    const value = [
      "session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax",
      "csrftoken=xyz789; Path=/; Secure",
      "optout=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
    ].join("\n");
    const { checks } = await cookieFlagsRule.run(ctx(value));
    // "csrftoken" is missing HttpOnly (a CSRF cookie: info since #1378, still
    // evaluated), "optout" is missing both Secure and HttpOnly — if any cookie
    // were silently dropped (the pre-#973 "last cookie wins" bug) these would
    // undercount.
    const httpOnlyCheck = checksByName(checks, "cookie-httponly");
    expect(httpOnlyCheck?.items?.map((i) => i.id)).toEqual(["optout"]);
    expect(
      checksByName(checks, "cookie-httponly-csrf")?.items?.map((i) => i.id)
    ).toEqual(["csrftoken"]);
    const secureCheck = checksByName(checks, "cookie-secure");
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["optout"]);
  });

  test("multiple cookies comma-joined with an Expires date: split correctly, not corrupted by the comma", async () => {
    const value =
      "a=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure; HttpOnly; SameSite=Lax, b=2; Path=/; HttpOnly";
    const { checks } = await cookieFlagsRule.run(ctx(value));
    const secureCheck = checksByName(checks, "cookie-secure");
    // Only "b" is missing Secure — "a" has it. If the Expires comma were
    // mishandled, this would either merge the two cookies into one bogus
    // name or miss "b" entirely.
    expect(secureCheck?.items?.map((i) => i.id)).toEqual(["b"]);
  });

  test("bare cookie with no attributes: flagged for Secure, HttpOnly, and SameSite", async () => {
    const { checks } = await cookieFlagsRule.run(ctx("session=abc123"));
    expect(checksByName(checks, "cookie-secure")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-samesite")?.status).toBe("info");
  });
});

// #1378: a hosting platform's own routing cookie is not an XSS cookie-theft risk.
describe("security/cookie-flags: platform cookies (#1378)", () => {
  test("a page whose only cookie is __dpl: info naming the platform, no HttpOnly warning", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("__dpl=dpl_abc123; Path=/; Secure; SameSite=Lax")
    );
    expect(checksByName(checks, "cookie-httponly")).toBeUndefined();
    const info = checksByName(checks, "cookie-httponly-platform");
    expect(info?.status).toBe("info");
    expect(info?.message).toContain("Lovable");
    expect(info?.message).toContain("__dpl");
    expect(info?.message).toContain("does not document");
    expect(info?.items?.[0]?.id).toBe("__dpl");
    expect(checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(
      false
    );
  });

  test("a session cookie beside __dpl still warns, naming only the session cookie", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        "__dpl=dpl_abc123; Path=/; Secure; SameSite=Lax, session=" +
          "a1b2c3d4".repeat(4) +
          "; Path=/; Secure; SameSite=Lax"
      )
    );
    const warn = checksByName(checks, "cookie-httponly");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.map((i) => i.id)).toEqual(["session"]);
    expect(
      checksByName(checks, "cookie-httponly-platform")?.items?.map((i) => i.id)
    ).toEqual(["__dpl"]);
  });

  test("a session cookie alone without HttpOnly warns as before", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("session=" + "a1b2c3d4".repeat(4) + "; Path=/; Secure; SameSite=Lax")
    );
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
    expect(checksByName(checks, "cookie-httponly-platform")).toBeUndefined();
  });

  test("Secure and SameSite results for __dpl are unchanged", async () => {
    const bare = (await cookieFlagsRule.run(ctx("__dpl=dpl_abc123; Path=/")))
      .checks;
    expect(checksByName(bare, "cookie-secure")?.items?.[0]?.id).toBe("__dpl");
    expect(checksByName(bare, "cookie-samesite")?.items?.[0]?.id).toBe("__dpl");
    const none = (
      await cookieFlagsRule.run(ctx("__dpl=dpl_abc123; Path=/; SameSite=None"))
    ).checks;
    expect(checksByName(none, "cookie-samesite-none-insecure")?.status).toBe(
      "fail"
    );
  });

  test("a platform cookie with HttpOnly set adds no platform info", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("__dpl=dpl_abc123; Path=/; Secure; HttpOnly; SameSite=Lax")
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("the exempt names live in one list, each with a platform, docs link and evidence", async () => {
    const { PLATFORM_COOKIES } =
      await import("../src/security/platform-cookies");
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

  test("names match exactly: __dpl2 and a case variant are ordinary cookies", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        "__dpl2=x; Path=/; Secure; SameSite=Lax, __DPL=y; Path=/; Secure; SameSite=Lax"
      )
    );
    expect(checksByName(checks, "cookie-httponly")?.items).toHaveLength(2);
  });
});

// #1378 follow-up: CSRF double-submit cookies are meant to be read by script.
describe("security/cookie-flags: CSRF token cookies (#1378)", () => {
  const SESSION = "a1b2c3d4".repeat(4);

  test("XSRF-TOKEN and csrftoken without HttpOnly: info with the reason and docs, no warning", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        "XSRF-TOKEN=abc; Path=/; Secure; SameSite=Lax, csrftoken=def; Path=/; Secure; SameSite=Lax"
      )
    );
    expect(checksByName(checks, "cookie-httponly")).toBeUndefined();
    const info = checksByName(checks, "cookie-httponly-csrf");
    expect(info?.status).toBe("info");
    expect(info?.items?.map((i) => i.id)).toEqual(["XSRF-TOKEN", "csrftoken"]);
    expect(info?.message).toContain("Angular");
    expect(info?.message).toContain("Django");
    expect(info?.message).toContain("https://docs.djangoproject.com/");
    expect(checks.some((c) => c.status === "warn" || c.status === "fail")).toBe(
      false
    );
  });

  test("a session cookie beside a CSRF cookie still warns, naming only the session cookie", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        `XSRF-TOKEN=abc; Path=/; Secure; SameSite=Lax, session=${SESSION}; Path=/; Secure; SameSite=Lax, sid=${SESSION}; Path=/; Secure; SameSite=Lax`
      )
    );
    expect(
      checksByName(checks, "cookie-httponly")?.items?.map((i) => i.id)
    ).toEqual(["session", "sid"]);
    expect(
      checksByName(checks, "cookie-httponly-csrf")?.items?.map((i) => i.id)
    ).toEqual(["XSRF-TOKEN"]);
  });

  test("names match exactly: a csrf-looking name outside the list warns", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        "csrf_session=x; Path=/; Secure; SameSite=Lax, XSRF-TOKEN2=y; Path=/; Secure; SameSite=Lax, CSRFTOKEN=z; Path=/; Secure; SameSite=Lax, xsrf-token=w; Path=/; Secure; SameSite=Lax"
      )
    );
    expect(checksByName(checks, "cookie-httponly")?.items).toHaveLength(4);
    expect(checksByName(checks, "cookie-httponly-csrf")).toBeUndefined();
  });

  test("Secure and SameSite are still checked on a CSRF cookie", async () => {
    const bare = (await cookieFlagsRule.run(ctx("XSRF-TOKEN=abc; Path=/")))
      .checks;
    expect(checksByName(bare, "cookie-secure")?.items?.[0]?.id).toBe(
      "XSRF-TOKEN"
    );
    expect(checksByName(bare, "cookie-samesite")?.items?.[0]?.id).toBe(
      "XSRF-TOKEN"
    );
    const none = (
      await cookieFlagsRule.run(ctx("csrftoken=abc; Path=/; SameSite=None"))
    ).checks;
    expect(checksByName(none, "cookie-samesite-none-insecure")?.status).toBe(
      "fail"
    );
  });

  test("prefixed names are not the listed names: __Host- and __Secure- variants still warn", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx(
        "__Host-XSRF-TOKEN=a; Path=/; Secure; SameSite=Lax, __Secure-csrftoken=b; Path=/; Secure; SameSite=Lax"
      )
    );
    expect(
      checksByName(checks, "cookie-httponly")?.items?.map((i) => i.id)
    ).toEqual(["__Host-XSRF-TOKEN", "__Secure-csrftoken"]);
    expect(checksByName(checks, "cookie-httponly-csrf")).toBeUndefined();
  });

  test("a page with only CSRF cookies without HttpOnly has the info check and no pass check", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("XSRF-TOKEN=a; Path=/; Secure; SameSite=Lax")
    );
    expect(checks.map((c) => c.name)).toEqual(["cookie-httponly-csrf"]);
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("the message says HttpOnly is needed only when the frontend reads the cookie, with no claim that it breaks, and ends on a bare URL", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("csrftoken=a; Path=/; Secure; SameSite=Lax")
    );
    const message = checksByName(checks, "cookie-httponly-csrf")?.message ?? "";
    expect(message).toContain(
      "if your frontend does not read it, you can set HttpOnly"
    );
    expect(message).not.toMatch(/break/i);
    expect(message.endsWith("#csrf-cookie-httponly")).toBe(true);
    expect(message).not.toMatch(/\)$/);
  });

  test("a CSRF cookie that already has HttpOnly adds no CSRF info", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctx("csrftoken=abc; Path=/; Secure; HttpOnly; SameSite=Lax")
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });
});

// #2089: any script on the page can read a cookie without HttpOnly, so a
// session-like one fails, naming the hosts, when third-party scripts run there.
describe("security/cookie-flags: third-party scripts on the page (#2089)", () => {
  function ctxWithScripts(
    setCookie: string,
    scripts: string,
    url = "https://www.example.com/account"
  ): RuleContext {
    const html = `<!DOCTYPE html><html><head><title>t</title>${scripts}</head><body>content</body></html>`;
    return {
      page: {
        url,
        html,
        statusCode: 200,
        loadTime: 0,
        headers: { "set-cookie": setCookie },
      },
      parsed: parsePage(html, url),
      options: {},
    } as unknown as RuleContext;
  }

  const SESSION = "PHPSESSID=abc; Path=/; Secure; SameSite=Lax";
  const VENDORS =
    '<script src="https://cdn.optimizely.com/js/123.js"></script>' +
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>';

  test("a session cookie without HttpOnly fails and names the third-party hosts", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(SESSION, VENDORS)
    );
    expect(checksByName(checks, "cookie-httponly")).toBeUndefined();
    const check = checksByName(checks, "cookie-httponly-third-party-scripts");
    expect(check?.status).toBe("fail");
    expect(check?.items?.map((i) => i.id)).toEqual(["PHPSESSID"]);
    expect(check?.message).toBe(
      "1 session-like cookie(s) missing the HttpOnly flag on a page that loads scripts from 2 third-party host(s): cdn.optimizely.com, www.googletagmanager.com. Any script on the page can read these cookies"
    );
    expect(check?.details).toEqual({
      thirdPartyScriptHosts: ["cdn.optimizely.com", "www.googletagmanager.com"],
      thirdPartyScriptHostCount: 2,
    });
  });

  test("the same cookie on a page with no third-party script warns exactly as before", async () => {
    const own =
      '<script src="/app.js"></script><script src="https://cdn.example.com/x.js"></script><script>inline()</script>';
    const withOwn = await cookieFlagsRule.run(ctxWithScripts(SESSION, own));
    const bare = await cookieFlagsRule.run(ctx(SESSION));
    expect(withOwn.checks).toEqual(bare.checks);
    const check = checksByName(withOwn.checks, "cookie-httponly");
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe("1 cookie(s) missing the HttpOnly flag");
  });

  test("a cookie that is not session-like still warns, beside the failing one", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(
        "laravel_session=a; Path=/; Secure; SameSite=Lax\ntheme=dark; Path=/; Secure; SameSite=Lax",
        VENDORS
      )
    );
    expect(
      checksByName(checks, "cookie-httponly-third-party-scripts")?.items?.map(
        (i) => i.id
      )
    ).toEqual(["laravel_session"]);
    const plain = checksByName(checks, "cookie-httponly");
    expect(plain?.status).toBe("warn");
    expect(plain?.items?.map((i) => i.id)).toEqual(["theme"]);
  });

  test("an HttpOnly session cookie is not raised by third-party scripts", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(
        "PHPSESSID=abc; Path=/; Secure; HttpOnly; SameSite=Lax",
        VENDORS
      )
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("names five hosts and counts the rest, sorted and deduplicated", async () => {
    const hosts = ["g", "f", "e", "d", "c", "b", "a"].map(
      (h) => `<script src="https://js.${h}-vendor.net/t.js"></script>`
    );
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(
        SESSION,
        hosts.join("") +
          '<script src="https://js.a-vendor.net/other.js"></script>'
      )
    );
    const check = checksByName(checks, "cookie-httponly-third-party-scripts");
    expect(check?.message).toContain(
      "from 7 third-party host(s): js.a-vendor.net, js.b-vendor.net, js.c-vendor.net, js.d-vendor.net, js.e-vendor.net and 2 more."
    );
    expect(check?.details?.thirdPartyScriptHostCount).toBe(7);
  });

  test("scripts that do not run are not counted: noscript, JSON data blocks", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(
        SESSION,
        '<noscript><script src="https://cdn.vendor.net/a.js"></script></noscript>' +
          '<script type="application/json" src="https://cdn.vendor.net/b.json"></script>'
      )
    );
    expect(
      checksByName(checks, "cookie-httponly-third-party-scripts")
    ).toBeUndefined();
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
  });

  test("a module script from another domain counts", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(
        SESSION,
        '<script type="module" src="//esm.vendor.dev/m.js"></script>'
      )
    );
    expect(
      checksByName(checks, "cookie-httponly-third-party-scripts")?.details
        ?.thirdPartyScriptHosts
    ).toEqual(["esm.vendor.dev"]);
  });

  test("an unread page (no parsed document) warns as before, whatever its raw HTML holds", async () => {
    const page = ctxWithScripts(SESSION, VENDORS);
    const unread = {
      ...page,
      parsed: { ...page.parsed, document: null },
    } as unknown as RuleContext;
    const { checks } = await cookieFlagsRule.run(unread);
    expect(
      checksByName(checks, "cookie-httponly-third-party-scripts")
    ).toBeUndefined();
    expect(checksByName(checks, "cookie-httponly")?.status).toBe("warn");
  });

  test("never calls a vendor malicious", async () => {
    const { checks } = await cookieFlagsRule.run(
      ctxWithScripts(SESSION, VENDORS)
    );
    const text = JSON.stringify(checks).toLowerCase();
    for (const word of ["malicious", "malware", "attacker", "compromised"])
      expect(text).not.toContain(word);
  });
});

describe("isSessionLikeCookie (#2089)", () => {
  test("default session names and credential names count", () => {
    for (const name of [
      "PHPSESSID",
      "JSESSIONID",
      "ASP.NET_SessionId",
      "ASPSESSIONIDQACQ",
      "connect.sid",
      "laravel_session",
      "_myapp_session",
      "__Host-session",
      "sessionid",
      "auth_token",
      "access_token",
      "jwt",
    ])
      expect([name, isSessionLikeCookie(name)]).toEqual([name, true]);
  });

  test("analytics, preference and CSRF cookies do not", () => {
    for (const name of [
      "_ga",
      "_gid",
      "theme",
      "lang",
      "cart_id",
      "session_theme",
      "csrf_token",
      "XSRF-TOKEN",
      "tokenizer",
    ])
      expect([name, isSessionLikeCookie(name)]).toEqual([name, false]);
  });
});
