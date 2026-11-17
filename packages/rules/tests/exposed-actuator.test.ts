// security/exposed-actuator: confirms an actuator endpoint only from its shape,
// never from a status code, sends only GETs to fixed read-only sub-endpoints of
// same-origin actuator bases, never touches a state-changing or cross-origin
// candidate, asks for a heap dump only when aggressive, and never puts a
// response body in a finding. The fixture-server tests run a real local HTTP
// server; the rest answer from a stubbed fetch that records every request.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ACTUATOR_ENDPOINTS,
  ACTUATOR_PROBE_TIMEOUT_MS,
  ACTUATOR_TOTAL_BUDGET_MS,
  exposedActuatorRule,
  MAX_ACTUATOR_BASES,
  runExposedActuator,
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
      // The heapdump never passes on a 200 without its header: only a 401, 403 or 404 does.
      expect(checks.map((c) => [c.name, c.status])).toEqual([
        ["exposed-actuator", "pass"],
        ["exposed-actuator-heapdump-not-checked", "skipped"],
      ]);
      expect(sent.length).toBeGreaterThan(0);
      restore?.();
    }
  });

  test("a JSON catch-all or an empty object with a 200 is not a finding (shape, not status)", async () => {
    for (const body of [{}, { status: "ok" }, { _links: { self: { href: `${BASE}/actuator` } } }, { contexts: {} }]) {
      const route = () => json(body);
      const routes = Object.fromEntries(ACTUATOR_ENDPOINTS.map((e) => [`${BASE}/actuator${e.path}`, route]));
      const { checks } = await run(routes, { level: "aggressive" });
      expect(checks.map((c) => c.status)).toEqual(["pass", "skipped"]);
      restore?.();
    }
  });

  test("an env endpoint behind auth (401/403) is not a finding", async () => {
    const { checks } = await run({
      [`${BASE}/actuator`]: () => json({ error: "Unauthorized" }, 401),
      [`${BASE}/actuator/env`]: () => json(ENV, 403),
    });
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["exposed-actuator", "pass"],
      ["exposed-actuator-heapdump-not-checked", "skipped"],
    ]);
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

  test("active: a heapdump listed by an open index is a warning from the listing, never critical, and is not requested", async () => {
    const { checks, sent } = await run({
      [`${BASE}/actuator`]: () => json(INDEX(`${BASE}/actuator`, ["health", "heapdump"])),
    });
    expect(sent.some((r) => r.url.includes("heapdump"))).toBe(false);
    // The index lists endpoints even when Spring Security protects them, so the
    // listing alone is not proof a heap dump can be downloaded.
    expect(checks.find((c) => c.name === "exposed-actuator-critical")).toBeUndefined();
    expect(checks.find((c) => c.name === "exposed-actuator-endpoints")?.items?.map((i) => i.meta?.endpoint)).toEqual([
      "index",
    ]);
    const warn = checks.find((c) => c.name === "exposed-actuator-heapdump");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.map((i) => i.meta?.endpoint)).toEqual(["heapdump"]);
    // Not requested, so not checked either: a heap dump found by an earlier aggressive run stays open.
    expect(checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked")?.skipReason).toBe(
      "probe-level-too-low"
    );
    expect(warn?.items?.find((i) => i.id === `${BASE}/actuator/heapdump`)?.meta).toMatchObject({
      endpoint: "heapdump",
      evidence: "listed-in-index",
      severity: "warning",
      confidence: "lower",
    });
  });

  test("an open index limits the requests to the endpoints it lists", async () => {
    const { checks, sent } = await run(
      {
        [`${BASE}/actuator`]: () => json(INDEX(`${BASE}/actuator`, ["health", "env", "info"])),
        [`${BASE}/actuator/env`]: () => json(ENV),
      },
      { level: "aggressive" }
    );
    // The heapdump is asked for whatever the index lists: it passes only on its own answer.
    expect(paths(sent)).toEqual(["GET /actuator", "GET /actuator/env", "GET /actuator/heapdump"]);
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

  test("robots.txt disallowing every actuator path: nothing sent, not checked, and a prior critical finding is not cleared", async () => {
    const { sent, checks } = await run({}, { robotsTxt: robots(["/actuator"]) });
    expect(sent).toHaveLength(0);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toMatchObject({ name: "exposed-actuator-heapdump-not-checked", status: "skipped" });
    expect(checks[0]).toMatchObject({
      name: "exposed-actuator-not-checked",
      status: "skipped",
      skipReason: "robots-disallowed",
      details: { skippedRobots: 4, probed: 0 },
    });
    // The clean check is the only one that clears a prior finding; a skipped run clears nothing.
    const clean = exposedActuatorRule.meta.checks?.find((c) => c.name === "exposed-actuator");
    expect(clean?.clears).toEqual(["exposed-actuator-critical", "exposed-actuator-endpoints"]);
    expect(checks.some((c) => c.name === "exposed-actuator")).toBe(false);
    const notChecked = exposedActuatorRule.meta.checks?.find((c) => c.name === checks[0]!.name);
    expect(notChecked).toMatchObject({ outcome: "skipped" });
    expect((notChecked as { clears?: string[] } | undefined)?.clears).toBeUndefined();
  });

  test("a rate-limited (429) or WAF-challenged answer is not checked, never a pass, and probing stops", async () => {
    const challenge = () =>
      new Response("<html><head><title>Just a moment...</title></head></html>", {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      });
    const limited = () => json({ error: "Too Many Requests" }, 429);
    for (const route of [limited, challenge]) {
      const routes = Object.fromEntries(ACTUATOR_ENDPOINTS.map((e) => [`${BASE}/actuator${e.path}`, route]));
      const { checks, sent } = await run(routes);
      expect(sent).toHaveLength(1);
      expect(checks).toHaveLength(2);
      expect(clearedBy(checks)).toEqual([]);
      expect(checks[0]).toMatchObject({
        name: "exposed-actuator-not-checked",
        status: "skipped",
        skipReason: "probe-incomplete",
        details: { throttled: true },
      });
      restore?.();
    }
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
    const critical = checks.find((c) => c.name === "exposed-actuator-heapdump");
    expect(critical?.status).toBe("fail");
    expect(critical?.details?.severity).toBe("critical");
    expect(critical?.items?.map((i) => [i.id, i.meta?.evidence])).toEqual([
      [`${origin}/actuator/heapdump`, "hprof-header"],
    ]);
    expect(JSON.stringify(checks)).not.toContain("JAVA PROFILE");
  }, 30_000);

  test("a server that hangs on unknown paths: one timeout ends the base, not checked, bounded by one request timeout", async () => {
    const seen: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new URL(req.url).pathname);
        return new Promise<Response>(() => {});
      },
    });
    const started = Date.now();
    const { checks } = await exposedActuatorRule.run(serverCtx(`http://localhost:${server.port}`, "active"));
    const elapsed = Date.now() - started;
    expect(seen).toEqual(["/actuator"]);
    expect(elapsed).toBeLessThan(ACTUATOR_PROBE_TIMEOUT_MS + 3_000);
    expect(checks).toHaveLength(2);
    expect(clearedBy(checks)).toEqual([]);
    expect(checks[0]).toMatchObject({
      name: "exposed-actuator-not-checked",
      status: "skipped",
      details: { timedOutBases: 1 },
    });
  }, 30_000);

  test("the rule's total time budget ends the run: bases not reached are not checked", async () => {
    // The worst case at the defaults: one request timeout per base, capped by the total.
    expect(ACTUATOR_TOTAL_BUDGET_MS).toBe(MAX_ACTUATOR_BASES * ACTUATOR_PROBE_TIMEOUT_MS);
    const seen: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new URL(req.url).pathname);
        return new Promise<Response>(() => {});
      },
    });
    const ctx = serverCtx(`http://localhost:${server.port}`, "active");
    ctx.endpointSurface = surface(
      ["/a", "/b"].map((p) => candidate(`http://localhost:${server.port}${p}/actuator/health`, { method: "GET", sameOrigin: true, probeEligible: true }))
    );
    const started = Date.now();
    const { checks } = await runExposedActuator(ctx, { requestTimeoutMs: 400, totalBudgetMs: 600 });
    const elapsed = Date.now() - started;
    // /a times out at 400 ms and ends its base; /b is cut at the 600 ms total; /actuator is never reached.
    expect(seen).toEqual(["/a/actuator", "/b/actuator"]);
    expect(elapsed).toBeLessThan(2_000);
    expect(checks).toHaveLength(2);
    expect(clearedBy(checks)).toEqual([]);
    expect(checks[0]).toMatchObject({
      name: "exposed-actuator-not-checked",
      status: "skipped",
      skipReason: "probe-incomplete",
      details: { timeStopped: true, timedOutBases: 1, bases: 3 },
    });
  }, 30_000);

  test("a base that times out ends only that base; a clean answer elsewhere still leaves the run not checked", async () => {
    const seen: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        seen.push(pathname);
        if (pathname.startsWith("/a/")) return new Promise<Response>(() => {});
        return new Response("Not Found", { status: 404 });
      },
    });
    const ctx = serverCtx(`http://localhost:${server.port}`, "active");
    ctx.endpointSurface = surface([
      candidate(`http://localhost:${server.port}/a/actuator/health`, { method: "GET", sameOrigin: true, probeEligible: true }),
    ]);
    const { checks } = await runExposedActuator(ctx, { requestTimeoutMs: 300, totalBudgetMs: 10_000 });
    expect(seen).toEqual(["/a/actuator", "/actuator", "/actuator/env", "/actuator/configprops", "/actuator/mappings"]);
    expect(checks.map((c) => [c.name, c.skipReason])).toEqual([
      ["exposed-actuator-not-checked", "probe-incomplete"],
      ["exposed-actuator-heapdump-not-checked", "probe-level-too-low"],
    ]);
  }, 30_000);

  test("an SPA fixture that answers every path with its 200 shell: no finding", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response("<!doctype html><div id=app></div>", { headers: { "content-type": "text/html" } }),
    });
    const { checks } = await exposedActuatorRule.run(serverCtx(`http://localhost:${server.port}`, "aggressive"));
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["exposed-actuator", "pass"],
      ["exposed-actuator-heapdump-not-checked", "skipped"],
    ]);
  });
});

