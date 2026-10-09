// Shared GraphQL probing helper (security/graphql-introspection and
// security/graphql-get-mutations): candidate selection, the only requests that
// can be sent, the probe budget gate, the response size cap and the strict
// GraphQL response shape.

import { afterEach, describe, expect, test } from "bun:test";

import { createProbeBudget } from "../src/probe-budget";
import {
  buildGraphqlProbe,
  GRAPHQL_RESPONSE_CAPS,
  INTROSPECTION_QUERY,
  isGraphqlPath,
  isStateChangingPath,
  MAX_GRAPHQL_ENDPOINTS,
  NOOP_MUTATION,
  parseGraphqlBody,
  selectGraphqlCandidates,
  sendGraphqlProbe,
  truncatedSchemaTypeNames,
  type GraphqlProbeResponse,
} from "../src/security/graphql-probe";
import {
  BASE,
  candidate,
  json,
  robots,
  ruleCtx,
  stubFetch,
  surface,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function urls(ctx: Parameters<typeof selectGraphqlCandidates>[0]): string[] {
  return selectGraphqlCandidates(ctx).candidates.map((c) => c.url);
}

describe("isGraphqlPath / isStateChangingPath", () => {
  test("a graphql or gql path segment is GraphQL, a substring is not", () => {
    for (const p of ["/graphql", "/api/graphql", "/v1/graphql", "/graphql/v2", "/gql", "/GraphQL"]) {
      expect(isGraphqlPath(p)).toBe(true);
    }
    for (const p of ["/", "/api/users", "/graphqlish", "/my-graphql-guide", "/blog/gql-tips"]) {
      expect(isGraphqlPath(p)).toBe(false);
    }
  });

  test("paths that name a state-changing action are flagged by whole word", () => {
    for (const p of [
      "/graphql/logout",
      "/log-out/graphql",
      "/signOut/gql",
      "/api/deleteUser/graphql",
      "/graphql/update",
      "/graphql/reset-password",
      "/api/unsubscribe/graphql",
      "/graphql/mutation",
      "/graphql%2Fdelete",
    ]) {
      expect(isStateChangingPath(p)).toBe(true);
    }
    for (const p of [
      "/graphql",
      "/api/graphql",
      "/v1/graphql",
      "/graphql/subscriptions",
      "/settings/graphql",
      "/updates-feed/graphql",
    ]) {
      expect(isStateChangingPath(p)).toBe(false);
    }
  });
});

describe("selectGraphqlCandidates", () => {
  test("conventional paths are used when the discovery pass found nothing", () => {
    expect(urls(ruleCtx({}))).toEqual([`${BASE}/graphql`, `${BASE}/api/graphql`]);
  });

  test("discovered GraphQL endpoints come first, deduped on origin plus path, query dropped", () => {
    const ctx = ruleCtx({
      surface: surface([
        candidate("/v1/graphql?op=Feed"),
        candidate("/v1/graphql", { method: "GET", discoveredVia: "string-literal" }),
        candidate("/graphql", { source: "convention", discoveredVia: "convention:express", method: "GET" }),
        candidate("/api/users"),
      ]),
    });
    const sel = selectGraphqlCandidates(ctx);
    expect(sel.candidates).toEqual([
      { url: `${BASE}/v1/graphql`, source: "discovered", discoveredVia: "fetch" },
      { url: `${BASE}/graphql`, source: "convention", discoveredVia: "convention:express" },
      { url: `${BASE}/api/graphql`, source: "convention", discoveredVia: "convention" },
    ]);
  });

  test("state-changing call sites are never probed, by path or by method", () => {
    const ctx = ruleCtx({
      surface: surface([
        candidate("/graphql/logout", { discoveredVia: "fetch" }),
        candidate("/api/delete-account/graphql", { discoveredVia: "xhr.open" }),
        candidate("/admin/gql", { method: "DELETE" }),
        candidate("/v2/graphql", { method: "PUT" }),
      ]),
    });
    const sel = selectGraphqlCandidates(ctx);
    expect(sel.candidates.map((c) => c.url)).toEqual([`${BASE}/graphql`, `${BASE}/api/graphql`]);
    expect(sel.skippedStateChanging).toBe(4);
  });

  test("probeEligible is not trusted: a cross-origin URL is dropped even when marked eligible", () => {
    const ctx = ruleCtx({
      surface: surface([
        candidate("https://api.vendor.com/graphql"),
        candidate("https://evil.example.net/graphql", { sameOrigin: true, probeEligible: true }),
        candidate("http://example.com/graphql", { sameOrigin: true, probeEligible: true }),
        candidate("https://example.com:8443/graphql", { sameOrigin: true, probeEligible: true }),
        candidate("https://user:pw@example.com/gql", { sameOrigin: true, probeEligible: true }), // pragma: allowlist secret
      ]),
    });
    expect(urls(ctx)).toEqual([`${BASE}/graphql`, `${BASE}/api/graphql`]);
  });

  test("robots.txt disallowed paths are skipped below aggressive and kept at aggressive", () => {
    const robotsTxt = robots(["/api/"]);
    const active = selectGraphqlCandidates(ruleCtx({ robotsTxt }));
    expect(active.candidates.map((c) => c.url)).toEqual([`${BASE}/graphql`]);
    expect(active.skippedRobots).toBe(1);
    expect(urls(ruleCtx({ robotsTxt, level: "aggressive" }))).toEqual([
      `${BASE}/graphql`,
      `${BASE}/api/graphql`,
    ]);
  });

  test(`at most ${MAX_GRAPHQL_ENDPOINTS} endpoints are selected`, () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate(`/s${i}/graphql`));
    const sel = selectGraphqlCandidates(ruleCtx({ surface: surface(many) }));
    expect(sel.candidates).toHaveLength(MAX_GRAPHQL_ENDPOINTS);
    expect(sel.skippedCap).toBe(10 + 2 - MAX_GRAPHQL_ENDPOINTS);
  });

  test("no base URL selects nothing", () => {
    const ctx = ruleCtx({});
    ctx.site = undefined;
    expect(urls(ctx)).toEqual([]);
  });
});

