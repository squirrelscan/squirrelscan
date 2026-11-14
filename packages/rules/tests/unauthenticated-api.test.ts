// security/unauthenticated-api: one anonymous GET per discovered same-origin
// endpoint, records graded by their field names, never a value in the finding.
// Every test runs the rule against a stubbed fetch, so what is sent is pinned.

import { afterEach, describe, expect, test } from "bun:test";

import {
  API_RESPONSE_CAP,
  buildApiProbe,
  classifyField,
  findRecords,
  MAX_API_ENDPOINTS,
  readApiResponse,
  selectApiCandidates,
  unauthenticatedApiRule,
} from "../src/security/unauthenticated-api";
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

const USERS = `${BASE}/api/users`;
const POSTS = `${BASE}/api/posts`;

// Stand-ins for stored hashes: the test only checks they never reach a finding.
const HASH_A = "hashvalue-alpha-0001";
const HASH_B = "hashvalue-bravo-0002";

const USER_ROWS = [
  { id: 1, email: "alice@example.org", password_hash: HASH_A, role: "admin", name: "Alice" },
  { id: 2, email: "bob@example.org", password_hash: HASH_B, role: "user", name: "Bob" },
];
const POST_ROWS = [
  { id: 10, title: "Hello", slug: "hello", excerpt: "First post", published_at: "2026-01-01" },
  { id: 11, title: "Again", slug: "again", excerpt: "Second post", published_at: "2026-01-02" },
];

const get = (path: string, over: Parameters<typeof candidate>[1] = {}) =>
  candidate(path, { method: "GET", ...over });

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await unauthenticatedApiRule.run(ruleCtx(ctxOpts));
  return { checks, sent: stub.sent };
}

describe("security/unauthenticated-api: activation", () => {
  test("passive or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run(
        { [USERS]: () => json(USER_ROWS) },
        { ...opts, surface: surface([get("/api/users")]) }
      );
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([
        expect.objectContaining({ name: "unauthenticated-api-unchecked", status: "skipped", skipReason: "probing-passive" }),
      ]);
    }
  });

  test("a cross-origin endpoint is never probed, whatever it claims", async () => {
    const { checks, sent } = await run(
      { "https://api.other.com/users": () => json(USER_ROWS) },
      {
        surface: surface([
          candidate("https://api.other.com/users", { method: "GET" }),
          // Claims to be eligible, but is not the audited origin.
          candidate("https://api.other.com/v2/users", { method: "GET", sameOrigin: true, probeEligible: true }),
          candidate("http://example.com/api/users", { method: "GET", sameOrigin: true, probeEligible: true }),
        ]),
      }
    );
    expect(sent).toHaveLength(0);
    expect(checks).toEqual([expect.objectContaining({ name: "unauthenticated-api", status: "pass" })]);
  });
});

