// security/supabase-rls (repo#1959): finds the site's Supabase project and anon
// key in the fetched scripts, sends one HEAD with `Prefer: count=exact` per
// table its code names, and judges exposure from the status and Content-Range
// total only. No row is read: the stub serves a JSON body of secrets on every
// route, and no request is a GET and no body is ever pulled. Loud: only an
// aggressive run sends anything, and only to the project's supabase.co host.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import type { ScriptContentData } from "@squirrelscan/core-contracts";

import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  buildTableProbe,
  classifyTableResponse,
  createSupabaseRlsRule,
  discoverSupabase,
  MAX_TABLE_PROBES,
  readSupabaseJwt,
  tableTargets,
} from "../src/security/supabase-rls";
import type { CheckResult, RuleContext } from "../src/types";

const REF = "abcdefghijklmnopqrst";
const HOST = `${REF}.supabase.co`;
const PUBLIC_IP = "104.18.38.10";
const NOW_MS = Date.UTC(2026, 10, 14);

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2lnbmF0dXJlc2lnbmF0dXJlc2ln`;
}

const ANON = jwt({ iss: "supabase", ref: REF, role: "anon", iat: 1700000000, exp: 2000000000 });
const SERVICE = jwt({
  iss: "supabase",
  ref: REF,
  role: "service_role",
  iat: 1700000000,
  exp: 2000000000,
});

function bundle(body: string): string {
  return `const sb=createClient("https://${HOST}","${ANON}");${body}`;
}

function script(content: string, url = "https://example.com/assets/index.js"): ScriptContentData {
  return {
    url,
    status: 200,
    error: null,
    contentType: "text/javascript",
    sizeBytes: content.length,
    content,
    sourcePages: [],
  };
}

interface Sent {
  url: string;
  host: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  redirect: RequestRedirect | undefined;
}

// Real-looking secrets the stub puts in every response body. None may reach a
// finding, a detail, the serialized result or a log line.
const SECRET_VALUES = [
  "jane.doe@victim-mail.example",
  // Assembled at runtime so no secret-shaped literal sits in the source.
  ["sk", "live", "51HxQzKJv9Bv3s9TqWm2pLx7N"].join("_"),
  "$2b$12$Kx8y1uYvC3eYb0hQ7rQzUu8wq6p0p1n2m3l4k5j6h7g8f9e0d1c2b",
  "+1-415-555-0199",
  "4242424242424242",
];
const SECRET_BODY = JSON.stringify([
  {
    id: "7f9c2a",
    email: SECRET_VALUES[0],
    stripe_key: SECRET_VALUES[1],
    password_hash: SECRET_VALUES[2],
    phone: SECRET_VALUES[3],
    card: SECRET_VALUES[4],
  },
]);

/** Set when anything pulls a stub response body. */
let bodyPulls = 0;

/** A response whose body is the secret JSON, counted if it is ever read. */
function answer(status: number, contentRange?: string): Response {
  const bytes = new TextEncoder().encode(SECRET_BODY);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        bodyPulls++;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (contentRange !== undefined) headers["content-range"] = contentRange;
  return new Response(body, { status, headers });
}

let realFetch: typeof fetch | undefined;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
});

/**
 * Routes keyed by `<host><path>`: the egress guard pins the request to an
 * address and keeps the Host header. Every route, and the fallback, carries the
 * secret JSON body; a GET would get it too.
 */
function stubFetch(routes: Record<string, () => Response>): Sent[] {
  realFetch ??= globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers)) headers[k] = v;
    const u = new URL(url);
    const host = headers.host ?? u.host;
    sent.push({
      url,
      host,
      method: init?.method ?? "GET",
      headers,
      credentials: init?.credentials,
      redirect: init?.redirect,
    });
    const route = routes[`${host}${u.pathname}`];
    return route ? route() : answer(404);
  }) as typeof fetch;
  return sent;
}

// Every console line the rule writes, for the no-values-in-logs check.
const logged: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
  }
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

function expectNoValues(text: string): void {
  for (const value of SECRET_VALUES) expect(text).not.toContain(value);
  expect(text).not.toContain("stripe_key");
  expect(text).not.toContain("password_hash");
}

function ctx(opts: {
  scripts?: ScriptContentData[];
  level?: ProbeLevel;
  noProbe?: boolean;
  externalOff?: boolean;
  budgetMs?: number;
}): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: "https://example.com/",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      scripts: opts.scripts ?? [],
      ...(opts.externalOff ? {} : { externalLinks: [] }),
    },
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({ level: opts.level ?? "aggressive", budgetMs: opts.budgetMs ?? 60_000 }),
    options: {},
  };
}

const rule = createSupabaseRlsRule({ resolve: async () => [PUBLIC_IP], now: () => NOW_MS });

async function run(c: RuleContext): Promise<CheckResult[]> {
  return (await rule.run(c)).checks;
}

describe("discovery (sends nothing)", () => {
  test("pairs the anon JWT with its project and reads the tables the code queries", () => {
    const d = discoverSupabase(
      [
        {
          url: "s.js",
          content: bundle(
            `sb.from("todos").select("*");sb.from('invoices') .select();fetch("/rest/v1/notes?x=1")`,
          ),
        },
      ],
      NOW_MS / 1000,
    );
    expect(d.projects).toHaveLength(1);
    expect(d.projects[0]).toMatchObject({ ref: REF, host: HOST, keyKind: "anon-jwt", key: ANON });
    expect(d.tables).toEqual(["todos", "invoices", "notes"]);
  });

  test("Array.from and Buffer.from with a string are not tables, and rpc is not a table", () => {
    const d = discoverSupabase(
      [
        {
          url: "s.js",
          content: bundle(
            `Array.from("abc");Buffer.from("aGk=").toString();x.from("y");fetch("/rest/v1/rpc/f")`,
          ),
        },
      ],
      NOW_MS / 1000,
    );
    expect(d.tables).toEqual([]);
  });

  test("a service-role key, an expired anon key or a non-Supabase JWT is never used", () => {
    const expired = jwt({ iss: "supabase", ref: REF, role: "anon", exp: 1600000000 });
    const other = jwt({ iss: "https://auth.example.com", ref: REF, role: "anon" });
    for (const key of [SERVICE, expired, other]) {
      const d = discoverSupabase(
        [{ url: "s.js", content: `createClient("https://${HOST}","${key}")` }],
        NOW_MS / 1000,
      );
      expect(d.projects).toHaveLength(0);
    }
    expect(readSupabaseJwt(SERVICE, NOW_MS / 1000)).toEqual({ role: "privileged" });
  });

  test("a publishable key pairs only with the one project its script names", () => {
    const key = "sb_publishable_AbCdEfGhIjKlMnOpQrStUv12";
    const one = discoverSupabase([
      { url: "s.js", content: `createClient("https://${HOST}","${key}")` },
    ]);
    expect(one.projects[0]).toMatchObject({ ref: REF, keyKind: "publishable" });
    const two = discoverSupabase([
      {
        url: "s.js",
        content: `["https://${HOST}","https://zyxwvutsrqponmlkjihg.supabase.co","${key}"]`,
      },
    ]);
    expect(two.projects).toHaveLength(0);
  });

  test("placeholder project URLs are not projects", () => {
    const key = "sb_publishable_AbCdEfGhIjKlMnOpQrStUv12";
    const d = discoverSupabase([
      { url: "s.js", content: `createClient("https://aaaaaaaaaaaaaaaaaaaa.supabase.co","${key}")` },
    ]);
    expect(d.projects).toHaveLength(0);
  });

  test("tables come only from the site's code, deduped and capped per project", () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(tableTargets(many)).toHaveLength(8);
    expect(tableTargets(["todos", "todos"])).toEqual(["todos"]);
    expect(tableTargets([])).toEqual([]);
  });

  test("the probe is a HEAD with a row count on the project host, with the anon key", () => {
    const { url, init } = buildTableProbe(
      { ref: REF, host: HOST, key: ANON, keyKind: "anon-jwt", keySource: "s.js" },
      "profiles",
    );
    expect(url).toBe(`https://${HOST}/rest/v1/profiles`);
    expect(new URL(url).search).toBe("");
    expect(init).toMatchObject({ method: "HEAD", credentials: "omit", redirect: "manual" });
    expect(init.headers).toMatchObject({
      Prefer: "count=exact",
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
    });
    expect(() =>
      buildTableProbe(
        { ref: REF, host: HOST, key: ANON, keyKind: "anon-jwt", keySource: "" },
        "a/b",
      ),
    ).toThrow();
  });

  test("response classification uses only the status and the Content-Range total", () => {
    expect(classifyTableResponse(200, "0-4/5")).toEqual({ kind: "exposed", rows: 5 });
    expect(classifyTableResponse(206, "0-0/120")).toEqual({ kind: "exposed", rows: 120 });
    expect(classifyTableResponse(200, "*/3")).toEqual({ kind: "exposed", rows: 3 });
    expect(classifyTableResponse(200, "*/0").kind).toBe("empty");
    expect(classifyTableResponse(200, "0-0/0").kind).toBe("empty");
    expect(classifyTableResponse(401, null).kind).toBe("protected");
    expect(classifyTableResponse(403, "*/0").kind).toBe("protected");
    expect(classifyTableResponse(404, null).kind).toBe("missing");
    // A 2xx without a usable total, or any other status, is not checked.
    expect(classifyTableResponse(200, null).kind).toBe("other");
    expect(classifyTableResponse(200, "0-4/*").kind).toBe("other");
    expect(classifyTableResponse(200, "bytes 0-4/5x").kind).toBe("other");
    expect(classifyTableResponse(400, "*/9").kind).toBe("other");
    expect(classifyTableResponse(500, "*/9").kind).toBe("other");
    expect(classifyTableResponse(301, "*/9").kind).toBe("other");
  });
});

