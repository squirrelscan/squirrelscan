// security/wordpress-exposure: gated on WordPress detection, GET-only to four
// fixed same-origin paths, usernames only when aggressive, never puts a
// username or body in a finding.

import { afterEach, describe, expect, test } from "bun:test";

import {
  isWordpressSite,
  MAX_WORDPRESS_REQUESTS,
  runWordpressExposure,
  WORDPRESS_PROBES,
  wordpressExposureRule,
} from "../src/security/wordpress-exposure";
import {
  BASE,
  candidate,
  html,
  json,
  robots,
  ruleCtx,
  stubFetch,
  surface,
  type Route,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const wpSurface = () =>
  surface([
    candidate("/wp-json/", {
      method: "GET",
      source: "convention",
      discoveredVia: "convention:wordpress",
    }),
  ]);

const USERNAME = "secret-admin-login";
const USERS = [{ id: 1, name: "A", slug: USERNAME, link: `${BASE}/author/x/` }];
const README = `<html><head><title>WordPress &#8250; ReadMe</title></head><body><h1>WordPress</h1><br /> Version 5.8.1</body></html>`;

const open: Record<string, Route> = {
  [`${BASE}/readme.html`]: () => html(README, 200),
  [`${BASE}/xmlrpc.php`]: () =>
    new Response("XML-RPC server accepts POST requests only.", { status: 405 }),
  [`${BASE}/wp-json/wp/v2/users`]: () => json(USERS),
  [`${BASE}/`]: () =>
    new Response(null, {
      status: 301,
      headers: { location: `${BASE}/author/${USERNAME}/` },
    }),
};

const names = (checks: { name: string }[]) => checks.map((c) => c.name).sort();

describe("security/wordpress-exposure", () => {
  test("sends nothing and reports nothing on a site not detected as WordPress", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const ctx = ruleCtx({ level: "aggressive", surface: surface([]) });
    expect(isWordpressSite(ctx)).toBe(false);
    expect((await runWordpressExposure(ctx)).checks).toEqual([]);
    expect(stub.sent).toHaveLength(0);
  });

  test("passive run sends nothing and skips every family", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "passive", surface: wpSurface() })
    );
    expect(stub.sent).toHaveLength(0);
    expect(checks.every((c) => c.skipReason === "probing-passive")).toBe(true);
    expect(checks).toHaveLength(3);
  });

  test("active run probes readme and xmlrpc only, users are not requested", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "active", surface: wpSurface() })
    );
    expect(stub.sent.map((r) => r.url).sort()).toEqual([
      `${BASE}/readme.html`,
      `${BASE}/xmlrpc.php`,
    ]);
    expect(names(checks)).toEqual([
      "wordpress-user-enumeration-not-checked",
      "wordpress-version-disclosure",
      "wordpress-xmlrpc-enabled",
    ]);
    const users = checks.find((c) => c.name.startsWith("wordpress-user"));
    expect(users?.skipReason).toBe("probe-level-too-low");
  });

  test("aggressive run finds all three, sends only the fixed GETs, leaks no username", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface() })
    );
    expect(stub.sent).toHaveLength(WORDPRESS_PROBES.length);
    expect(stub.sent.length).toBeLessThanOrEqual(MAX_WORDPRESS_REQUESTS);
    for (const r of stub.sent) {
      expect(r.method).toBe("GET");
      expect(r.credentials).toBe("omit");
      expect(r.redirect).toBe("manual");
      expect(new URL(r.url).origin).toBe(BASE);
    }
    expect(names(checks)).toEqual([
      "wordpress-user-enumeration",
      "wordpress-version-disclosure",
      "wordpress-xmlrpc-enabled",
    ]);
    const all = JSON.stringify(checks);
    expect(all).not.toContain(USERNAME);
    expect(all).toContain("5.8.1");
    const users = checks.find((c) => c.name === "wordpress-user-enumeration")!;
    expect(users.items).toHaveLength(2);
    expect(users.status).toBe("warn");
    expect(users.message).toContain("brute-force");
    expect(
      checks.find((c) => c.name === "wordpress-xmlrpc-enabled")?.message
    ).toContain("pingback");
  });

  test("a hardened site passes every family when each answer is definite", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface() })
    );
    expect(names(checks)).toEqual([
      "wordpress-user-enumeration-closed",
      "wordpress-version-disclosure-closed",
      "wordpress-xmlrpc-closed",
    ]);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("status alone is not evidence: a 200 shell on every path is a pass", async () => {
    const shell = () => html("<html><body>app</body></html>", 200);
    const stub = stubFetch({
      [`${BASE}/readme.html`]: shell,
      [`${BASE}/xmlrpc.php`]: shell,
      [`${BASE}/wp-json/wp/v2/users`]: shell,
      [`${BASE}/`]: shell,
    });
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface() })
    );
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("an empty users list and an author redirect off-site are not findings", async () => {
    const stub = stubFetch({
      [`${BASE}/wp-json/wp/v2/users`]: () => json([]),
      [`${BASE}/`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.org/author/x/" },
        }),
    });
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface() })
    );
    expect(checks.map((c) => c.name)).toContain(
      "wordpress-user-enumeration-closed"
    );
  });

  test("a 429 stops the run and nothing after it is requested or passed", async () => {
    const stub = stubFetch({
      [`${BASE}/readme.html`]: () => new Response("slow", { status: 429 }),
    });
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface() })
    );
    expect(stub.sent).toHaveLength(1);
    expect(checks.every((c) => c.status === "skipped")).toBe(true);
  });

  test("a robots.txt-disallowed path is not requested below aggressive", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({
        level: "active",
        surface: wpSurface(),
        robotsTxt: robots(["/xmlrpc.php"]),
      })
    );
    expect(stub.sent.map((r) => r.url)).toEqual([`${BASE}/readme.html`]);
    const x = checks.find((c) => c.name === "wordpress-xmlrpc-not-checked");
    expect(x?.skipReason).toBe("robots-disallowed");
  });

  test("the shared probe budget bounds the run", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface(), budgetMs: 0 })
    );
    expect(stub.sent).toHaveLength(0);
    expect(checks.every((c) => c.status === "skipped")).toBe(true);
  });

  test("every emitted check name is declared in meta.checks", async () => {
    const stub = stubFetch(open);
    restore = stub.restore;
    const declared = new Set(
      wordpressExposureRule.meta.checks?.map((c) => c.name)
    );
    const { checks } = await runWordpressExposure(
      ruleCtx({ level: "aggressive", surface: wpSurface() })
    );
    for (const c of checks) expect(declared.has(c.name)).toBe(true);
  });
});
