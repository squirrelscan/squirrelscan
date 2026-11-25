// security/http-methods: reads the Allow header from OPTIONS, confirms TRACE
// with one TRACE only when it is advertised, and never sends a state-changing
// method. Answers come from a stubbed fetch that records every request.

import { afterEach, describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import {
  DANGEROUS_METHODS,
  httpMethodsRule,
  MAX_OPTIONS_PATHS,
  parseAllow,
  runHttpMethods,
  selectOptionsUrls,
} from "../src/security/http-methods";
import {
  BASE,
  robots,
  ruleCtx,
  stubFetch,
  type Route,
} from "./helpers/graphql-server";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const allow =
  (value: string, status = 200): Route =>
  (req) =>
    req.method === "OPTIONS"
      ? new Response(null, { status, headers: { allow: value } })
      : new Response("<html></html>", { status: 405 });

function withPages(ctx: RuleContext, paths: string[]): RuleContext {
  return {
    ...ctx,
    site: {
      ...ctx.site!,
      pages: paths.map((p) => ({
        url: `${BASE}${p}`,
        statusCode: 200,
        parsed: {} as never,
      })),
    },
  };
}

const names = (r: Awaited<ReturnType<typeof runHttpMethods>>) =>
  r.checks.map((c) => `${c.name}:${c.status}`);

describe("parseAllow", () => {
  test("keeps only dangerous methods, case-insensitively", () => {
    expect(parseAllow("get, head, Put, DELETE, options")).toEqual([
      "PUT",
      "DELETE",
    ]);
    expect(parseAllow("GET, POST")).toEqual([]);
    expect(parseAllow(null)).toEqual([]);
  });
  test("covers every method the rule documents", () => {
    expect(parseAllow(DANGEROUS_METHODS.join(","))).toEqual([
      ...DANGEROUS_METHODS,
    ]);
  });
});

describe("probing gate", () => {
  test("passive sends nothing and skips", async () => {
    const s = stubFetch({});
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({ level: "passive" }));
    expect(s.sent).toHaveLength(0);
    expect(r.checks[0]).toMatchObject({
      status: "skipped",
      skipReason: "probing-passive",
    });
  });
  test("no probe budget sends nothing", async () => {
    const s = stubFetch({});
    restore = s.restore;
    await runHttpMethods(ruleCtx({ noProbe: true }));
    expect(s.sent).toHaveLength(0);
  });
  test("a spent budget sends nothing and skips", async () => {
    const s = stubFetch({});
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({ budgetMs: 0 }));
    expect(s.sent).toHaveLength(0);
    expect(r.checks[0]).toMatchObject({
      status: "skipped",
      skipReason: "probe-budget",
    });
  });
});

describe("findings", () => {
  test("a clean site passes after one OPTIONS", async () => {
    const s = stubFetch({ [`${BASE}/`]: allow("GET, HEAD, POST, OPTIONS") });
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({}));
    expect(names(r)).toEqual(["http-methods:pass"]);
    expect(s.sent.map((q) => q.method)).toEqual(["OPTIONS"]);
  });

  test("PUT, DELETE, PATCH and CONNECT warn and send no TRACE", async () => {
    const s = stubFetch({
      [`${BASE}/`]: allow("GET, PUT, DELETE, PATCH, CONNECT"),
    });
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({}));
    expect(names(r)).toEqual(["http-methods-dangerous:warn"]);
    expect(r.checks[0]!.message).toContain("PUT, DELETE, PATCH, CONNECT");
    expect(s.sent.map((q) => q.method)).toEqual(["OPTIONS"]);
  });

  test("a reflected TRACE fails and is sent once with a marker and no credentials", async () => {
    const s = stubFetch({
      [`${BASE}/`]: (req) =>
        req.method === "OPTIONS"
          ? new Response(null, { headers: { allow: "GET, TRACE, TRACK" } })
          : new Response(
              `TRACE / HTTP/1.1\r\n${req.headers["x-squirrelscan-trace"]}`
            ),
    });
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({}));
    expect(names(r)).toEqual([
      "http-methods-trace:fail",
      "http-methods-dangerous:warn",
    ]);
    const traces = s.sent.filter((q) => q.method === "TRACE");
    expect(traces).toHaveLength(1);
    expect(traces[0]!.credentials).toBe("omit");
    expect(traces[0]!.headers["x-squirrelscan-trace"]).toBeTruthy();
    expect(r.checks[1]!.message).not.toContain("TRACE,");
  });

  test("a message/http TRACE answer counts as reflection", async () => {
    const s = stubFetch({
      [`${BASE}/`]: (req) =>
        req.method === "OPTIONS"
          ? new Response(null, { headers: { allow: "TRACE" } })
          : new Response("", { headers: { "content-type": "message/http" } }),
    });
    restore = s.restore;
    expect(names(await runHttpMethods(ruleCtx({})))).toEqual([
      "http-methods-trace:fail",
    ]);
  });

  test("an advertised but refused TRACE only warns", async () => {
    const s = stubFetch({
      [`${BASE}/`]: (req) =>
        req.method === "OPTIONS"
          ? new Response(null, { headers: { allow: "GET, TRACE" } })
          : new Response("nope", { status: 405 }),
    });
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({}));
    expect(names(r)).toEqual(["http-methods-dangerous:warn"]);
    expect(r.checks[0]!.message).toContain("did not reflect");
  });

  test("TRACE is never sent when not advertised", async () => {
    const s = stubFetch({ [`${BASE}/`]: allow("GET, PUT") });
    restore = s.restore;
    await runHttpMethods(ruleCtx({}));
    expect(s.sent.some((q) => q.method === "TRACE")).toBe(false);
  });
});