// ── pub#1878 round 2: a pass clears only what the run requested and got a definite answer for ──

/** The problem check names this run's clean checks clear (what a comparison marks fixed). */
function clearedBy(checks: CheckResult[]): string[] {
  const decls = exposedActuatorRule.meta.checks ?? [];
  return checks
    .filter((c) => c.status === "pass")
    .flatMap((c) => decls.find((d) => d.name === c.name && d.outcome === "clean")?.clears ?? []);
}

/** The check name an earlier run's heapdump finding was filed under. */
function heapdumpFindingCheck(checks: CheckResult[]): string {
  const c = checks.find((x) => x.items?.some((i) => i.meta?.endpoint === "heapdump"));
  expect(c).toBeDefined();
  return c!.name;
}

const HPROF = () =>
  new Response(new TextEncoder().encode("JAVA PROFILE 1.0.2\0rest"), {
    status: 206,
    headers: { "content-type": "application/octet-stream" },
  });

describe("security/exposed-actuator: a pass clears only what was checked", () => {
  test("robots.txt disallowing only /actuator/env: no pass, env reported not checked", async () => {
    const { checks, sent } = await run({}, { robotsTxt: robots(["/actuator/env"]) });
    expect(paths(sent)).toEqual(["GET /actuator", "GET /actuator/configprops", "GET /actuator/mappings"]);
    expect(checks.some((c) => c.name === "exposed-actuator")).toBe(false);
    expect(clearedBy(checks)).toEqual([]);
    const nc = checks.find((c) => c.name === "exposed-actuator-not-checked");
    expect(nc).toMatchObject({ status: "skipped", skipReason: "robots-disallowed", details: { skippedRobots: 1 } });
    expect(nc?.message).toContain(`${BASE}/actuator/env`);
  });

  test("an aggressive run finds a heap dump; a later active run does not clear it", async () => {
    const first = await run({ [`${BASE}/actuator/heapdump`]: HPROF }, { level: "aggressive" });
    const findingCheck = heapdumpFindingCheck(first.checks);
    restore?.();
    // The site is otherwise closed: every actuator path is a 404.
    const later = await run({});
    expect(later.sent.some((r) => r.url.includes("heapdump"))).toBe(false);
    expect(clearedBy(later.checks)).not.toContain(findingCheck);
    expect(later.checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked")).toMatchObject({
      status: "skipped",
      skipReason: "probe-level-too-low",
    });
    // The other endpoints were all answered, so their own pass still stands.
    expect(later.checks.find((c) => c.name === "exposed-actuator")?.status).toBe("pass");
  });

  test("aggressive: a definite 404, 401 or 403 for heapdump clears it; a 200 without the header or a 5xx does not", async () => {
    for (const status of [404, 401, 403]) {
      const { checks, sent } = await run(
        { [`${BASE}/actuator/heapdump`]: () => json({ error: "x" }, status) },
        { level: "aggressive" }
      );
      expect(sent.some((r) => r.url.endsWith("/actuator/heapdump"))).toBe(true);
      expect(checks.find((c) => c.name === "exposed-actuator-heapdump-closed")?.status).toBe("pass");
      expect(clearedBy(checks)).toContain("exposed-actuator-heapdump");
      restore?.();
    }
    for (const route of [() => html("<!doctype html><div id=root></div>", 200), () => json({}, 503)]) {
      const { checks } = await run({ [`${BASE}/actuator/heapdump`]: route }, { level: "aggressive" });
      expect(clearedBy(checks)).not.toContain("exposed-actuator-heapdump");
      expect(checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked")?.status).toBe("skipped");
      restore?.();
    }
  });

  test("aggressive: an open index that does not list heapdump still gets it requested before it can pass", async () => {
    const { checks, sent } = await run(
      { [`${BASE}/actuator`]: () => json(INDEX(`${BASE}/actuator`, ["health"])) },
      { level: "aggressive" }
    );
    // INDEX always carries `env-toMatch`, so env is listed and asked for too.
    expect(paths(sent)).toEqual(["GET /actuator", "GET /actuator/env", "GET /actuator/heapdump"]);
    expect(checks.find((c) => c.name === "exposed-actuator-heapdump-closed")?.status).toBe("pass");
  });

  test("a server error (503) on one path: that path is not checked and nothing is cleared", async () => {
    const { checks } = await run({ [`${BASE}/actuator/env`]: () => json({ error: "busy" }, 503) });
    expect(clearedBy(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "exposed-actuator-not-checked")).toMatchObject({
      status: "skipped",
      skipReason: "probe-incomplete",
    });
  });

  test("throttled partway through an aggressive run: neither family is cleared", async () => {
    const { checks, sent } = await run(
      { [`${BASE}/actuator/configprops`]: () => json({ error: "Too Many Requests" }, 429) },
      { level: "aggressive" }
    );
    expect(paths(sent)).toEqual(["GET /actuator", "GET /actuator/env", "GET /actuator/configprops"]);
    expect(clearedBy(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "exposed-actuator-not-checked")?.skipReason).toBe("probe-incomplete");
    expect(checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked")?.skipReason).toBe(
      "probe-incomplete"
    );
  });

  test("a base that times out on an aggressive run: its endpoints, heapdump included, are not checked and nothing is cleared", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/a/")) return new Promise<Response>(() => {});
        return new Response("Not Found", { status: 404 });
      },
    });
    const origin = `http://localhost:${server.port}`;
    const ctx = serverCtx(origin, "aggressive");
    ctx.endpointSurface = surface([
      candidate(`${origin}/a/actuator/health`, { method: "GET", sameOrigin: true, probeEligible: true }),
    ]);
    const { checks } = await runExposedActuator(ctx, { requestTimeoutMs: 300, totalBudgetMs: 10_000 });
    expect(clearedBy(checks)).toEqual([]);
    const hd = checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked");
    expect(hd).toMatchObject({ status: "skipped", skipReason: "probe-incomplete" });
    expect(hd?.message).toContain(`${origin}/a/actuator/heapdump`);
    expect(checks.find((c) => c.name === "exposed-actuator-not-checked")?.message).toContain(`${origin}/a/actuator/env`);
    }, 30_000);
});

