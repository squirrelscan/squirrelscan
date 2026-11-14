// security/exposed-actuator: confirms an actuator endpoint only from its shape,
// never from a status code, sends only GETs to fixed read-only sub-endpoints of
// same-origin actuator bases, never touches a state-changing or cross-origin
// candidate, asks for a heap dump only when aggressive, and never puts a
// response body in a finding. The fixture-server tests run a real local HTTP
// server; the rest answer from a stubbed fetch that records every request.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ACTUATOR_ENDPOINTS,
  exposedActuatorRule,
  MAX_ACTUATOR_BASES,
  selectActuatorBases,
} from "../src/security/exposed-actuator";
import type { CheckResult, RuleContext } from "../src/types";
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

const SECRET = "s3cr3t-db-password-value";

const INDEX = (base: string, ids: string[]) => ({
  _links: {
    self: { href: base, templated: false },
    ...Object.fromEntries(ids.map((id) => [id, { href: `${base}/${id}`, templated: false }])),
    "env-toMatch": { href: `${base}/env/{toMatch}`, templated: true },
  },
});

const ENV = {
  activeProfiles: ["prod"],
  propertySources: [
    { name: "systemEnvironment", properties: { DB_PASSWORD: { value: SECRET, origin: "System Environment Property" } } },
    { name: "Config resource 'class path resource [application.yml]'", properties: {} },
  ],
};

const CONFIGPROPS = {
  contexts: {
    application: {
      beans: {
        "spring.datasource-org.springframework.boot.autoconfigure.jdbc.DataSourceProperties": {
          prefix: "spring.datasource",
          properties: { password: SECRET, url: "jdbc:postgresql://db/app" },
          inputs: {},
        },
      },
    },
  },
};

const MAPPINGS = {
  contexts: { application: { mappings: { dispatcherServlets: { dispatcherServlet: [] }, servletFilters: [] } } },
};

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await exposedActuatorRule.run(ruleCtx(ctxOpts));
  return { checks, sent: stub.sent };
}

const paths = (sent: SentRequest[]) => sent.map((r) => `${r.method} ${new URL(r.url).pathname}`);