describe("what is sent", () => {
  test("only OPTIONS and at most one TRACE, however many methods are advertised", async () => {
    const s = stubFetch({
      [`${BASE}/`]: allow("PUT, DELETE, PATCH, CONNECT, TRACE, TRACK"),
      [`${BASE}/blog`]: allow("PUT, DELETE, PATCH, CONNECT, TRACE, TRACK"),
      [`${BASE}/shop`]: allow("PUT, DELETE, PATCH, CONNECT, TRACE, TRACK"),
    });
    restore = s.restore;
    await runHttpMethods(
      withPages(ruleCtx({}), ["/blog/a", "/blog/b", "/shop/x", "/docs/y"])
    );
    const methods = s.sent.map((q) => q.method);
    expect(methods.every((m) => m === "OPTIONS" || m === "TRACE")).toBe(true);
    expect(methods.filter((m) => m === "OPTIONS")).toHaveLength(
      MAX_OPTIONS_PATHS
    );
    expect(methods.filter((m) => m === "TRACE")).toHaveLength(1);
  });

  test("path selection: same origin, one per section, no actions, no robots-disallowed", () => {
    const ctx = withPages(ruleCtx({ robotsTxt: robots(["/private"]) }), [
      "/",
      "/private/a",
      "/logout",
      "/blog/a",
      "/blog/b",
      "/docs/x",
      "/shop",
    ]);
    ctx.site!.pages.push({
      url: "https://other.example.org/zzz",
      statusCode: 200,
      parsed: {} as never,
    });
    expect(selectOptionsUrls(ctx)).toEqual([
      `${BASE}/`,
      `${BASE}/blog/a`,
      `${BASE}/docs/x`,
    ]);
  });
});

describe("unverified answers", () => {
  test("a throttled answer is not a pass", async () => {
    const s = stubFetch({
      [`${BASE}/`]: () => new Response("slow down", { status: 429 }),
    });
    restore = s.restore;
    const r = await runHttpMethods(ruleCtx({}));
    expect(names(r)).toEqual(["http-methods-not-checked:skipped"]);
    expect(r.checks[0]!.skipReason).toBe("probe-errors");
  });
  test("a network error is not a pass", async () => {
    const s = stubFetch({
      [`${BASE}/`]: () => {
        throw new TypeError("connect failed");
      },
    });
    restore = s.restore;
    expect(names(await runHttpMethods(ruleCtx({})))).toEqual([
      "http-methods-not-checked:skipped",
    ]);
  });
  test("a finding stands even when another path was throttled", async () => {
    const s = stubFetch({
      [`${BASE}/`]: allow("PUT"),
      [`${BASE}/blog`]: () => new Response("", { status: 429 }),
    });
    restore = s.restore;
    const r = await runHttpMethods(withPages(ruleCtx({}), ["/blog/a"]));
    expect(names(r)).toEqual(["http-methods-dangerous:warn"]);
  });
});

describe("meta", () => {
  test("declares its checks and scope", () => {
    expect(httpMethodsRule.meta.id).toBe("security/http-methods");
    expect(httpMethodsRule.meta.scope).toBe("site");
    expect(httpMethodsRule.meta.checks?.map((c) => c.name)).toContain(
      "http-methods-trace"
    );
  });
});