describe("buildGraphqlProbe: the only requests that can be sent", () => {
  test("introspection over GET carries the query in the URL and nothing else", () => {
    const { url, init } = buildGraphqlProbe(`${BASE}/graphql?x=1#frag`, {
      op: "introspection",
      method: "GET",
    });
    expect(url).toBe(`${BASE}/graphql?query=${encodeURIComponent(INTROSPECTION_QUERY)}`);
    expect(new URL(url).searchParams.get("query")).toBe("{__schema{types{name}}}");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("manual");
  });

  test("introspection over POST sends only the read-only query as JSON", () => {
    const { url, init } = buildGraphqlProbe(`${BASE}/graphql`, { op: "introspection", method: "POST" });
    expect(url).toBe(`${BASE}/graphql`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ query: "{__schema{types{name}}}" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("the no-op mutation is GET only", () => {
    const { url, init } = buildGraphqlProbe(`${BASE}/graphql`, { op: "noop-mutation", method: "GET" });
    expect(new URL(url).searchParams.get("query")).toBe("mutation{__typename}");
    expect(NOOP_MUTATION).toBe("mutation{__typename}");
    expect(init.body).toBeUndefined();
    expect(() =>
      buildGraphqlProbe(`${BASE}/graphql`, { op: "noop-mutation", method: "POST" } as never)
    ).toThrow();
  });
});

describe("sendGraphqlProbe: the probe budget gate", () => {
  test("passive and an absent budget send nothing", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    const passive = createProbeBudget({ level: "passive", budgetMs: 60_000 });
    for (const probe of [passive, undefined]) {
      const out = await sendGraphqlProbe(probe, `${BASE}/graphql`, { op: "introspection", method: "GET" });
      expect(out).toEqual({ sent: false, reason: "not-allowed" });
    }
    expect(stub.sent).toHaveLength(0);
  });

  test("active sends a GET but never the POST; aggressive sends both", async () => {
    const stub = stubFetch({ [`${BASE}/graphql`]: () => json({ data: null, errors: [{ message: "x" }] }) });
    restore = stub.restore;
    const active = createProbeBudget({ level: "active", budgetMs: 60_000 });
    expect((await sendGraphqlProbe(active, `${BASE}/graphql`, { op: "introspection", method: "GET" })).sent).toBe(true);
    expect((await sendGraphqlProbe(active, `${BASE}/graphql`, { op: "introspection", method: "POST" })).sent).toBe(false);
    expect(stub.sent.map((r) => r.method)).toEqual(["GET"]);

    const aggressive = createProbeBudget({ level: "aggressive", budgetMs: 60_000 });
    expect((await sendGraphqlProbe(aggressive, `${BASE}/graphql`, { op: "introspection", method: "POST" })).sent).toBe(true);
    expect(stub.sent.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(active.summary().requests).toBe(1);
    expect(aggressive.summary().requests).toBe(1);
  });

  test("an exhausted budget sends nothing", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    let t = 0;
    const probe = createProbeBudget({ level: "active", budgetMs: 10, now: () => t });
    expect((await sendGraphqlProbe(probe, `${BASE}/graphql`, { op: "introspection", method: "GET" })).sent).toBe(true);
    t = 50;
    expect((await sendGraphqlProbe(probe, `${BASE}/graphql`, { op: "introspection", method: "GET" })).sent).toBe(false);
    expect(stub.sent).toHaveLength(1);
  });

  test("a body over the cap is cut and marked truncated", async () => {
    const cap = GRAPHQL_RESPONSE_CAPS["noop-mutation"];
    const big = `{"data":{"__typename":"Mutation"},"x":"${"a".repeat(cap)}"}`;
    const stub = stubFetch({
      [`${BASE}/graphql`]: () => new Response(new Blob([big]).stream(), { headers: { "content-type": "application/json" } }),
      [`${BASE}/declared`]: () =>
        new Response(big, { headers: { "content-type": "application/json", "content-length": String(big.length) } }),
    });
    restore = stub.restore;
    const probe = createProbeBudget({ level: "active", budgetMs: 60_000 });
    for (const path of ["/graphql", "/declared"]) {
      const out = await sendGraphqlProbe(probe, `${BASE}${path}`, { op: "noop-mutation", method: "GET" });
      if (!out.sent || "error" in out) throw new Error("expected a response");
      expect(out.response.truncated).toBe(true);
      expect(out.response.body.length).toBeLessThanOrEqual(cap);
      expect(parseGraphqlBody(out.response)).toBeNull();
    }
  });

  test("a body read that fails partway is reported as an error, not thrown", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`{"data":`));
        controller.error(new Error("aborted"));
      },
    });
    const stub = stubFetch({
      [`${BASE}/graphql`]: () => new Response(stream, { headers: { "content-type": "application/json" } }),
    });
    restore = stub.restore;
    const probe = createProbeBudget({ level: "active", budgetMs: 60_000 });
    const out = await sendGraphqlProbe(probe, `${BASE}/graphql`, { op: "introspection", method: "GET" });
    expect(out.sent).toBe(true);
    expect("error" in out).toBe(true);
  });

  test("a network error is reported, not thrown", async () => {
    const stub = stubFetch({
      [`${BASE}/graphql`]: () => {
        throw new TypeError("connection refused");
      },
    });
    restore = stub.restore;
    const probe = createProbeBudget({ level: "active", budgetMs: 60_000 });
    const out = await sendGraphqlProbe(probe, `${BASE}/graphql`, { op: "introspection", method: "GET" });
    expect(out.sent).toBe(true);
    expect("error" in out).toBe(true);
  });
});

