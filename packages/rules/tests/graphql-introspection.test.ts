// security/graphql-introspection: GET first, a single POST only as an
// aggressive fallback, flags a full schema over either method, and never flags
// disabled introspection, errors or non-GraphQL answers. Every test runs the
// rule fresh against a stubbed fetch, so no result is replayed from a cache.

import { afterEach, describe, expect, test } from "bun:test";

import { graphqlIntrospectionRule, readSchema } from "../src/security/graphql-introspection";
import { INTROSPECTION_QUERY } from "../src/security/graphql-probe";
import type { CheckResult } from "../src/types";
import {
  BASE,
  candidate,
  html,
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

const GQL = `${BASE}/graphql`;

const SCHEMA = {
  data: {
    __schema: {
      types: [
        { name: "Query" },
        { name: "Mutation" },
        { name: "User" },
        { name: "Order" },
        { name: "String" },
        { name: "Boolean" },
        { name: "__Schema" },
        { name: "__Type" },
      ],
    },
  },
};

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await graphqlIntrospectionRule.run(ruleCtx(ctxOpts));
  return { checks, sent: stub.sent };
}

function introspectionGet(r: SentRequest): boolean {
  return r.method === "GET" && new URL(r.url).searchParams.get("query") === INTROSPECTION_QUERY;
}

