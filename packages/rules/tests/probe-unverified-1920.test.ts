// #1920: protected vs unverified for the probing rules. A 401, and a 403 the
// app sent itself (JSON or plain, no WAF marker), mean the endpoint is
// protected: a real answer. Only a 429, a challenge (a challenge page or WAF
// markers), a 5xx, or a timeout or network error is unverified, and an
// unverified endpoint never lets the rule pass. The WAF markers are one shared
// list (`WAF_CHALLENGE_MARKERS` in @squirrelscan/utils/waf-markers).

import {
  hasWafChallengeEvidence,
  wafChallengeVendor,
  WAF_CHALLENGE_MARKERS,
} from "@squirrelscan/utils/waf-markers";
import { afterEach, describe, expect, test } from "bun:test";

import type { CheckResult, Rule } from "../src/types";

import { jsonSensitiveFieldsRule } from "../src/security/json-sensitive-fields";
import {
  isThrottledOrChallenged,
  isUnverifiedReply,
} from "../src/security/probe-http";
import { unauthenticatedApiRule } from "../src/security/unauthenticated-api";
import {
  BASE,
  candidate,
  json,
  ruleCtx,
  stubFetch,
  surface,
  type Route,
  type SentRequest,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const USERS = `${BASE}/api/users`;
const POSTS = `${BASE}/api/posts`;
const HASH = "hashvalue-alpha-0001";
const USER_ROWS = [
  {
    id: 1,
    email: "alice@example.org",
    password: HASH,
    role: "admin",
    name: "Alice",
  },
  {
    id: 2,
    email: "bob@example.org",
    password: HASH,
    role: "user",
    name: "Bob",
  },
];

/** The app's own refusal: JSON, behind Cloudflare, no challenge. */
const appForbidden = () =>
  new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      server: "cloudflare",
      "cf-ray": "8a1-SYD",
    },
  });
const appUnauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": "Bearer",
    },
  });
/** A Cloudflare managed challenge in the app's place. */
const cfChallenge = () =>
  new Response(
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
    {
      status: 403,
      headers: {
        "content-type": "text/html",
        server: "cloudflare",
        "cf-mitigated": "challenge",
      },
    }
  );
const throttled = () =>
  new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
const serverError = () => new Response("upstream failed", { status: 502 });

async function run(
  rule: Rule,
  routes: Record<string, Route>,
  paths: string[]
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const ctx = ruleCtx({
    surface: surface(paths.map((p) => candidate(p, { method: "GET" }))),
  });
  const { checks } = await rule.run(ctx);
  return { checks, sent: stub.sent };
}

const RULES: [string, Rule, string][] = [
  [
    "security/unauthenticated-api",
    unauthenticatedApiRule,
    "unauthenticated-api-unchecked",
  ],
  [
    "security/json-sensitive-fields",
    jsonSensitiveFieldsRule,
    "json-api-responses",
  ],
];

describe("shared WAF markers (#1920)", () => {
  test("one list with the link checker's vendors", () => {
    expect(WAF_CHALLENGE_MARKERS.map((m) => m.vendor)).toEqual([
      "cloudflare",
      "akamai",
      "datadome",
      "perimeterx",
      "imperva",
      "sucuri",
      "aws-waf",
    ]);
  });

  test.each([
    ["cloudflare", { headers: { "cf-mitigated": "challenge" } }],
    [
      "cloudflare",
      {
        headers: { server: "cloudflare" },
        body: "<title>Just a moment...</title>",
      },
    ],
    ["akamai", { headers: { "x-akamai-session-info": "x" } }],
    ["akamai", { body: "Access Denied. Reference #18.abc - AkamaiGHost" }],
    ["datadome", { cookieNames: ["datadome"] }],
    ["perimeterx", { cookieNames: ["_pxhd"] }],
    ["imperva", { headers: { "x-iinfo": "1-2-3" } }],
    ["imperva", { cookieNames: ["incap_ses_123_456"] }],
    ["sucuri", { headers: { "x-sucuri-id": "1" } }],
    ["aws-waf", { headers: { "x-amzn-waf-action": "captcha" } }],
  ] as const)("%s markers are evidence", (vendor, sniff) => {
    expect(wafChallengeVendor(sniff)).toBe(vendor);
  });

  test("Cloudflare body markers need server: cloudflare; set-cookie names are read from Headers", () => {
    expect(
      hasWafChallengeEvidence({
        headers: { server: "nginx" },
        body: "just a moment",
      })
    ).toBe(false);
    const h = new Headers();
    h.append("set-cookie", "datadome=abc; Path=/");
    expect(wafChallengeVendor({ headers: h })).toBe("datadome");
    expect(
      hasWafChallengeEvidence({
        headers: { server: "cloudflare" },
        body: '{"error":"forbidden"}',
      })
    ).toBe(false);
  });
});