describe("security/unauthenticated-api: what is sent", () => {
  test("one GET per endpoint, no cookies, no Authorization, no redirects, no query", async () => {
    const { sent } = await run(
      { [USERS]: () => json(USER_ROWS) },
      { surface: surface([get("/api/users?token=abc&page=2#x")]) }
    );
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(USERS);
    expect(req.body).toBeNull();
    expect(req.credentials).toBe("omit");
    expect(req.redirect).toBe("manual");
    const headerNames = Object.keys(req.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("x-api-key");
  });

  test("buildApiProbe drops the query and fragment", () => {
    expect(buildApiProbe(`${BASE}/api/a?x=1#f`).url).toBe(`${BASE}/api/a`);
  });

  test("selection: methods, side-effect paths, owned paths, robots and the cap", () => {
    const many = Array.from({ length: MAX_API_ENDPOINTS + 3 }, (_, i) => get(`/api/thing${"abcdefghijklmnop"[i]}`));
    const sel = selectApiCandidates(
      ruleCtx({
        robotsTxt: robots(["/api/private"]),
        surface: surface([
          get("/api/orders"),
          candidate("/api/orders", { method: "POST" }), // GET and POST share a REST path: probed.
          candidate("/api/create-only", { method: "POST" }),
          candidate("/api/create-only", { method: undefined, discoveredVia: "string-literal" }),
          candidate("/api/items/1", { method: "DELETE" }),
          get("/api/logout"),
          get("/api/auth/callback"),
          get("/api/verify-email"),
          get("/api/webhooks/stripe"),
          get("/graphql"),
          get("/_next/data/build/index.json"),
          get("/api/health"),
          get("/openapi.json"),
          get("/api/private/users"),
          ...many,
        ]),
      })
    );
    expect(sel.candidates[0]!.url).toBe(`${BASE}/api/orders`);
    expect(sel.candidates).toHaveLength(MAX_API_ENDPOINTS);
    expect(sel.candidates.some((c) => c.url.includes("create-only") || c.url.includes("/items/"))).toBe(false);
    expect(sel.skippedMethod).toBe(2);
    expect(sel.skippedSideEffect).toBe(4);
    expect(sel.skippedOwned).toBe(4);
    expect(sel.skippedRobots).toBe(1);
    expect(sel.skippedCap).toBe(4);
  });

  test("aggressive probes a robots-disallowed path; call sites come before literals", () => {
    const sel = selectApiCandidates(
      ruleCtx({
        level: "aggressive",
        robotsTxt: robots(["/api/private"]),
        surface: surface([
          candidate("/api/literal", { method: undefined, discoveredVia: "string-literal" }),
          get("/api/private/users"),
        ]),
      })
    );
    expect(sel.candidates.map((c) => c.url)).toEqual([`${BASE}/api/private/users`, `${BASE}/api/literal`]);
  });
});

describe("security/unauthenticated-api: findings", () => {
  test("user records with PII and internal fields fail, naming the endpoint, with no values", async () => {
    const { checks } = await run(
      { [USERS]: () => json({ data: USER_ROWS, total: 2 }) },
      { surface: surface([get("/api/users")]) }
    );
    const fail = checks.find((c) => c.name === "unauthenticated-api-sensitive")!;
    expect(fail.status).toBe("fail");
    expect(fail.details).toMatchObject({ severity: "high", endpoints: 1 });
    expect(fail.message).toContain(USERS);
    expect(fail.message).toContain("password_hash");
    const item = fail.items![0]!;
    expect(item.id).toBe(USERS);
    expect(item.label).toContain("2 records");
    expect(item.meta).toMatchObject({
      method: "GET",
      status: 200,
      records: 2,
      at: "$.data",
      credential: ["password_hash"],
      personal: ["email"],
      internal: ["role"],
      sample: "{id: number, email: string, password_hash: string, role: string, name: string}",
    });
    // Nothing the endpoint returned as a VALUE reaches the finding.
    const text = JSON.stringify(checks);
    for (const value of ["alice@example.org", "bob@example.org", HASH_A, HASH_B, "Alice", "admin\""]) {
      expect(text).not.toContain(value);
    }
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("plainly public content is info, not a failure", async () => {
    const { checks } = await run({ [POSTS]: () => json(POST_ROWS) }, { surface: surface([get("/api/posts")]) });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "unauthenticated-api-public", status: "info", details: { severity: "low" } });
    expect(checks[0]!.items![0]!.id).toBe(POSTS);
  });

  test("public content with an author email nested inside is sensitive", async () => {
    const rows = POST_ROWS.map((p) => ({ ...p, author: { name: "A", email: "a@example.org" } }));
    const { checks } = await run({ [POSTS]: () => json(rows) }, { surface: surface([get("/api/posts")]) });
    const fail = checks.find((c) => c.status === "fail")!;
    expect(fail.items![0]!.meta).toMatchObject({ personal: ["author.email"] });
  });

  test("records with no telling fields warn; user-identity fields warn", async () => {
    const { checks } = await run(
      {
        [`${BASE}/api/orders`]: () => json({ results: [{ id: 1, total: 99, sku_count: 3 }] }),
        [`${BASE}/api/members/7`]: () => json({ id: 7, username: "x", plan_level: 2 }),
      },
      { surface: surface([get("/api/orders"), get("/api/members/7")]) }
    );
    const warn = checks.find((c) => c.name === "unauthenticated-api-data")!;
    expect(warn.status).toBe("warn");
    expect(warn.details).toMatchObject({ severity: "medium", endpoints: 2 });
    expect(warn.items!.map((i) => i.id)).toEqual([`${BASE}/api/orders`, `${BASE}/api/members/7`]);
    expect(warn.items![1]!.meta).toMatchObject({ records: 1, user: ["username"] });
  });

  test("the WordPress users endpoint enumerates accounts: warn, not public", async () => {
    const wpUsers = `${BASE}/wp-json/wp/v2/users`;
    const rows = [
      { id: 1, name: "Site Admin", url: "", description: "", link: `${BASE}/author/admin/`, slug: "admin", avatar_urls: { "24": "https://secure.gravatar.com/avatar/x?s=24" } },
    ];
    const { checks } = await run({ [wpUsers]: () => json(rows) }, { surface: surface([get("/wp-json/wp/v2/users")]) });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "unauthenticated-api-data", status: "warn" });
    expect(checks[0]!.items![0]!.meta).toMatchObject({ user: ["avatar_urls"], unreportableFields: 1 });
    expect(JSON.stringify(checks)).not.toContain("gravatar");
  });

  test("auth refusals, redirects, HTML, health and error bodies are not flagged", async () => {
    const paths = ["/api/a", "/api/b", "/api/c", "/api/d", "/api/e", "/api/f", "/api/g"];
    const { checks, sent } = await run(
      {
        [`${BASE}/api/a`]: () => json(USER_ROWS, 401),
        [`${BASE}/api/b`]: () => json(USER_ROWS, 403),
        [`${BASE}/api/c`]: () => new Response(null, { status: 302, headers: { location: "/login" } }),
        [`${BASE}/api/d`]: () => html("<!doctype html><p>[{}]</p>", 200),
        [`${BASE}/api/e`]: () => json({ status: "ok", uptime: 123, version: "1.0" }),
        [`${BASE}/api/f`]: () => json({ error: "unauthorized", message: "Sign in", code: 401 }),
        [`${BASE}/api/g`]: () => json([1, 2, 3]),
      },
      { surface: surface(paths.map((p) => get(p))) }
    );
    expect(sent).toHaveLength(paths.length);
    expect(checks).toEqual([
      expect.objectContaining({ name: "unauthenticated-api", status: "pass", details: expect.objectContaining({ probed: 7 }) }),
    ]);
  });

  test("a map keyed by email or id does not leak its keys", () => {
    const verdict = readApiResponse({
      status: 200,
      contentType: "application/json",
      truncated: false,
      body: JSON.stringify([{ id: 1, "alice@example.org": true, "12345678": 1, d41d8cd98f00b204: 2, email: "x@y.z" }]),
    });
    expect(verdict.kind).toBe("records");
    if (verdict.kind !== "records") return;
    expect(verdict.summary.fields).toEqual(["id", "email"]);
    expect(verdict.summary.unreportable).toBe(3);
    expect(JSON.stringify(verdict)).not.toContain("alice@example.org");
  });

  test("an answer over the read cap is read from its prefix, with lower confidence", async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => ({ id: i, email: `u${i}@example.org`, padding: "x".repeat(40) }));
    const body = JSON.stringify(rows);
    expect(body.length).toBeGreaterThan(API_RESPONSE_CAP);
    const { checks } = await run({ [USERS]: () => json(rows) }, { surface: surface([get("/api/users")]) });
    const fail = checks.find((c) => c.status === "fail")!;
    expect(fail.items![0]!.meta).toMatchObject({ truncated: true, confidence: "lower", records: null, personal: ["email"] });
    expect(fail.items![0]!.label).toContain("larger than 256 KB");
  });

  test("a budget that runs out partway is skipped, not a pass; findings on reached endpoints stay", async () => {
    let t = 0;
    const { checks, sent } = await run(
      {
        [USERS]: () => {
          t += 10_000;
          return json(USER_ROWS);
        },
      },
      { budgetMs: 5_000, now: () => t, surface: surface([get("/api/users"), get("/api/other")]) }
    );
    expect(sent).toHaveLength(1);
    expect(checks.map((c) => `${c.name}/${c.status}`)).toEqual([
      "unauthenticated-api-sensitive/fail",
      "unauthenticated-api-unchecked/skipped",
    ]);
    expect(checks[1]!.skipReason).toBe("probe-budget");
  });

  test("every probe erroring is skipped, not a pass", async () => {
    const { checks } = await run(
      {
        [USERS]: () => {
          throw new TypeError("network down");
        },
      },
      { surface: surface([get("/api/users")]) }
    );
    expect(checks).toEqual([expect.objectContaining({ status: "skipped", skipReason: "probe-errors" })]);
  });
});