describe("security/graphql-introspection", () => {
  test("passive or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run({ [GQL]: () => json(SCHEMA) }, opts);
      expect(sent).toHaveLength(0);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probing-passive" });
    }
  });

  test("a full schema over GET is flagged with the endpoint and type count", async () => {
    const { checks, sent } = await run({ [GQL]: () => json(SCHEMA) });
    const warn = checks.filter((c) => c.status === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.message).toContain(GQL);
    expect(warn[0]!.message).toContain("8 types, 4 of them defined by the API");
    expect(warn[0]!.items?.[0]).toMatchObject({ id: GQL, meta: { method: "GET", types: 8, apiTypes: 4 } });
    // One GET per endpoint (the two conventional paths), and nothing else.
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /graphql",
      "GET /api/graphql",
    ]);
    expect(sent.every(introspectionGet)).toBe(true);
    expect(sent.every((r) => r.body === null && r.credentials === "omit" && r.redirect === "manual")).toBe(true);
  });

  test("a discovered endpoint is probed and named", async () => {
    const { checks, sent } = await run(
      { [`${BASE}/v1/graphql`]: () => json(SCHEMA, 200, "application/graphql-response+json") },
      { surface: surface([candidate("/v1/graphql")]) }
    );
    expect(checks.find((c) => c.status === "warn")?.message).toContain(`${BASE}/v1/graphql`);
    expect(sent[0]!.url.startsWith(`${BASE}/v1/graphql?query=`)).toBe(true);
  });

  test("active: a GraphQL error without a schema sends no POST and is not flagged", async () => {
    const csrf = () =>
      json({ errors: [{ message: "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF)." }] }, 400);
    const { checks, sent } = await run({ [GQL]: csrf });
    expect(sent.some((r) => r.method === "POST")).toBe(false);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "pass" });
    expect(checks[0]!.message).toContain("1 answered as GraphQL");
  });

  test("aggressive: one POST of the introspection query after a GraphQL-shaped GET without a schema", async () => {
    const route: Route = (req) =>
      req.method === "POST"
        ? json(SCHEMA)
        : json({ errors: [{ message: "GET requests are not supported for this operation" }] }, 405);
    const { checks, sent } = await run({ [GQL]: route }, { level: "aggressive" });
    const posts = sent.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(GQL);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ query: INTROSPECTION_QUERY });
    expect(posts[0]!.headers["content-type"]).toBe("application/json");
    const warn = checks.find((c) => c.status === "warn");
    expect(warn?.message).toContain("answered over POST");
    expect(warn?.items?.[0]?.meta?.method).toBe("POST");
  });

  test("aggressive: no POST when the GET is not GraphQL-shaped", async () => {
    for (const route of [
      () => html(),
      () => html("<!doctype html><div id=app></div>", 200),
      () => json({ status: 404, error: "Not Found" }, 404),
      () => json({ errors: [{ status: "404", title: "Not Found" }] }, 404),
      () => new Response(null, { status: 302, headers: { location: "https://login.example.com/" } }),
    ]) {
      const { checks, sent } = await run({ [GQL]: route }, { level: "aggressive" });
      expect(sent.filter((r) => r.method === "POST")).toHaveLength(0);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
      restore?.();
    }
  });

  test("aggressive: no POST when the GET says introspection is disabled", async () => {
    const { checks, sent } = await run(
      {
        [GQL]: () =>
          json({ errors: [{ message: "GraphQL introspection is not allowed, but the query contained __schema or __type." }] }, 400),
      },
      { level: "aggressive" }
    );
    expect(sent.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(checks).toEqual([expect.objectContaining({ status: "pass" })]);
  });

  test("aggressive: a POST that also fails is not flagged", async () => {
    const route: Route = () => json({ errors: [{ message: "Must provide query string." }] }, 400);
    const { checks, sent } = await run({ [GQL]: route }, { level: "aggressive" });
    expect(sent.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("errors, empty schemas and non-2xx schemas are not flagged", async () => {
    for (const route of [
      () => {
        throw new TypeError("connection reset");
      },
      () => json({ data: { __schema: { types: [] } } }),
      () => json({ data: { __schema: null } }),
      () => json({ data: { __schema: { types: [{ kind: "OBJECT" }] } } }),
      () => json(SCHEMA, 500),
      () => html(JSON.stringify(SCHEMA), 200),
    ]) {
      const { checks } = await run({ [GQL]: route });
      expect(checks.every((c) => c.status === "pass")).toBe(true);
      restore?.();
    }
  });

  test("a schema answer over the 1 MB cap is still flagged, with lower-bound counts", async () => {
    const types = Array.from({ length: 60_000 }, (_, i) => ({ name: `Type${i}` }));
    types.push({ name: "__Schema" }, { name: "String" });
    const big = () => json({ data: { __schema: { types } } });
    const { checks } = await run({ [GQL]: big });
    const warn = checks.find((c) => c.status === "warn");
    expect(warn?.message).toContain(GQL);
    expect(warn?.message).toContain("at least");
    expect(warn?.message).toContain("first 1 MB");
    expect(warn?.items?.[0]?.meta?.truncated).toBe(true);
    expect(Number(warn?.items?.[0]?.meta?.types)).toBeGreaterThan(10_000);
  });

  test("a large answer that does not open as a schema is not flagged", async () => {
    const pad = "x".repeat(1100 * 1024);
    for (const route of [
      () => json({ items: [{ name: "a" }], pad }),
      () => json({ data: { search: [{ name: "a" }] }, pad }),
      () => html(`{"data":{"__schema":{"types":[{"name":"Query"}]}}${pad}`, 200),
    ]) {
      const { checks } = await run({ [GQL]: route });
      expect(checks.every((c) => c.status === "pass")).toBe(true);
      restore?.();
    }
  });

  test("when every probe fails with a network error the rule skips, it does not pass", async () => {
    const fail = () => {
      throw new TypeError("connection reset");
    };
    const { checks } = await run({ [GQL]: fail, [`${BASE}/api/graphql`]: fail });
    expect(checks).toEqual([
      expect.objectContaining({ status: "skipped", skipReason: "probe-errors" }),
    ]);
  });

  test("state-changing and cross-origin candidates are never requested", async () => {
    const { sent } = await run(
      {},
      {
        level: "aggressive",
        surface: surface([
          candidate("/graphql/logout"),
          candidate("/api/deleteAccount/graphql"),
          candidate("/gql", { method: "DELETE" }),
          candidate("https://api.vendor.com/graphql"),
          candidate("https://other.example.org/graphql", { sameOrigin: true, probeEligible: true }),
        ]),
      }
    );
    const paths = sent.map((r) => new URL(r.url));
    expect(paths.every((u) => u.origin === BASE)).toBe(true);
    expect(paths.map((u) => u.pathname)).toEqual(["/graphql", "/api/graphql"]);
  });

  test("a spent budget skips the rule without sending", async () => {
    let t = 0;
    const stub = stubFetch({});
    restore = stub.restore;
    const ctx = ruleCtx({ budgetMs: 5, now: () => t });
    // Spend the budget before the rule runs.
    ctx.probe!.allows("quiet");
    t = 100;
    const { checks } = await graphqlIntrospectionRule.run(ctx);
    expect(stub.sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
  });

  test("each run probes live: a later run sees the server's new answer", async () => {
    const first = await run({ [GQL]: () => json(SCHEMA) });
    expect(first.checks.some((c) => c.status === "warn")).toBe(true);
    restore?.();
    const second = await run({ [GQL]: () => json({ errors: [{ message: "introspection disabled" }] }, 400) });
    expect(second.checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("readSchema needs named types", () => {
    expect(readSchema({ data: SCHEMA.data, errors: [] })).toEqual({ types: 8, apiTypes: 4 });
    expect(readSchema({ data: { __schema: { types: "x" } }, errors: [] })).toBeNull();
    expect(readSchema(null)).toBeNull();
  });
});