describe("security/supabase-rls", () => {
  test("a table reporting rows is flagged from its count; no body is read and no value leaks", async () => {
    bodyPulls = 0;
    logged.length = 0;
    const sent = stubFetch({
      [`${HOST}/rest/v1/profiles`]: () => answer(200, "0-0/42"),
      [`${HOST}/rest/v1/todos`]: () => answer(200, "*/0"),
      [`${HOST}/rest/v1/invoices`]: () => answer(401),
    });
    const result = await rule.run(
      ctx({
        scripts: [
          script(
            bundle(
              `sb.from("todos").select("*");sb.from("profiles").select("id");sb.from("invoices").select()`,
            ),
          ),
        ],
      }),
    );
    const checks = result.checks;
    expect(checks).toHaveLength(1);
    const fail = checks[0]!;
    expect(fail.status).toBe("fail");
    expect(fail.message).toContain("profiles");
    expect(fail.message).not.toContain("todos");
    expect(fail.message).not.toContain("invoices");
    expect(fail.items).toHaveLength(1);
    expect(fail.items![0]).toMatchObject({
      id: `${HOST}/rest/v1/profiles`,
      label: "profiles (42 row(s) visible to the anon key)",
      meta: { table: "profiles", rows: 42 },
    });

    // HEAD only: never a GET, never a query string, never a body pulled.
    expect(sent.map((r) => `${r.method} ${r.host}${new URL(r.url).pathname}`)).toEqual([
      `HEAD ${HOST}/rest/v1/todos`,
      `HEAD ${HOST}/rest/v1/profiles`,
      `HEAD ${HOST}/rest/v1/invoices`,
    ]);
    expect(bodyPulls).toBe(0);
    for (const r of sent) {
      expect(new URL(r.url).hostname).toBe(PUBLIC_IP);
      expect(new URL(r.url).search).toBe("");
      expect(r.headers.prefer).toBe("count=exact");
      expect(r.headers.apikey).toBe(ANON);
      expect(r.credentials).toBe("omit");
      expect(r.redirect).toBe("manual");
    }

    // Nothing from the body reaches the finding, its items or details, the
    // serialized rule result the report is built from, or any log line.
    const serialized = JSON.stringify(result);
    expectNoValues(serialized);
    expect(serialized).not.toContain(ANON);
    expectNoValues(logged.join("\n"));
  });

  test("the key's source URL is stored without its query string or fragment", async () => {
    stubFetch({ [`${HOST}/rest/v1/profiles`]: () => answer(200, "0-0/7") });
    const result = await rule.run(
      ctx({
        scripts: [
          script(
            bundle(`sb.from("profiles").select("id")`),
            "https://example.com/assets/index.js?token=SECRET&email=a@b.c#frag",
          ),
        ],
      }),
    );
    const fail = result.checks.find((c) => c.status === "fail")!;
    expect(fail.items![0]!.meta).toMatchObject({
      keySource: "https://example.com/assets/index.js",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("a@b.c");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("#frag");
  });

  test("tables behind RLS (401, 403, a zero total) or missing are not flagged", async () => {
    bodyPulls = 0;
    const sent = stubFetch({
      [`${HOST}/rest/v1/a`]: () => answer(401),
      [`${HOST}/rest/v1/b`]: () => answer(200, "*/0"),
      [`${HOST}/rest/v1/c`]: () => answer(403),
    });
    const result = await rule.run(
      ctx({
        scripts: [
          script(bundle(`sb.from("a").select();sb.from("b").select();fetch("/rest/v1/c");fetch("/rest/v1/d")`)),
        ],
      }),
    );
    expect(sent.every((r) => r.method === "HEAD")).toBe(true);
    expect(bodyPulls).toBe(0);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: "pass" });
    expect(result.checks[0]!.message).toContain("4 table(s) probed in 1 project(s)");
    expect(result.checks[0]!.details).toMatchObject({
      perProject: [{ protected: 2, emptyOrHidden: 1, missing: 1, notChecked: 0 }],
    });
    expectNoValues(JSON.stringify(result));
  });

  test("answers without a usable total are not checked, never a pass", async () => {
    bodyPulls = 0;
    stubFetch({
      [`${HOST}/rest/v1/todos`]: () => answer(200),
      [`${HOST}/rest/v1/notes`]: () => answer(500, "*/7"),
    });
    const result = await rule.run(
      ctx({ scripts: [script(bundle(`sb.from("todos").select();fetch("/rest/v1/notes")`))] }),
    );
    expect(bodyPulls).toBe(0);
    expect(result.checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-inconclusive" });
    expectNoValues(JSON.stringify(result));
  });

  test("no guessed tables: a project whose code names no table sends nothing", async () => {
    const sent = stubFetch({});
    const checks = await run(ctx({ scripts: [script(bundle(""))] }));
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "no-tables-in-code" });
    for (const guess of ["users", "profiles", "orders"]) {
      expect(JSON.stringify(checks)).not.toContain(`/rest/v1/${guess}`);
    }
  });

  test("passive, active or no probe budget: skipped, nothing sent", async () => {
    for (const opts of [
      { level: "passive" as const },
      { level: "active" as const },
      { noProbe: true },
    ]) {
      const sent = stubFetch({ [`${HOST}/rest/v1/todos`]: () => answer(200, "*/5") });
      const checks = await run(
        ctx({ scripts: [script(bundle(`sb.from("todos").select()`))], ...opts }),
      );
      expect(sent).toHaveLength(0);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.status).toBe("skipped");
      expect(checks[0]!.skipReason).toBe(
        opts.level === "active" ? "probing-not-aggressive" : "probing-passive",
      );
      expect(checks[0]!.message).toContain("--probe aggressive");
    }
  });

  test("offline or external requests off: skipped, nothing sent", async () => {
    const sent = stubFetch({ [`${HOST}/rest/v1/todos`]: () => answer(200, "*/5") });
    const checks = await run(
      ctx({ scripts: [script(bundle(`sb.from("todos").select()`))], externalOff: true }),
    );
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "external-requests-off" });
  });

  test("no Supabase anon key on the site: not applicable, nothing sent", async () => {
    const sent = stubFetch({});
    const checks = await run(
      ctx({
        scripts: [script(`createClient("https://${HOST}","${SERVICE}");sb.from("todos").select()`)],
      }),
    );
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "not-applicable" });
  });

  test("table probes are capped across the run", async () => {
    bodyPulls = 0;
    const sent = stubFetch({});
    const tables = Array.from({ length: 12 }, (_, i) => `sb.from("t${i}").select()`).join(";");
    const second = "zyxwvutsrqponmlkjihg";
    const key2 = jwt({ iss: "supabase", ref: second, role: "anon", exp: 2000000000 });
    const checks = await run(
      ctx({
        scripts: [
          script(bundle(tables)),
          script(
            `createClient("https://${second}.supabase.co","${key2}")`,
            "https://example.com/b.js",
          ),
        ],
      }),
    );
    expect(sent).toHaveLength(MAX_TABLE_PROBES);
    expect(sent.every((r) => r.method === "HEAD")).toBe(true);
    expect(bodyPulls).toBe(0);
    expect(new Set(sent.map((r) => r.host))).toEqual(new Set([HOST, `${second}.supabase.co`]));
    expect(checks[0]).toMatchObject({ status: "pass" });
    expect(checks[0]!.details).toMatchObject({ tablesProbed: 10, tablesCapped: 6 });
  });

  test("a project host that resolves to a private address is refused, nothing sent", async () => {
    const sent = stubFetch({ [`${HOST}/rest/v1/todos`]: () => answer(200, "*/5") });
    const privateRule = createSupabaseRlsRule({
      resolve: async () => ["10.0.0.5"],
      now: () => NOW_MS,
    });
    const checks = (
      await privateRule.run(ctx({ scripts: [script(bundle(`sb.from("todos").select()`))] }))
    ).checks;
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-errors" });
  });

  test("a zero probe budget sends nothing and is not a pass", async () => {
    const sent = stubFetch({ [`${HOST}/rest/v1/todos`]: () => answer(200, "*/5") });
    const checks = await run(
      ctx({ scripts: [script(bundle(`sb.from("todos").select()`))], budgetMs: 0 }),
    );
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
  });
});