describe("probe-http: protected vs unverified (#1920)", () => {
  const reply = (r: Response, text: string) => ({
    status: r.status,
    headers: r.headers,
    text,
  });

  test("401 and an app 403 (JSON or plain) are verified: the endpoint is protected", () => {
    for (const r of [
      reply(appUnauthorized(), '{"error":"unauthorized"}'),
      reply(appForbidden(), '{"error":"forbidden"}'),
      reply(new Response("Forbidden", { status: 403 }), "Forbidden"),
      reply(new Response("nope", { status: 404 }), "nope"),
    ]) {
      expect(isThrottledOrChallenged(r)).toBe(false);
      expect(isUnverifiedReply(r)).toBe(false);
    }
  });

  test("429, a challenge, a 403 with WAF markers and a 5xx are unverified", () => {
    const wafHeaders = (h: Record<string, string>) => new Headers(h);
    const cases = [
      { status: 429, headers: null, text: "" },
      {
        status: 403,
        headers: wafHeaders({ "cf-mitigated": "challenge" }),
        text: "",
      },
      {
        status: 403,
        headers: wafHeaders({ server: "cloudflare" }),
        text: "<html>cf-chl</html>",
      },
      {
        status: 403,
        headers: wafHeaders({ "x-amzn-waf-action": "block" }),
        text: '{"message":"Forbidden"}',
      },
      {
        status: 403,
        headers: wafHeaders({ "x-datadome": "protected" }),
        text: "",
      },
      { status: 403, headers: wafHeaders({ "x-sucuri-id": "1" }), text: "" },
    ];
    for (const r of cases) {
      expect(isThrottledOrChallenged(r)).toBe(true);
      expect(isUnverifiedReply(r)).toBe(true);
    }
    expect(isUnverifiedReply({ status: 502, headers: null, text: "" })).toBe(
      true
    );
    expect(
      isThrottledOrChallenged({ status: 502, headers: null, text: "" })
    ).toBe(false);
  });

  test("WAF markers on a 2xx or a 401 prove nothing (they ride on every answer from a protected site)", () => {
    const headers = new Headers({
      "x-datadome": "protected",
      "x-akamai-transformed": "9",
    });
    expect(isThrottledOrChallenged({ status: 200, headers, text: "[]" })).toBe(
      false
    );
    expect(isThrottledOrChallenged({ status: 401, headers, text: "{}" })).toBe(
      false
    );
  });
});

for (const [label, rule, uncheckedName] of RULES) {
  describe(`${label}: protected vs unverified (#1920)`, () => {
    test("a 403 JSON from the app passes: the endpoint is protected", async () => {
      const { checks, sent } = await run(rule, { [USERS]: appForbidden }, [
        "/api/users",
      ]);
      expect(sent).toHaveLength(1);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
      expect(checks.some((c) => c.status === "pass")).toBe(true);
    });

    test("a 401 passes: the endpoint is protected", async () => {
      const { checks } = await run(rule, { [USERS]: appUnauthorized }, [
        "/api/users",
      ]);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
    });

    test("a real 404 is not exposed: a pass", async () => {
      const { checks } = await run(rule, {}, ["/api/users"]);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
    });

    test("a 403 Cloudflare challenge is not checked, and stops the run", async () => {
      const { checks, sent } = await run(
        rule,
        { [USERS]: cfChallenge, [POSTS]: appForbidden },
        ["/api/users", "/api/posts"]
      );
      expect(sent).toHaveLength(1);
      expect(checks).toEqual([
        expect.objectContaining({
          name: uncheckedName,
          status: "skipped",
          skipReason: "probe-incomplete",
          value: "not-checked",
        }),
      ]);
      expect(checks[0]!.details).toMatchObject({
        pushback: true,
        verified: 0,
        unverified: 2,
      });
    });

    test("a 429 is not checked", async () => {
      const { checks } = await run(rule, { [USERS]: throttled }, [
        "/api/users",
      ]);
      expect(checks).toEqual([
        expect.objectContaining({ name: uncheckedName, status: "skipped" }),
      ]);
      expect(checks[0]!.message).toContain("HTTP 429");
    });

    test("a 5xx is not checked", async () => {
      const { checks } = await run(rule, { [USERS]: serverError }, [
        "/api/users",
      ]);
      expect(checks).toEqual([
        expect.objectContaining({
          name: uncheckedName,
          status: "skipped",
          skipReason: "probe-incomplete",
        }),
      ]);
      expect(checks[0]!.message).toContain("server error (5xx)");
    });

    test("zero candidates is not checked, never a pass", async () => {
      const { checks, sent } = await run(rule, {}, []);
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([
        expect.objectContaining({
          name: uncheckedName,
          status: "skipped",
          skipReason: "no-endpoints",
        }),
      ]);
    });

    test("partial: findings for the verified open endpoint plus a note naming how many were not verified", async () => {
      const { checks, sent } = await run(
        rule,
        { [USERS]: () => json(USER_ROWS), [POSTS]: serverError },
        ["/api/users", "/api/posts"]
      );
      expect(sent).toHaveLength(2);
      const findings = checks.filter(
        (c) => c.status === "fail" || c.status === "warn"
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((c) => JSON.stringify(c).includes(USERS))).toBe(
        true
      );
      const note = checks.find((c) => c.name === uncheckedName)!;
      expect(note).toMatchObject({
        status: "skipped",
        value: "not-checked",
        details: { verified: 1, unverified: 1 },
      });
      expect(note.message).toContain("1 of 2");
      expect(checks.some((c) => c.status === "pass")).toBe(false);
      // No value from the response reaches the output.
      expect(JSON.stringify(checks)).not.toContain(HASH);
      expect(JSON.stringify(checks)).not.toContain("alice@example.org");
    });

    test("partial with a challenge: the open endpoint is reported, the challenged rest is not checked", async () => {
      const { checks, sent } = await run(
        rule,
        { [USERS]: () => json(USER_ROWS), [POSTS]: cfChallenge },
        ["/api/users", "/api/posts", "/api/orders"]
      );
      expect(sent).toHaveLength(2);
      expect(
        checks.some((c) => c.status === "fail" || c.status === "warn")
      ).toBe(true);
      const note = checks.find((c) => c.name === uncheckedName)!;
      expect(note.details).toMatchObject({
        verified: 1,
        unverified: 2,
        pushback: true,
      });
      expect(note.message).toContain("2 of 3");
      expect(checks.some((c) => c.status === "pass")).toBe(false);
    });
  });
}
