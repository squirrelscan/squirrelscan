// security/debug-endpoints (squirrelscan#2323): probes a curated list plus
// matching discovered endpoints with anonymous GETs, only when quiet probes are
// allowed, same origin only, and flags an answer only by the shape of the
// internal state it discloses. Values never reach a finding.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import type { CheckResult } from "../src/types";

import {
  classifyDebugResponse,
  DEBUG_ENDPOINT_PATHS,
  debugEndpointsRule,
  MAX_DISCOVERED_DEBUG_ENDPOINTS,
  selectDebugEndpoints,
} from "../src/security/debug-endpoints";
import { clearRequestAsync, setRequestAsync } from "../src/tools";
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
beforeAll(() => setRequestAsync(() => Promise.reject(new Error("unused"))));
afterAll(() => clearRequestAsync());

const SECRET = "pg-s3cr3t-value-9f2c";
const PRIVATE_IP = "10.20.30.40";

const text = (body: string, status = 200, contentType = "text/plain") =>
  new Response(body, { status, headers: { "content-type": contentType } });

const ENV_JSON = {
  NODE_ENV: "production",
  DATABASE_URL: `postgres://app:${SECRET}@${PRIVATE_IP}:5432/app`,
  STRIPE_SECRET_KEY: SECRET,
  PORT: "3000",
};

const PROMETHEUS = [
  "# HELP http_requests_total Total requests.",
  "# TYPE http_requests_total counter",
  'http_requests_total{method="get",code="200"} 1027',
  "# TYPE process_resident_memory_bytes gauge",
  "process_resident_memory_bytes 2.5e+07",
].join("\n");

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {}
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const { checks } = await debugEndpointsRule.run(ruleCtx(ctxOpts));
  return { checks, sent: stub.sent };
}

const names = (checks: CheckResult[]) => checks.map((c) => [c.name, c.status]);

describe("security/debug-endpoints: classification", () => {
  const site = "example.com";
  const classes = (body: string, contentType = "application/json") =>
    classifyDebugResponse({ body, contentType }, site).map((l) => l.class);

  test("a bare health check is not a finding", () => {
    expect(classes(JSON.stringify({ status: "ok" }))).toEqual([]);
    expect(
      classes(
        JSON.stringify({
          status: "UP",
          version: "10.1.0.3",
          uptime: 1234,
          components: {
            db: { status: "UP", details: { database: "PostgreSQL" } },
          },
        })
      )
    ).toEqual([]);
    expect(classes("OK", "text/plain")).toEqual([]);
  });

  test("an HTML page (SPA shell, error page) is never read", () => {
    const shell = `<!doctype html><script>var e=${JSON.stringify(ENV_JSON)}</script>`;
    expect(classes(shell, "text/html")).toEqual([]);
    expect(classes(shell, "text/plain")).toEqual([]);
    // Served as HTML, even a body that does not open with a tag is not read.
    expect(
      classes("NODE_ENV=production\nAPI_TOKEN=abcd1234\nPORT=1\n", "text/html")
    ).toEqual([]);
  });

  test("environment variables, as JSON or dotenv lines", () => {
    expect(classes(JSON.stringify({ env: ENV_JSON }))).toEqual([
      "env-vars",
      "config-secrets",
      "internal-hosts",
    ]);
    const dotenv =
      "NODE_ENV=production\nAPI_TOKEN=abcd1234\nexport PORT=8080\n";
    expect(classes(dotenv, "text/plain")).toEqual(["env-vars"]);
  });

  test("constant-case keys without a known or credential name are not env vars", () => {
    const i18n = {
      WELCOME_TITLE: "Hi",
      SUBMIT_BUTTON: "Go",
      CANCEL_LINK: "No",
    };
    expect(classes(JSON.stringify(i18n))).toEqual([]);
  });

  test("config secrets under named fields; placeholders and public keys are not", () => {
    expect(
      classes(
        JSON.stringify({ db: { host: "db.example.com", password: SECRET } })
      )
    ).toEqual(["config-secrets"]);
    for (const placeholder of [
      "****",
      "[REDACTED]",
      `\${DB_PASSWORD}`,
      "<hidden>",
      "",
    ]) {
      expect(
        classes(
          JSON.stringify({ db: { password: placeholder, clientSecret: "x" } })
        )
      ).toEqual([]);
    }
    expect(
      classes(
        JSON.stringify({
          stripe: { publishableKey: "pk_live_abc", publicSecret: "yes-public" },
        })
      )
    ).toEqual([]);
  });

  test("a connection URL with credentials is a config secret", () => {
    expect(
      classes(
        JSON.stringify({
          cache: "redis://user:hunter22@cache.example.com:6379",
        })
      )
    ).toEqual(["config-secrets"]);
  });

  test("internal hosts: private IPs, internal zones, dotless service names; not loopback or versions", () => {
    expect(classes(JSON.stringify({ upstream: `${PRIVATE_IP}:8080` }))).toEqual(
      ["internal-hosts"]
    );
    expect(
      classes(JSON.stringify({ db: "pg-0.db.svc.cluster.local:5432" }))
    ).toEqual(["internal-hosts"]);
    expect(classes(JSON.stringify({ api: "http://billing:8080/v1" }))).toEqual([
      "internal-hosts",
    ]);
    expect(
      classes(
        JSON.stringify({
          cache: "127.0.0.1:6379",
          bind: "0.0.0.0",
          self: "https://example.com/",
          cdn: "203.0.113.9",
          version: "10.1.0.3",
        })
      )
    ).toEqual([]);
  });

  test("internal hosts are not judged when the audited site is itself private", () => {
    const leaks = classifyDebugResponse(
      {
        body: JSON.stringify({ upstream: PRIVATE_IP }),
        contentType: "application/json",
      },
      null
    );
    expect(leaks).toEqual([]);
  });

  test("Prometheus text format, counted by metric family", () => {
    const leaks = classifyDebugResponse(
      { body: PROMETHEUS, contentType: "text/plain; version=0.0.4" },
      site
    );
    expect(leaks).toEqual([{ class: "prometheus-metrics", count: 2 }]);
    // A version label that looks like an address is not a host.
    const labelled = `${PROMETHEUS}\nbuild_info{version="10.2.3.4"} 1\nup{instance="${PRIVATE_IP}:9100"} 1\n`;
    expect(
      classifyDebugResponse({ body: labelled, contentType: "text/plain" }, site)
    ).toEqual([
      { class: "internal-hosts", count: 1 },
      { class: "prometheus-metrics", count: 2 },
    ]);
  });

  test("Go expvar is runtime state", () => {
    expect(
      classes(
        JSON.stringify({ cmdline: ["/app/server"], memstats: { Alloc: 1 } })
      )
    ).toEqual(["runtime-state"]);
  });

  test("a long run of the tokenizer's trigger stays linear", () => {
    const run = (n: number) => {
      const body = "a-".repeat(n) + "." + "1.".repeat(n);
      const t = performance.now();
      classifyDebugResponse({ body, contentType: "text/plain" }, site);
      return performance.now() - t;
    };
    run(1000);
    const small = run(25_000);
    const big = run(100_000);
    expect(big).toBeLessThan(Math.max(small, 5) * 20);
  });
});