describe("security/exposed-actuator", () => {
  test("passive or no probe budget: not checked with the probe skip reason, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run({ [`${BASE}/actuator/env`]: () => json(ENV) }, opts);
      expect(sent).toHaveLength(0);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        name: "exposed-actuator-not-checked",
        status: "skipped",
        skipReason: "probing-passive",
      });
      restore?.();
    }
  });

  test("an SPA catch-all 200 on every path is not a finding", async () => {
    const shell = () => html("<!doctype html><div id=root></div>", 200);
    const routes = Object.fromEntries(ACTUATOR_ENDPOINTS.map((e) => [`${BASE}/actuator${e.path}`, shell]));
    for (const level of ["active", "aggressive"] as const) {
      const { checks, sent } = await run(routes, { level });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "exposed-actuator", status: "pass" });
      expect(sent.length).toBeGreaterThan(0);
      restore?.();
    }
  });

  test("a JSON catch-all or an empty object with a 200 is not a finding (shape, not status)", async () => {
    for (const body of [{}, { status: "ok" }, { _links: { self: { href: `${BASE}/actuator` } } }, { contexts: {} }]) {
      const route = () => json(body);
      const routes = Object.fromEntries(ACTUATOR_ENDPOINTS.map((e) => [`${BASE}/actuator${e.path}`, route]));
      const { checks } = await run(routes, { level: "aggressive" });
      expect(checks.map((c) => c.status)).toEqual(["pass"]);
      restore?.();
    }
  });

  test("an env endpoint behind auth (401/403) is not a finding", async () => {
    const { checks } = await run({
      [`${BASE}/actuator`]: () => json({ error: "Unauthorized" }, 401),
      [`${BASE}/actuator/env`]: () => json(ENV, 403),
    });
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("only GETs, without cookies or redirects, and the active run never asks for a heap dump", async () => {
    const { sent } = await run({});
    expect(paths(sent)).toEqual([
      "GET /actuator",
      "GET /actuator/env",
      "GET /actuator/configprops",
      "GET /actuator/mappings",
    ]);
    expect(sent.every((r) => r.body === null && r.credentials === "omit" && r.redirect === "manual")).toBe(true);
  });

  test("active: a heapdump listed by an open index is critical from the listing, and is not requested", async () => {
    const { checks, sent } = await run({
      [`${BASE}/actuator`]: () => json(INDEX(`${BASE}/actuator`, ["health", "heapdump"])),
    });
    expect(sent.some((r) => r.url.includes("heapdump"))).toBe(false);
    const critical = checks.find((c) => c.name === "exposed-actuator-critical");
    expect(critical?.status).toBe("fail");
    expect(critical?.items?.find((i) => i.id === `${BASE}/actuator/heapdump`)?.meta).toMatchObject({
      endpoint: "heapdump",
      evidence: "listed-in-index",
      severity: "critical",
      confidence: "lower",
    });
    const warn = checks.find((c) => c.name === "exposed-actuator-endpoints");
    expect(warn?.items?.map((i) => i.meta?.endpoint)).toEqual(["index"]);
  });

  test("an open index limits the requests to the endpoints it lists", async () => {
    const { checks, sent } = await run(
      {
        [`${BASE}/actuator`]: () => json(INDEX(`${BASE}/actuator`, ["health", "env", "info"])),
        [`${BASE}/actuator/env`]: () => json(ENV),
      },
      { level: "aggressive" }
    );
    expect(paths(sent)).toEqual(["GET /actuator", "GET /actuator/env"]);
    expect(checks.find((c) => c.name === "exposed-actuator-critical")?.items?.map((i) => i.meta?.endpoint)).toEqual([
      "env",
    ]);
  });

  test("configprops is critical and mappings is a warning", async () => {
    const { checks } = await run({
      [`${BASE}/actuator/configprops`]: () => json(CONFIGPROPS),
      [`${BASE}/actuator/mappings`]: () => json(MAPPINGS),
    });
    expect(checks.find((c) => c.name === "exposed-actuator-critical")?.items?.map((i) => i.meta?.endpoint)).toEqual([
      "configprops",
    ]);
    expect(checks.find((c) => c.name === "exposed-actuator-endpoints")?.items?.map((i) => i.meta?.endpoint)).toEqual([
      "mappings",
    ]);
    expect(JSON.stringify(checks)).not.toContain(SECRET);
  });

  test("an env answer longer than the read cap is still recognised from its opening", async () => {
    const big = JSON.stringify({
      activeProfiles: [],
      propertySources: [{ name: "big", properties: { X: { value: "a".repeat(1100 * 1024) } } }],
    });
    const { checks } = await run({
      [`${BASE}/actuator/env`]: () => new Response(big, { headers: { "content-type": "application/json" } }),
    });
    expect(checks.find((c) => c.name === "exposed-actuator-critical")?.items?.[0]?.meta?.evidence).toBe(
      "env-property-sources"
    );
  });

  test("a discovered actuator base is probed under its own path", async () => {
    const { checks, sent } = await run(
      { [`${BASE}/manage/actuator/env`]: () => json(ENV) },
      { surface: surface([candidate("/manage/actuator/health", { method: "GET" })]) }
    );
    expect(paths(sent).slice(0, 2)).toEqual(["GET /manage/actuator", "GET /manage/actuator/env"]);
    const critical = checks.find((c) => c.name === "exposed-actuator-critical");
    expect(critical?.items?.[0]).toMatchObject({
      id: `${BASE}/manage/actuator/env`,
      meta: { source: "discovered", discoveredVia: "fetch" },
    });
  });

  test("a cross-origin candidate is never requested, whatever it claims", async () => {
    const other = "https://other.example.net";
    const { sent } = await run(
      {},
      {
        surface: surface([
          candidate(`${other}/actuator/env`, { method: "GET" }),
          // Mislabelled as same-origin and eligible: the rule re-checks the origin.
          candidate(`${other}/ops/actuator`, { method: "GET", sameOrigin: true, probeEligible: true }),
          candidate("http://example.com/plain/actuator", { method: "GET", sameOrigin: true, probeEligible: true }),
        ]),
      }
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((r) => new URL(r.url).origin === BASE)).toBe(true);
    expect(sent.some((r) => r.url.includes("/ops/") || r.url.includes("/plain/"))).toBe(false);
  });

  test("a POST-only or state-changing candidate is never requested, nor its base", async () => {
    const { sent } = await run(
      {},
      {
        level: "aggressive",
        surface: surface([
          candidate("/mgmt/actuator/shutdown", { method: "POST" }),
          candidate("/a/actuator/refresh", { method: "GET" }),
          candidate("/b/actuator/loggers/com.example", { method: "POST" }),
          candidate("/c/actuator/caches", { method: "DELETE" }),
          candidate("/d/actuator/logout"),
        ]),
      }
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((r) => r.method === "GET")).toBe(true);
    expect(sent.every((r) => new URL(r.url).pathname.startsWith("/actuator"))).toBe(true);
    expect(sent.some((r) => /shutdown|refresh|loggers|caches|logout/.test(r.url))).toBe(false);
  });

  test("robots.txt-disallowed actuator paths are skipped below aggressive", async () => {
    const { sent, checks } = await run({}, { robotsTxt: robots(["/actuator"]) });
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "pass", details: { skippedRobots: 4 } });
  });

  test("no probe budget left: not checked, nothing sent", async () => {
    const { sent, checks } = await run({}, { budgetMs: 0 });
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ name: "exposed-actuator-not-checked", skipReason: "probe-budget" });
  });

  test("network errors on every probe: not checked, not a pass", async () => {
    const { checks } = await run(
      Object.fromEntries(
        ACTUATOR_ENDPOINTS.map((e) => [
          `${BASE}/actuator${e.path}`,
          () => {
            throw new TypeError("connection refused");
          },
        ])
      )
    );
    expect(checks[0]).toMatchObject({ name: "exposed-actuator-not-checked", skipReason: "probe-errors" });
  });
});

