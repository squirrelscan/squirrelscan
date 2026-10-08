// security/graphql-get-mutations: the only operation ever sent is the no-op
// `mutation{__typename}` as a GET; an executed mutation is flagged, and a 405,
// a POST-only error, an introspection-style error, a query answer, HTML or a
// catch-all is not. Every test runs the rule fresh against a stubbed fetch, so
// no result is replayed from a cache.

import { afterEach, describe, expect, test } from "bun:test";

import { executedMutationType, graphqlGetMutationsRule } from "../src/security/graphql-get-mutations";
import { NOOP_MUTATION } from "../src/security/graphql-probe";
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

const GQL = `${BASE}/graphql`;

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await graphqlGetMutationsRule.run(ruleCtx(ctxOpts));
  return { checks, sent: stub.sent };
}

/** The only request this rule may send: a body-less GET whose sole query param is the no-op mutation. */
function isNoopMutationGet(r: SentRequest): boolean {
  const u = new URL(r.url);
  return (
    r.method === "GET" &&
    r.body === null &&
    [...u.searchParams.keys()].join(",") === "query" &&
    u.searchParams.get("query") === "mutation{__typename}" &&
    u.origin === BASE &&
    r.credentials === "omit" &&
    r.redirect === "manual"
  );
}

describe("security/graphql-get-mutations", () => {
  test("passive or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run({ [GQL]: () => json({ data: { __typename: "Mutation" } }) }, opts);
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([expect.objectContaining({ status: "skipped", skipReason: "probing-passive" })]);
    }
  });

  test("nothing but the no-op mutation over GET is ever sent, at any level and any answer", async () => {
    const answers: Route[] = [
      () => json({ data: { __typename: "Mutation" } }),
      () => json({ errors: [{ message: "Can only perform a mutation operation from a POST request." }] }, 405),
      () => json({ errors: [{ message: "x" }] }, 400),
      () => html(),
    ];
    const discovered = surface([
      candidate("/v1/graphql?operationName=Feed"),
      candidate("/graphql/logout"),
      candidate("/gql", { method: "PATCH" }),
      candidate("https://api.vendor.com/graphql"),
    ]);
    let total = 0;
    for (const level of ["active", "aggressive"] as const) {
      for (const answer of answers) {
        const { sent } = await run(
          { [GQL]: answer, [`${BASE}/v1/graphql`]: answer, [`${BASE}/api/graphql`]: answer },
          { level, surface: discovered }
        );
        expect(sent.every(isNoopMutationGet)).toBe(true);
        // One request per endpoint: /v1/graphql, /graphql, /api/graphql.
        expect(sent.map((r) => new URL(r.url).pathname)).toEqual(["/v1/graphql", "/graphql", "/api/graphql"]);
        total += sent.length;
        restore?.();
      }
    }
    expect(total).toBe(2 * answers.length * 3);
    expect(NOOP_MUTATION).toBe("mutation{__typename}");
  });

  test("an executed mutation is flagged, naming the endpoint, the risk and the fix", async () => {
    const { checks } = await run({ [GQL]: () => json({ data: { __typename: "Mutation" } }) });
    const fail = checks.filter((c) => c.status === "fail");
    expect(fail).toHaveLength(1);
    const msg = fail[0]!.message;
    expect(msg).toContain(GQL);
    expect(msg).toContain("over GET");
    expect(msg).toContain("CSRF");
    expect(msg).toContain("idempotent");
    expect(msg).toContain("require POST with a non-simple Content-Type or a CSRF token");
    expect(fail[0]!.items?.[0]).toMatchObject({ id: GQL, meta: { mutationType: "Mutation" } });
  });

  test("custom mutation root names are recognised", async () => {
    for (const name of ["mutation_root", "RootMutationType", "MutationRoot"]) {
      const { checks } = await run(
        { [GQL]: () => json({ data: { __typename: name } }, 200, "application/graphql-response+json") }
      );
      expect(checks.filter((c) => c.status === "fail")).toHaveLength(1);
      restore?.();
    }
  });

  test("405, POST-only errors, introspection-style errors and query answers are not flagged", async () => {
    for (const route of [
      () => new Response("Method Not Allowed", { status: 405 }),
      () => json({ errors: [{ message: "Can only perform a mutation operation from a POST request." }] }, 405),
      () => json({ errors: [{ message: "Mutations are only allowed over POST" }] }, 400),
      () => json({ errors: [{ message: "GraphQL introspection is not allowed" }] }, 400),
      () => json({ errors: [{ message: "Schema is not configured for mutations." }] }, 200),
      () => json({ data: null, errors: [{ message: "mutation not allowed" }] }, 200),
      () => json({ data: { __typename: "Query" } }),
      () => json({ data: { __typename: "Mutation" } }, 405),
    ]) {
      const { checks } = await run({ [GQL]: route });
      expect(checks).toEqual([expect.objectContaining({ status: "pass" })]);
      restore?.();
    }
  });

  test("HTML, catch-all and non-GraphQL JSON answers are not flagged, whatever the status", async () => {
    for (const route of [
      () => html("<!doctype html><div id=root></div>", 200),
      () => html(`{"data":{"__typename":"Mutation"}}`, 200),
      () => json({ __typename: "Mutation" }),
      () => json({ data: { __typename: "Mutation" }, status: "ok" }),
      () => json({ ok: true }),
    ]) {
      const { checks } = await run({ [GQL]: route });
      expect(checks).toEqual([expect.objectContaining({ status: "pass" })]);
      restore?.();
    }
  });

  test("an oversized answer is not parsed or flagged", async () => {
    const big = JSON.stringify({ data: { __typename: "Mutation" }, extensions: { pad: "a".repeat(70 * 1024) } });
    const { checks } = await run({ [GQL]: () => new Response(big, { headers: { "content-type": "application/json" } }) });
    expect(checks).toEqual([expect.objectContaining({ status: "pass" })]);
  });

  test("when every probe fails with a network error the rule skips, it does not pass", async () => {
    const fail = () => {
      throw new TypeError("timed out");
    };
    const { checks, sent } = await run({ [GQL]: fail, [`${BASE}/api/graphql`]: fail });
    expect(sent).toHaveLength(2);
    expect(checks).toEqual([
      expect.objectContaining({ status: "skipped", skipReason: "probe-errors" }),
    ]);
  });

  test("robots.txt disallowed endpoints are not probed below aggressive", async () => {
    const { sent } = await run({}, { robotsTxt: robots(["/graphql", "/api/"]) });
    expect(sent).toHaveLength(0);
  });

  test("a spent budget skips the rule without sending", async () => {
    let t = 0;
    const stub = stubFetch({});
    restore = stub.restore;
    const ctx = ruleCtx({ budgetMs: 5, now: () => t });
    ctx.probe!.allows("quiet");
    t = 100;
    const { checks } = await graphqlGetMutationsRule.run(ctx);
    expect(stub.sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
  });

  test("each run probes live: a fixed server passes on the next run", async () => {
    const first = await run({ [GQL]: () => json({ data: { __typename: "Mutation" } }) });
    expect(first.checks.some((c) => c.status === "fail")).toBe(true);
    restore?.();
    const second = await run({ [GQL]: () => new Response(null, { status: 405 }) });
    expect(second.checks).toEqual([expect.objectContaining({ status: "pass" })]);
  });

  test("executedMutationType", () => {
    expect(executedMutationType({ data: { __typename: "Mutation" }, errors: [] })).toBe("Mutation");
    expect(executedMutationType({ data: { __typename: "Query" }, errors: [] })).toBeNull();
    expect(executedMutationType({ data: null, errors: [{ message: "x" }] })).toBeNull();
    expect(executedMutationType(null)).toBeNull();
  });
});