describe("security/unauthenticated-api: classification", () => {
  test("field classes", () => {
    expect(classifyField("password_hash")).toBe("credential");
    expect(classifyField("apiKey")).toBe("credential");
    expect(classifyField("refresh_token")).toBe("credential");
    expect(classifyField("nextPageToken")).toBeNull();
    expect(classifyField("contactEmail")).toBe("personal");
    expect(classifyField("phone_number")).toBe("personal");
    expect(classifyField("is_admin")).toBe("internal");
    expect(classifyField("internal_notes")).toBe("internal");
    expect(classifyField("username")).toBe("user");
    expect(classifyField("slug")).toBe("public");
    expect(classifyField("widgetCount")).toBeNull();
  });

  test("record shapes", () => {
    expect(findRecords([{ a: 1 }])?.at).toBe("$");
    expect(findRecords({ data: { items: [{ a: 1 }] } })?.at).toBe("$.data.items");
    expect(findRecords({ users: [{ a: 1 }, { a: 2 }], total: 2 })).toMatchObject({ at: "$.users", count: 2 });
    expect(findRecords({ data: { id: "u1", type: "user", attributes: { email: "x" } } })?.at).toBe("$.data");
    expect(findRecords({ id: 1, name: "x" })).toBeNull(); // too few fields for one record
    expect(findRecords({ status: "ok", code: 200, message: "fine" })).toBeNull();
    expect(findRecords([])).toBeNull();
    expect(findRecords(["a", "b", { a: 1 }])).toBeNull();
  });
});