describe("security/exposed-actuator: at most one heap dump per run", () => {
  test("two bases that both serve an HPROF header get exactly one /heapdump request", async () => {
    const { checks, sent } = await run(
      { [`${BASE}/manage/actuator/heapdump`]: HPROF, [`${BASE}/actuator/heapdump`]: HPROF },
      { level: "aggressive", surface: surface([candidate("/manage/actuator/health", { method: "GET" })]) }
    );
    expect(sent.filter((r) => r.url.endsWith("/heapdump")).map((r) => r.url)).toEqual([
      `${BASE}/manage/actuator/heapdump`,
    ]);
    expect(checks.find((c) => c.name === "exposed-actuator-heapdump")).toMatchObject({ status: "fail" });
    const nc = checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked");
    expect(nc).toMatchObject({ status: "skipped", skipReason: "probe-incomplete" });
    expect(nc?.message).toContain(`${BASE}/actuator/heapdump (not requested: a heap dump was already confirmed`);
    expect(clearedBy(checks)).not.toContain("exposed-actuator-heapdump");
  });

  test("a hanging /heapdump on base one means zero /heapdump requests on base two, and is never closed", async () => {
    const seen: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        seen.push(pathname);
        if (pathname === "/a/actuator/heapdump") return new Promise<Response>(() => {});
        return new Response("Not Found", { status: 404 });
      },
    });
    const origin = `http://localhost:${server.port}`;
    const ctx = serverCtx(origin, "aggressive");
    ctx.endpointSurface = surface([
      candidate(`${origin}/a/actuator/health`, { method: "GET", sameOrigin: true, probeEligible: true }),
    ]);
    const { checks } = await runExposedActuator(ctx, { requestTimeoutMs: 300, totalBudgetMs: 10_000 });
    expect(seen.filter((p) => p.endsWith("/heapdump"))).toEqual(["/a/actuator/heapdump"]);
    // Base two's other endpoints are still asked for.
    expect(seen).toContain("/actuator/env");
    expect(clearedBy(checks)).not.toContain("exposed-actuator-heapdump");
    expect(checks.some((c) => c.name === "exposed-actuator-heapdump-closed")).toBe(false);
    const nc = checks.find((c) => c.name === "exposed-actuator-heapdump-not-checked");
    expect(nc).toMatchObject({ status: "skipped", skipReason: "probe-incomplete" });
    expect(nc?.message).toContain(
      `${origin}/a/actuator/heapdump (the request timed out; an open endpoint may have started writing a dump)`
    );
    expect(nc?.message).toContain(`${origin}/actuator/heapdump (not requested: an earlier heapdump request timed out`);
  }, 30_000);
});