describe("security/debug-endpoints: selection", () => {
  test("curated list first, then same-origin GET discovered candidates whose path names a debug endpoint", () => {
    const sel = selectDebugEndpoints(
      ruleCtx({
        surface: surface([
          candidate("/internal/config", { method: "GET" }),
          candidate("/v2/metrics.json", { method: undefined }),
          candidate("/api/users", { method: "GET" }),
          candidate("https://other.example.com/debug", { method: "GET" }),
          candidate("/api/config/delete", { method: "GET" }),
          candidate("/admin/config", { method: "POST" }),
          candidate("/graphql/debug", { method: "GET" }),
          candidate("/mgmt/actuator/env", { method: "GET" }),
          candidate("/api/debug?x=1", { method: "GET" }),
        ]),
      })
    );
    const urls = sel.endpoints.map((e) => e.url);
    expect(urls.slice(0, DEBUG_ENDPOINT_PATHS.length)).toEqual(
      DEBUG_ENDPOINT_PATHS.map((p) => `${BASE}${p}`)
    );
    expect(sel.endpoints.slice(DEBUG_ENDPOINT_PATHS.length)).toEqual([
      {
        url: `${BASE}/internal/config`,
        source: "discovered",
        discoveredVia: "fetch",
      },
      {
        url: `${BASE}/v2/metrics.json`,
        source: "discovered",
        discoveredVia: "fetch",
      },
    ]);
    expect(sel.skippedStateChanging).toBe(2);
    expect(urls.every((u) => new URL(u).origin === BASE)).toBe(true);
  });

  test("discovered endpoints are capped", () => {
    const many = Array.from(
      { length: MAX_DISCOVERED_DEBUG_ENDPOINTS + 2 },
      (_, i) => candidate(`/svc${i}/health`, { method: "GET" })
    );
    const sel = selectDebugEndpoints(ruleCtx({ surface: surface(many) }));
    expect(sel.endpoints).toHaveLength(
      DEBUG_ENDPOINT_PATHS.length + MAX_DISCOVERED_DEBUG_ENDPOINTS
    );
    expect(sel.skippedCap).toBe(2);
  });
});