describe("selectActuatorBases", () => {
  test("caps the bases and always keeps the order: discovered, then /actuator", () => {
    const ctx = ruleCtx({
      surface: surface(
        ["/a", "/b", "/c", "/d"].map((p) => candidate(`${p}/actuator/health`, { method: "GET" }))
      ),
    });
    const sel = selectActuatorBases(ctx);
    expect(sel.bases.map((b) => new URL(b.url).pathname)).toEqual(["/a/actuator", "/b/actuator", "/c/actuator"]);
    expect(sel.bases).toHaveLength(MAX_ACTUATOR_BASES);
    expect(sel.skippedCap).toBe(2);
  });
});

// ── fixture servers: a real local HTTP server ─────────────────────

function serverCtx(origin: string, level: "active" | "aggressive"): RuleContext {
  const ctx = ruleCtx({ level });
  ctx.site = { ...ctx.site!, baseUrl: `${origin}/` };
  return ctx;
}

describe("security/exposed-actuator against a fixture server", () => {
  test("a real actuator with env exposed: env is critical, and no value appears in the result", async () => {
    const seen: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        seen.push(`${req.method} ${pathname}`);
        const origin = new URL(req.url).origin;
        if (pathname === "/actuator") return Response.json(INDEX(`${origin}/actuator`, ["health", "env", "info"]));
        if (pathname === "/actuator/env") return Response.json(ENV);
        return new Response("Not Found", { status: 404 });
      },
    });
    const origin = `http://localhost:${server.port}`;
    const { checks } = await exposedActuatorRule.run(serverCtx(origin, "active"));
    const critical = checks.find((c) => c.name === "exposed-actuator-critical");
    expect(critical?.status).toBe("fail");
    expect(critical?.details?.severity).toBe("critical");
    expect(critical?.items?.map((i) => [i.id, i.meta?.evidence])).toEqual([
      [`${origin}/actuator/env`, "env-property-sources"],
    ]);
    expect(checks.find((c) => c.name === "exposed-actuator-endpoints")?.items?.[0]?.meta?.evidence).toBe(
      "actuator-index-links"
    );
    const text = JSON.stringify(checks);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("DB_PASSWORD");
    expect(text).not.toContain("systemEnvironment");
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
  });

  test("aggressive: a heap dump is confirmed from its HPROF header with a capped Range read", async () => {
    const seen: { range: string | null } = { range: null };
    let chunksSent = 0;
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname !== "/actuator/heapdump") return new Response("Not Found", { status: 404 });
        seen.range = req.headers.get("range");
        // A server that ignores Range and streams an endless dump.
        const header = new TextEncoder().encode("JAVA PROFILE 1.0.2\0");
        const filler = new Uint8Array(64 * 1024).fill(7);
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(header);
          },
          pull(c) {
            chunksSent++;
            if (chunksSent > 20_000) return c.close();
            c.enqueue(filler);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      },
    });
    const origin = `http://localhost:${server.port}`;
    const started = Date.now();
    const { checks } = await exposedActuatorRule.run(serverCtx(origin, "aggressive"));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.range).toBe("bytes=0-63");
    expect(chunksSent).toBeLessThan(20_000);
    const critical = checks.find((c) => c.name === "exposed-actuator-critical");
    expect(critical?.items?.map((i) => [i.id, i.meta?.evidence])).toEqual([
      [`${origin}/actuator/heapdump`, "hprof-header"],
    ]);
    expect(JSON.stringify(checks)).not.toContain("JAVA PROFILE");
  }, 30_000);

  test("an SPA fixture that answers every path with its 200 shell: no finding", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response("<!doctype html><div id=app></div>", { headers: { "content-type": "text/html" } }),
    });
    const { checks } = await exposedActuatorRule.run(serverCtx(`http://localhost:${server.port}`, "aggressive"));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["exposed-actuator", "pass"]]);
  });
});