describe("truncatedSchemaTypeNames", () => {
  const cut = (body: string, contentType = "application/json"): GraphqlProbeResponse => ({
    status: 200,
    contentType,
    body,
    truncated: true,
  });

  test("reads complete type names from the prefix of a cut introspection answer", () => {
    expect(
      truncatedSchemaTypeNames(cut(`{"data":{"__schema":{"types":[{"name":"Query"},{"name":"User"},{"na`))
    ).toEqual(["Query", "User"]);
  });

  test("a matching prefix with no complete name is still a schema (empty list, not null)", () => {
    expect(truncatedSchemaTypeNames(cut(`{"data":{"__schema":{"types":[`))).toEqual([]);
  });

  test("anything else is null", () => {
    expect(truncatedSchemaTypeNames(cut(`{"items":[{"name":"a"}]`))).toBeNull();
    expect(truncatedSchemaTypeNames(cut(`{"data":{"__schema":{"types":[{"name":"Q"}]`, "text/html"))).toBeNull();
    expect(
      truncatedSchemaTypeNames({ ...cut(`{"data":{"__schema":{"types":[{"name":"Q"}]}}}`), truncated: false })
    ).toBeNull();
  });
});

describe("parseGraphqlBody: GraphQL-shaped responses only", () => {
  const resp = (body: string, contentType = "application/json"): GraphqlProbeResponse => ({
    status: 200,
    contentType,
    body,
    truncated: false,
  });

  test("data and GraphQL errors are read", () => {
    expect(parseGraphqlBody(resp(`{"data":{"__typename":"Query"}}`))).toEqual({
      data: { __typename: "Query" },
      errors: [],
    });
    expect(
      parseGraphqlBody(resp(`{"errors":[{"message":"Cannot query field","locations":[]}],"extensions":{}}`))
    ).toEqual({ data: undefined, errors: [{ message: "Cannot query field" }] });
    expect(parseGraphqlBody(resp(`{"data":null,"errors":[{"message":"x"}]}`, "application/graphql-response+json"))).not.toBeNull();
  });

  test("HTML, catch-all, REST and JSON:API bodies are not GraphQL", () => {
    for (const r of [
      resp("<!doctype html><html></html>", "text/html"),
      resp(`{"data":{"__typename":"Mutation"}}`, "text/html; charset=utf-8"),
      resp("not json"),
      resp("[1,2]"),
      resp(`{"status":"ok"}`),
      resp(`{"data":{"id":1},"status":"ok"}`),
      resp(`{"errors":[{"status":"404","title":"Not Found"}]}`),
      resp(`{"errors":[]}`),
      resp(`{"errors":"bad"}`),
      resp(`{"data":"text"}`),
      resp(`{"data":null}`),
      resp(`{}`),
    ]) {
      expect(parseGraphqlBody(r)).toBeNull();
    }
    expect(parseGraphqlBody({ ...resp(`{"data":{}}`), truncated: true })).toBeNull();
  });
});
