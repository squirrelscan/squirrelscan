// security/auth-endpoint-disclosure (repo#1968): GET-only, credential-free probes
// of same-origin current-user and session endpoints, flagging a JSON answer
// that carries a password, a password hash, a credential secret or the
// internal user row. Every test runs the rule fresh against a stubbed fetch,
// so it asserts exactly what was sent.

// oxlint-disable sonarjs/no-hardcoded-passwords -- the fixtures are fake leaked credentials, which is what the rule detects

import { afterEach, describe, expect, test } from "bun:test";

import {
  AUTH_CONVENTION_PATHS,
  authEndpointDisclosureRule,
  findDisclosures,
  isAuthEndpointPath,
  isCredentialPath,
  looksLikePasswordHash,
  MAX_AUTH_ENDPOINTS,
} from "../src/security/auth-endpoint-disclosure";
import type { CheckResult } from "../src/types";
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
  type SentRequest,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const ME = `${BASE}/api/me`;
const BCRYPT = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW"; // pragma: allowlist secret
const DJANGO = "pbkdf2_sha256$600000$q5Zm8uYgHk2x$3Yk1kq9q2uJqGqvJ1o0ZmZbZ4dK8s3n0q1w2e3r4t5y="; // pragma: allowlist secret
const ARGON2 = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG"; // pragma: allowlist secret
const RESET_TOKEN = "f3a1c9d2e8b7a6c5d4e3f2a1b0c9d8e7"; // pragma: allowlist secret

/** A Devise user row serialized whole. */
const DEVISE_ROW = {
  user: {
    id: 42,
    email: "jo@example.com",
    encrypted_password: BCRYPT,
    reset_password_token: RESET_TOKEN,
    reset_password_sent_at: "2026-10-01T00:00:00Z",
    sign_in_count: 17,
    current_sign_in_ip: "203.0.113.9",
    last_sign_in_ip: "203.0.113.8",
  },
};

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await authEndpointDisclosureRule.run(ruleCtx(ctxOpts));
  return { checks, sent: stub.sent };
}

const paths = (sent: SentRequest[]) => sent.map((r) => new URL(r.url).pathname);

describe("security/auth-endpoint-disclosure: activation", () => {
  test("passive or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run({ [ME]: () => json(DEVISE_ROW) }, opts);
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([
        expect.objectContaining({
          name: "auth-endpoint-not-checked",
          status: "skipped",
          skipReason: "probing-passive",
        }),
      ]);
    }
  });

  test("active: one credential-free GET per conventional path, nothing else", async () => {
    const { checks, sent } = await run({});
    expect(paths(sent)).toEqual([...AUTH_CONVENTION_PATHS]);
    for (const r of sent) {
      expect(r.method).toBe("GET");
      expect(r.body).toBeNull();
      expect(new URL(r.url).search).toBe("");
      expect(r.credentials).toBe("omit");
      expect(r.redirect).toBe("manual");
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
    expect(checks).toEqual([expect.objectContaining({ name: "auth-endpoint-clean", status: "pass" })]);
  });
});