describe("security/debug-endpoints: probing", () => {
  test("passive or no probe budget: not checked, nothing sent", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run(
        { [`${BASE}/api/env`]: () => json(ENV_JSON) },
        opts
      );
      expect(sent).toHaveLength(0);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        name: "debug-endpoints-not-checked",
        status: "skipped",
        skipReason: "probe-level-too-low",
      });
      restore?.();
    }
  });

  test("analyze (no request tool) sends nothing", async () => {
    clearRequestAsync();
    try {
      const { checks, sent } = await run({});
      expect(sent).toHaveLength(0);
      expect(checks[0]).toMatchObject({ skipReason: "analyze-offline" });
    } finally {
      setRequestAsync(() => Promise.reject(new Error("unused")));
    }
  });

  test("only anonymous same-origin GETs, no redirect followed", async () => {
    const { checks, sent } = await run(
      {},
      { surface: surface([candidate("/ops/diagnostics", { method: "GET" })]) }
    );
    expect(sent.map((r) => r.url)).toEqual([
      ...DEBUG_ENDPOINT_PATHS.map((p) => `${BASE}${p}`),
      `${BASE}/ops/diagnostics`,
    ]);
    for (const r of sent) {
      expect(r.method).toBe("GET");
      expect(r.credentials).toBe("omit");
      expect(r.redirect).toBe("manual");
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
    expect(names(checks)).toEqual([["debug-endpoints-none", "pass"]]);
  });

  test("leaking endpoints are flagged with the class and no value; a bare health check is not", async () => {
    const { checks } = await run({
      [`${BASE}/api/env`]: () => json(ENV_JSON),
      [`${BASE}/metrics`]: () => text(PROMETHEUS),
      [`${BASE}/healthz`]: () => json({ status: "ok" }),
      [`${BASE}/health`]: () => json({ status: "ok" }),
    });
    expect(names(checks)).toEqual([
      ["debug-endpoint-exposed", "fail"],
      ["debug-endpoint-exposed", "warn"],
    ]);
    const [env, metrics] = checks;
    expect(env!.items?.[0]?.id).toBe(`${BASE}/api/env`);
    expect(env!.message).toContain("environment variables");
    expect(env!.message).toContain("DATABASE_URL");
    expect(env!.details).toMatchObject({
      classes: ["env-vars", "config-secrets", "internal-hosts"],
    });
    expect(metrics!.items?.[0]?.id).toBe(`${BASE}/metrics`);
    expect(metrics!.message).toContain("Prometheus metrics");
    const serialized = JSON.stringify(checks);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PRIVATE_IP);
    expect(serialized).not.toContain("production");
  });

  test("a catch-all JSON answer is one finding, not one per path", async () => {
    const routes = Object.fromEntries(
      DEBUG_ENDPOINT_PATHS.map((p) => [`${BASE}${p}`, () => json(ENV_JSON)])
    );
    const { checks } = await run(routes);
    expect(names(checks)).toEqual([["debug-endpoint-exposed", "fail"]]);
    expect(checks[0]!.items?.[0]?.meta?.alsoAt).toHaveLength(
      DEBUG_ENDPOINT_PATHS.length - 1
    );
  });

  test("redirects, 401, 403 and 404 are answered, not exposed", async () => {
    const { checks } = await run({
      [`${BASE}/api/env`]: () =>
        new Response(JSON.stringify(ENV_JSON), {
          status: 302,
          headers: { location: "/login", "content-type": "application/json" },
        }),
      [`${BASE}/api/config`]: () => json(ENV_JSON, 401),
      [`${BASE}/metrics`]: () => text(PROMETHEUS, 403),
    });
    expect(names(checks)).toEqual([["debug-endpoints-none", "pass"]]);
  });

  test("a 5xx leaves that endpoint not checked, never a pass", async () => {
    const { checks } = await run({
      [`${BASE}/metrics`]: () => html("oops", 503),
    });
    expect(names(checks)).toEqual([["debug-endpoints-incomplete", "skipped"]]);
    expect(checks[0]!.skipReason).toBe("probe-incomplete");
  });

  test("a 429 stops the rule; findings before it stand", async () => {
    const { checks, sent } = await run({
      [`${BASE}/api/debug`]: () => json(ENV_JSON),
      [`${BASE}/debug`]: () => text("slow down", 429),
    });
    expect(sent).toHaveLength(2);
    expect(names(checks)).toEqual([
      ["debug-endpoint-exposed", "fail"],
      ["debug-endpoints-incomplete", "skipped"],
    ]);
  });

  test("robots.txt-disallowed paths are skipped below aggressive and requested at aggressive", async () => {
    const opts = { robotsTxt: robots(["/metrics"]) };
    const active = await run({}, opts);
    expect(active.sent.map((r) => new URL(r.url).pathname)).not.toContain(
      "/metrics"
    );
    expect(names(active.checks)).toEqual([
      ["debug-endpoints-incomplete", "skipped"],
    ]);
    restore?.();
    const aggressive = await run({}, { ...opts, level: "aggressive" });
    expect(aggressive.sent.map((r) => new URL(r.url).pathname)).toContain(
      "/metrics"
    );
    expect(names(aggressive.checks)).toEqual([
      ["debug-endpoints-none", "pass"],
    ]);
  });

  test("the shared probe budget bounds the run", async () => {
    let t = 0;
    const { checks, sent } = await run(
      {
        [`${BASE}/api/debug`]: () => {
          t += 2000;
          return json({ status: "ok" });
        },
      },
      { budgetMs: 1000, now: () => t }
    );
    expect(sent).toHaveLength(1);
    expect(names(checks)).toEqual([["debug-endpoints-incomplete", "skipped"]]);
  });
});