describe("security/auth-endpoint-disclosure: findings", () => {
  test("a serialized Devise row is a fail naming each field, never its value", async () => {
    const { checks } = await run({ [ME]: () => json(DEVISE_ROW) });
    expect(authEndpointDisclosureRule.meta.severity).toBe("error");
    const fails = checks.filter((c) => c.status === "fail");
    expect(fails).toHaveLength(1);
    const fail = fails[0]!;
    expect(fail.name).toBe("auth-endpoint-disclosure");
    expect(fail.message).toContain(ME);
    expect(fail.message).toContain("1 password hash (user.encrypted_password)");
    expect(fail.message).toContain("1 credential secret (user.reset_password_token)");
    const byField = Object.fromEntries((fail.items ?? []).map((i) => [i.meta?.field, i.meta?.kind]));
    expect(byField).toEqual({
      "user.encrypted_password": "password-hash",
      "user.reset_password_token": "secret",
      "user.reset_password_sent_at": "internal-record",
      "user.sign_in_count": "internal-record",
      "user.current_sign_in_ip": "internal-record",
      "user.last_sign_in_ip": "internal-record",
    });
    expect(fail.details).toMatchObject({ endpoint: ME, kinds: ["password-hash", "secret", "internal-record"] });
    const text = JSON.stringify(checks);
    expect(text).not.toContain(BCRYPT);
    expect(text).not.toContain(RESET_TOKEN);
    expect(text).not.toContain("203.0.113");
    // No clean check next to a finding.
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("a hash is found by its format under any key, and a plaintext password by its key", async () => {
    const { checks } = await run({
      [`${BASE}/api/session`]: () => json({ account: { hash: ARGON2, pwd: "hunter2" } }),
      [`${BASE}/api/user`]: () => json([{ id: 1, password: DJANGO }]),
    });
    const fails = checks.filter((c) => c.status === "fail");
    expect(fails.map((c) => c.details?.endpoint)).toEqual([`${BASE}/api/session`, `${BASE}/api/user`]);
    expect(fails[0]!.items?.map((i) => [i.meta?.field, i.meta?.kind])).toEqual([
      ["account.hash", "password-hash"],
      ["account.pwd", "password"],
    ]);
    expect(fails[1]!.items?.map((i) => [i.meta?.field, i.meta?.kind])).toEqual([["[0].password", "password-hash"]]);
    expect(JSON.stringify(checks)).not.toContain("hunter2");
  });

  test("normal session answers pass", async () => {
    for (const body of [
      {},
      { user: null },
      { user: { id: 1, name: "Jo", email: "jo@example.com", image: null }, expires: "2026-12-01" },
      { user: { id: 1, password: null, hasPassword: true, password_hash: "" } },
      { user: { id: 1, password: "********", passwordSet: true } },
      { csrfToken: "abc123", accessToken: null },
      // One internal column alone is not the whole row.
      { user: { id: 1, last_sign_in_ip: "203.0.113.1" } },
    ]) {
      const { checks } = await run({ [ME]: () => json(body) });
      expect(checks.filter((c) => c.status === "fail")).toEqual([]);
      expect(checks).toEqual([expect.objectContaining({ status: "pass", name: "auth-endpoint-clean" })]);
      expect(checks[0]!.message).toContain("1 answered with JSON");
      restore?.();
      restore = undefined;
    }
  });

  test("non-2xx, HTML, redirects and truncated answers are not flagged", async () => {
    const big = { user: { encrypted_password: BCRYPT, padding: "x".repeat(300 * 1024) } };
    const { checks, sent } = await run({
      [ME]: () => json(DEVISE_ROW, 401),
      [`${BASE}/api/session`]: () => html(`<pre>${JSON.stringify(DEVISE_ROW)}</pre>`, 200),
      [`${BASE}/api/auth/session`]: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/api/me" } }),
      [`${BASE}/api/user`]: () => json(big),
    });
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    // The redirect is not followed: one request per endpoint, all same origin.
    expect(sent).toHaveLength(4);
    expect(sent.every((r) => new URL(r.url).origin === BASE)).toBe(true);
  });
});

describe("security/auth-endpoint-disclosure: what may be probed", () => {
  test("only same-origin, GET-able, non-credential auth endpoints are probed", async () => {
    const { sent } = await run(
      {},
      {
        surface: surface([
          candidate("/api/v2/me", { method: "GET" }),
          candidate("https://api.other.example/api/me", { method: "GET" }),
          candidate("http://example.com/api/v3/me", { method: "GET" }),
          candidate("/api/v4/session", { method: "POST" }),
          candidate("/api/v5/user", { method: "PUT" }),
          candidate("/api/logout/me", { method: "GET" }),
          candidate("/api/auth/callback/session", { method: "GET" }),
          candidate("/api/login/user", { method: "GET" }),
          candidate("/api/password/session", { method: "GET" }),
          candidate("/api/products", { method: "GET" }),
          candidate("/api/v6/whoami", { method: undefined, discoveredVia: "axios.request" }),
        ]),
      }
    );
    expect(paths(sent)).toEqual(["/api/v2/me", "/api/v6/whoami", ...AUTH_CONVENTION_PATHS]);
  });

  test("the origin is re-checked: a candidate that claims to be same-origin is not trusted", async () => {
    const { sent } = await run(
      {},
      {
        surface: surface([
          candidate("https://api.other.example/api/me", { method: "GET", sameOrigin: true, probeEligible: true }),
          candidate("http://example.com/api/v2/me", { method: "GET", sameOrigin: true, probeEligible: true }),
          candidate("https://example.com:8443/api/v3/me", { method: "GET", sameOrigin: true, probeEligible: true }),
        ]),
      }
    );
    expect(sent.every((r) => new URL(r.url).origin === BASE)).toBe(true);
    expect(paths(sent)).toEqual([...AUTH_CONVENTION_PATHS]);
  });

  test("a bare /me is probed from a call site, not from a string literal", async () => {
    const callSite = await run({}, { surface: surface([candidate("/me", { method: "GET" })]) });
    expect(paths(callSite.sent)).toContain("/me");
    restore?.();
    restore = undefined;
    const literal = await run(
      {},
      {
        surface: surface([candidate("/me", { method: undefined, discoveredVia: "string-literal", source: "static-html" })]),
      }
    );
    expect(paths(literal.sent)).not.toContain("/me");
  });

  test("robots.txt is respected below aggressive", async () => {
    const active = await run({}, { robotsTxt: robots(["/api/"]) });
    expect(active.sent).toHaveLength(0);
    // Nothing probed is not a clean result (#1920, squirrelscan#1886 release gate).
    expect(active.checks[0]).toMatchObject({
      status: "skipped",
      skipReason: "no-endpoints",
      details: { skippedRobots: 4 },
    });
    restore?.();
    restore = undefined;
    const aggressive = await run({}, { level: "aggressive", robotsTxt: robots(["/api/"]) });
    expect(paths(aggressive.sent)).toEqual([...AUTH_CONVENTION_PATHS]);
  });

  test(`at most ${MAX_AUTH_ENDPOINTS} endpoints are probed`, async () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate(`/api/v${i + 10}/me`, { method: "GET" }));
    const { sent, checks } = await run({}, { surface: surface(many) });
    expect(sent).toHaveLength(MAX_AUTH_ENDPOINTS);
    expect(checks[0]!.details).toMatchObject({ skippedCap: 10 + AUTH_CONVENTION_PATHS.length - MAX_AUTH_ENDPOINTS });
  });
});

describe("security/auth-endpoint-disclosure: incomplete runs", () => {
  test("an exhausted budget is skipped, never a pass", async () => {
    let t = 0;
    const now = () => t;
    const stub = stubFetch({
      [ME]: () => {
        t += 10_000;
        return json({});
      },
    });
    restore = stub.restore;
    const { checks } = await authEndpointDisclosureRule.run(ruleCtx({ budgetMs: 5_000, now }));
    expect(stub.sent).toHaveLength(1);
    expect(checks).toEqual([
      expect.objectContaining({ name: "auth-endpoint-not-checked", status: "skipped", skipReason: "probe-budget" }),
    ]);
  });

  test("every probe failing is skipped as probe-errors", async () => {
    const { checks } = await run(
      Object.fromEntries(
        AUTH_CONVENTION_PATHS.map((p) => [
          `${BASE}${p}`,
          () => {
            throw new TypeError("network down");
          },
        ])
      )
    );
    expect(checks).toEqual([expect.objectContaining({ status: "skipped", skipReason: "probe-errors" })]);
  });
});

describe("security/auth-endpoint-disclosure: helpers", () => {
  test("hash formats", () => {
    for (const h of [BCRYPT, ARGON2, DJANGO, "$6$rounds=5000$saltsalt$" + "a".repeat(86)]) {
      expect(looksLikePasswordHash(h)).toBe(true);
    }
    for (const s of ["hunter2", "$2b$12$short", "pbkdf2_sha256$x", "a".repeat(64)]) {
      expect(looksLikePasswordHash(s)).toBe(false);
    }
  });

  test("path classification", () => {
    expect(isAuthEndpointPath("/api/me", false)).toBe(true);
    expect(isAuthEndpointPath("/api/current-user", false)).toBe(true);
    expect(isAuthEndpointPath("/auth/v1/user", false)).toBe(true);
    expect(isAuthEndpointPath("/me", false)).toBe(false);
    expect(isAuthEndpointPath("/me", true)).toBe(true);
    expect(isAuthEndpointPath("/api/users", false)).toBe(false);
    expect(isCredentialPath("/api/auth/signIn/session")).toBe(true);
    expect(isCredentialPath("/api/sign-up/me")).toBe(true);
    expect(isCredentialPath("/api/me")).toBe(false);
  });

  test("findDisclosures is bounded in depth and names nested array paths", () => {
    expect(findDisclosures({ data: { users: [{}, { password_digest: BCRYPT }] } })).toEqual([
      { path: "data.users[1].password_digest", kind: "password-hash" },
    ]);
    let deep: unknown = { password: "plain" };
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(findDisclosures(deep)).toEqual([]);
  });

  test("a map keyed by email, id or token never puts the key in a path", () => {
    const token = "sess_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const found = findDisclosures({
      users: {
        "alice@example.com": { password_digest: BCRYPT },
        "12345": { password: "plain" },
      },
      sessions: { [token]: { encrypted_password: BCRYPT } },
    });
    expect(found).toEqual([
      { path: "users.*.password", kind: "password" },
      { path: "users.*.password_digest", kind: "password-hash" },
      { path: "sessions.*.encrypted_password", kind: "password-hash" },
    ]);
    const paths = JSON.stringify(found);
    expect(paths).not.toContain("alice");
    expect(paths).not.toContain("12345");
    expect(paths).not.toContain(token);
  });
});
