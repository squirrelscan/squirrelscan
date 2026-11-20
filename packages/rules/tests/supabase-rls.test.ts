// security/supabase-rls (repo#1959): finds the site's Supabase project and anon
// key in the fetched scripts, sends one HEAD with `Prefer: count=exact` per
// table its code names, and judges exposure from the status and Content-Range
// total only. No row is read: the stub serves a JSON body of secrets on every
// route, and no request is a GET and no body is ever pulled. Loud: only an
// aggressive run sends anything, and only to the project's supabase.co host.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { PROBE_INCOMPLETE_SKIP_REASON, type ScriptContentData } from "@squirrelscan/core-contracts";

import { IgnoreTable } from "../src/ignore";
import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  buildTableProbe,
  classifyTableResponse,
  createSupabaseRlsRule,
  discoverSupabase,
  MAX_PROJECTS,
  MAX_TABLE_PROBES,
  MAX_TABLES_PER_PROJECT,
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
function answer(status: number, contentRange?: string, extra: Record<string, string> = {}): Response {
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
  Object.assign(headers, extra);
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
    // Name order, not the order the code names them in (#2104).
    expect(d.tables).toEqual(["invoices", "notes", "todos"]);
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
    const many = Array.from({ length: MAX_TABLES_PER_PROJECT + 4 }, (_, i) => `t${i}`);
    expect(tableTargets(many)).toHaveLength(MAX_TABLES_PER_PROJECT);
    expect(tableTargets(["todos", "todos"])).toEqual(["todos"]);
    expect(tableTargets([])).toEqual([]);
  });

  test("the caps are 2 projects, 30 tables per project and 40 probes per audit (#2104)", () => {
    // Literal pins: raising a cap makes the rule louder, so it is a reviewed change.
    expect(MAX_PROJECTS).toBe(2);
    expect(MAX_TABLES_PER_PROJECT).toBe(30);
    expect(MAX_TABLE_PROBES).toBe(40);
  });

  test("past the cap, the first tables in code-unit name order are kept, whatever order the code names them", () => {
    expect(tableTargets(["zeta", "Beta", "alpha", "t10", "t2", "_x"])).toEqual([
      "Beta",
      "_x",
      "alpha",
      "t10",
      "t2",
      "zeta",
    ]);
    const names = Array.from({ length: MAX_TABLES_PER_PROJECT + 5 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    const reversed = [...names].reverse();
    expect(tableTargets(reversed)).toEqual(names.slice(0, MAX_TABLES_PER_PROJECT));
  });

  test("discovery is the same whatever order the scripts were fetched in", () => {
    const second = "zyxwvutsrqponmlkjihg";
    const third = "mmmmmmmmmmnnnnnnnnnn";
    const keyFor = (ref: string) => jwt({ iss: "supabase", ref, role: "anon", exp: 2000000000 });
    const sources = [
      { url: "https://example.com/c.js", content: `createClient("https://${second}.supabase.co","${keyFor(second)}");sb.from("orders").select()` },
      { url: "https://example.com/a.js", content: bundle(`sb.from("profiles").select();fetch("/rest/v1/accounts")`) },
      { url: "https://example.com/b.js", content: `createClient("https://${third}.supabase.co","${keyFor(third)}");sb.from("Messages").select()` },
    ];
    const forward = discoverSupabase(sources, NOW_MS / 1000);
    const backward = discoverSupabase([...sources].reverse(), NOW_MS / 1000);
    expect(backward).toEqual(forward);
    // Projects in ref order, the first MAX_PROJECTS (2) probed.
    expect(forward.projects.map((p) => p.ref)).toEqual([REF, third]);
    expect(forward.projectsSkipped).toBe(1);
    expect(forward.tables).toEqual(["Messages", "accounts", "orders", "profiles"]);
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
    // Pushback says nothing about the table: never protected.
    expect(classifyTableResponse(429, "*/0").kind).toBe("throttled");
    expect(classifyTableResponse(403, null, new Headers({ "cf-mitigated": "challenge" })).kind).toBe(
      "throttled",
    );
    expect(classifyTableResponse(200, "*/0", new Headers({ "cf-mitigated": "challenge" })).kind).toBe(
      "throttled",
    );
    // A 2xx without a usable total, or any other status, is not checked.
    expect(classifyTableResponse(200, null).kind).toBe("other");
    expect(classifyTableResponse(200, "0-4/*").kind).toBe("other");
    expect(classifyTableResponse(200, "bytes 0-4/5x").kind).toBe("other");
    expect(classifyTableResponse(400, "*/9").kind).toBe("other");
    expect(classifyTableResponse(500, "*/9").kind).toBe("other");
    expect(classifyTableResponse(301, "*/9").kind).toBe("other");
  });

  test("an HTML 401, 403 or 404 is not a definite answer; JSON or no content type keeps its meaning", () => {
    const html = new Headers({ "content-type": "text/html" });
    const htmlUtf8 = new Headers({ "content-type": "Text/HTML; charset=UTF-8" });
    // A block page (a WAF without cf-mitigated) says nothing about the table.
    expect(classifyTableResponse(403, null, html).kind).not.toBe("protected");
    expect(classifyTableResponse(403, null, html).kind).toBe("other");
    expect(classifyTableResponse(403, null, htmlUtf8).kind).toBe("other");
    expect(classifyTableResponse(401, null, html).kind).toBe("other");
    expect(classifyTableResponse(404, null, html).kind).not.toBe("missing");
    expect(classifyTableResponse(404, null, html).kind).toBe("other");
    // PostgREST's JSON answers keep their meaning (403 is its 42501 refusal).
    const json = new Headers({ "content-type": "application/json; charset=utf-8" });
    expect(classifyTableResponse(403, null, json).kind).toBe("protected");
    expect(classifyTableResponse(401, null, json).kind).toBe("protected");
    expect(classifyTableResponse(404, null, json).kind).toBe("missing");
    // No content type at all is not a block page: unchanged.
    expect(classifyTableResponse(403, null, new Headers()).kind).toBe("protected");
    expect(classifyTableResponse(404, null, new Headers()).kind).toBe("missing");
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
    expect(fail.message).toStartWith(`1 Supabase table(s) in ${HOST} report rows`);
    expect(fail.message).not.toContain("todos");
    expect(fail.message).not.toContain("invoices");
    expect(fail.items).toHaveLength(1);
    expect(fail.items![0]).toMatchObject({
      id: `${HOST}/rest/v1/profiles`,
      label: "profiles",
      snippet: "42 row(s) visible to the anon key",
      meta: { table: "profiles", rows: 42 },
    });

    // HEAD only: never a GET, never a query string, never a body pulled.
    expect(sent.map((r) => `${r.method} ${r.host}${new URL(r.url).pathname}`)).toEqual([
      `HEAD ${HOST}/rest/v1/invoices`,
      `HEAD ${HOST}/rest/v1/profiles`,
      `HEAD ${HOST}/rest/v1/todos`,
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

  test("the key's source URL is stored without userinfo, query string or fragment", async () => {
    for (const source of [
      "https://example.com/assets/index.js?token=SECRET&email=a@b.c#frag",
      "https://user:pass@example.com/assets/index.js?token=SECRET#frag",
    ]) {
      stubFetch({ [`${HOST}/rest/v1/profiles`]: () => answer(200, "0-0/7") });
      const result = await rule.run(
        ctx({ scripts: [script(bundle(`sb.from("profiles").select("id")`), source)] }),
      );
      const fail = result.checks.find((c) => c.status === "fail")!;
      expect(fail.items![0]!.meta).toMatchObject({
        keySource: "https://example.com/assets/index.js",
      });
      const serialized = JSON.stringify(result);
      for (const leak of ["SECRET", "a@b.c", "token=", "#frag", "user", "pass", "@example.com"]) {
        expect(serialized).not.toContain(leak);
      }
    }
  });

  test("[[ignore]] waives a table that is meant to be public by its item id, the rest stay", async () => {
    stubFetch({
      [`${HOST}/rest/v1/profiles`]: () => answer(200, "0-0/42"),
      [`${HOST}/rest/v1/public_posts`]: () => answer(200, "0-0/9"),
    });
    const checks = await run(
      ctx({
        scripts: [script(bundle(`sb.from("profiles").select();sb.from("public_posts").select()`))],
      }),
    );
    expect(checks[0]!.items!.map((i) => i.id)).toEqual([
      `${HOST}/rest/v1/profiles`,
      `${HOST}/rest/v1/public_posts`,
    ]);
    // The squirrel.toml entry the rule page documents: match the item id by table name.
    const waived = new IgnoreTable([
      { rule: "security/supabase-rls", items: ["glob:*/rest/v1/public_posts"], reason: "public by design" },
    ]).filterChecks("security/supabase-rls", undefined, checks);
    expect(waived[0]!.status).toBe("fail");
    expect(waived[0]!.items!.map((i) => i.id)).toEqual([`${HOST}/rest/v1/profiles`]);
    // Waiving every exposed table turns the check into a pass that says so.
    const all = new IgnoreTable([
      {
        rule: "security/supabase-rls",
        items: ["glob:*/rest/v1/public_posts", "glob:*/rest/v1/profiles"],
      },
    ]).filterChecks("security/supabase-rls", undefined, checks);
    expect(all[0]!.status).toBe("pass");
    expect(all[0]!.message).toStartWith("2 waived by squirrel.toml");
  });

  // #2103: a table that is public on purpose is waived by its bare name, in
  // every project, and the remaining finding stops naming it.
  test("[[ignore]] items = [\"posts\"] waives the posts table in every project; glob:*/rest/v1/posts does too", async () => {
    const REF2 = "zyxwvutsrqponmlkjihg";
    const HOST2 = `${REF2}.supabase.co`;
    const ANON2 = jwt({ iss: "supabase", ref: REF2, role: "anon", iat: 1700000000, exp: 2000000000 });
    stubFetch({
      [`${HOST}/rest/v1/posts`]: () => answer(200, "0-0/9"),
      [`${HOST}/rest/v1/profiles`]: () => answer(200, "0-0/42"),
      [`${HOST2}/rest/v1/posts`]: () => answer(200, "0-0/3"),
      [`${HOST2}/rest/v1/profiles`]: () => answer(401),
    });
    const checks = await run(
      ctx({
        scripts: [
          script(bundle(`sb.from("posts").select();sb.from("profiles").select()`)),
          script(
            `const sb2=createClient("https://${HOST2}","${ANON2}");sb2.from("posts").select()`,
            "https://example.com/assets/other.js",
          ),
        ],
      }),
    );
    const fails = checks.filter((c) => c.status === "fail");
    expect(fails.map((c) => c.items!.map((i) => i.id))).toEqual([
      [`${HOST}/rest/v1/posts`, `${HOST}/rest/v1/profiles`],
      [`${HOST2}/rest/v1/posts`],
    ]);

    for (const pattern of ["posts", "glob:*/rest/v1/posts"]) {
      const out = new IgnoreTable(
        [{ rule: "security/supabase-rls", items: [pattern], reason: "posts is public by design" }],
        { messageCountsItems: (id) => id === rule.meta.id && rule.meta.messageCountsItems === true },
      ).filterChecks("security/supabase-rls", undefined, checks);
      const [first, second] = out.filter((c) => c.details?.project !== undefined);
      // Project one: profiles stays reported, posts is gone from the items and the message.
      expect(first!.status).toBe("fail");
      expect(first!.items!.map((i) => i.id)).toEqual([`${HOST}/rest/v1/profiles`]);
      expect(first!.message).toStartWith(`1 Supabase table(s) in ${HOST} report rows`);
      expect(first!.message).not.toContain("posts");
      // Project two: its only exposed table was posts, so the check is waived whole.
      expect(second!.status).toBe("pass");
      expect(second!.items).toBeUndefined();
      expect(second!.message).not.toContain("posts");
    }

    // A bare name is exact: it does not waive a table whose name merely contains it.
    const other = new IgnoreTable([{ rule: "security/supabase-rls", items: ["post"] }]).filterChecks(
      "security/supabase-rls",
      undefined,
      checks,
    );
    expect(other).toBe(checks);
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

  test("external link checking on with zero external links is not off: the table is probed", async () => {
    // `ctx()` gives `externalLinks: []`, what the engine binds when checking ran and the pages link nowhere outside.
    const sent = stubFetch({ [`${HOST}/rest/v1/todos`]: () => answer(401) });
    const checks = await run(ctx({ scripts: [script(bundle(`sb.from("todos").select()`))] }));
    expect(sent).toHaveLength(1);
    expect(checks[0]!.skipReason).not.toBe("external-requests-off");
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

  test("table probes are capped across the run, and a capped run is not a pass", async () => {
    bodyPulls = 0;
    const sent = stubFetch({});
    // Named in reverse, so code order and name order differ.
    const count = MAX_TABLES_PER_PROJECT + 4;
    const names = Array.from({ length: count }, (_, i) => `t${String(i).padStart(3, "0")}`);
    const tables = [...names]
      .reverse()
      .map((n) => `sb.from("${n}").select()`)
      .join(";");
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
    // The first project (by ref) gets the first MAX_TABLES_PER_PROJECT tables
    // by name; the second gets the first ones by name until the per-run cap.
    const secondShare = MAX_TABLE_PROBES - MAX_TABLES_PER_PROJECT;
    expect(sent.map((r) => `${r.host}${new URL(r.url).pathname}`)).toEqual([
      ...names.slice(0, MAX_TABLES_PER_PROJECT).map((n) => `${HOST}/rest/v1/${n}`),
      ...names.slice(0, secondShare).map((n) => `${second}.supabase.co/rest/v1/${n}`),
    ]);
    // 2 projects x `count` code tables planned, MAX_TABLE_PROBES sent and each
    // answered 404 (definite). Left out by a cap: 4 per project past
    // MAX_TABLES_PER_PROJECT, plus the second project's targets past the
    // per-run cap. They could be open, so the run is not checked, never a pass.
    const planned = 2 * count;
    const capped = 2 * 4 + (MAX_TABLES_PER_PROJECT - secondShare);
    expect(planned - MAX_TABLE_PROBES).toBe(capped);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks[0]!.details).toMatchObject({
      tablesProbed: MAX_TABLE_PROBES,
      tablesCapped: capped,
      tablesPlanned: planned,
      tablesChecked: MAX_TABLE_PROBES,
      tablesUnchecked: capped,
    });
    expect(checks[0]!.message).toContain(
      `${MAX_TABLE_PROBES} of ${planned} table probe(s) got a definite answer and ${capped} were left unchecked`,
    );
  });

  test("the same site audited twice, its scripts fetched in another order, probes the same tables", async () => {
    const names = Array.from({ length: MAX_TABLES_PER_PROJECT + 3 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    const half = Math.floor(names.length / 2);
    const scripts = [
      script(bundle(names.slice(half).map((n) => `sb.from("${n}").select()`).join(";")), "https://example.com/z.js"),
      script(names.slice(0, half).map((n) => `sb.from("${n}").select()`).join(";"), "https://example.com/a.js"),
    ];
    const first = stubFetch({});
    await run(ctx({ scripts }));
    const second = stubFetch({});
    await run(ctx({ scripts: [...scripts].reverse() }));
    const paths = (sent: Sent[]) => sent.map((r) => new URL(r.url).pathname);
    expect(paths(first)).toEqual(names.slice(0, MAX_TABLES_PER_PROJECT).map((n) => `/rest/v1/${n}`));
    expect(paths(second)).toEqual(paths(first));
  });

  test("tables past the per-project cap count as unanswered: eight 401s and a ninth never sent is not a pass", async () => {
    bodyPulls = 0;
    const names = Array.from({ length: MAX_TABLES_PER_PROJECT + 1 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    const routes: Record<string, () => Response> = {};
    for (const n of names) routes[`${HOST}/rest/v1/${n}`] = () => answer(401);
    const sent = stubFetch(routes);
    const checks = await run(
      ctx({ scripts: [script(bundle(names.map((n) => `sb.from("${n}").select()`).join(";")))] }),
    );
    // The ninth table is never probed, so it has no answer and may be open.
    expect(sent).toHaveLength(MAX_TABLES_PER_PROJECT);
    expect(sent.some((r) => r.url.endsWith(`/rest/v1/${names[MAX_TABLES_PER_PROJECT]}`))).toBe(false);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks[0]!.message).toContain(`${MAX_TABLES_PER_PROJECT} tables per project`);
    expect(checks[0]!.message).toContain(
      `${MAX_TABLES_PER_PROJECT} of ${MAX_TABLES_PER_PROJECT + 1} table probe(s) got a definite answer and 1 were left unchecked`,
    );
    expect(checks[0]!.details).toMatchObject({
      tablesProbed: MAX_TABLES_PER_PROJECT,
      tablesCapped: 1,
      tablesChecked: MAX_TABLES_PER_PROJECT,
      tablesUnchecked: 1,
    });
  });

  test("a fail cut short by a 429 says how many tables went unchecked", async () => {
    stubFetch({
      [`${HOST}/rest/v1/a`]: () => answer(200, "0-0/5"),
      [`${HOST}/rest/v1/b`]: () => answer(429),
    });
    const checks = await run(
      ctx({
        scripts: [
          script(bundle(`sb.from("d").select();sb.from("c").select();sb.from("b").select();sb.from("a").select()`)),
        ],
      }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    // a answered (exposed), b throttled, c and d never sent: 1 of 4 checked.
    expect(checks[0]!.message).toContain(
      "The list may be incomplete: 1 of 4 table probe(s) got a definite answer and 3 were left unchecked",
    );
    expect(checks[0]!.message).toContain("throttled the probes");
    expect(checks[0]!.details).toMatchObject({ tablesChecked: 1, tablesUnchecked: 3, throttled: true });
  });

  test("a fail past the per-project cap says how many tables went unchecked; a complete fail does not", async () => {
    const names = Array.from({ length: MAX_TABLES_PER_PROJECT + 2 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    stubFetch({ [`${HOST}/rest/v1/${names[0]}`]: () => answer(200, "0-0/1") });
    const capped = await run(
      ctx({ scripts: [script(bundle(names.map((n) => `sb.from("${n}").select()`).join(";")))] }),
    );
    expect(capped).toHaveLength(1);
    expect(capped[0]!.status).toBe("fail");
    expect(capped[0]!.message).toContain(
      `${MAX_TABLES_PER_PROJECT} of ${names.length} table probe(s) got a definite answer and 2 were left unchecked`,
    );
    expect(capped[0]!.message).toContain(`${MAX_TABLES_PER_PROJECT} tables per project`);

    stubFetch({ [`${HOST}/rest/v1/a`]: () => answer(200, "0-0/1") });
    const complete = await run(ctx({ scripts: [script(bundle(`sb.from("a").select();sb.from("b").select()`))] }));
    expect(complete[0]!.status).toBe("fail");
    expect(complete[0]!.message).not.toContain("may be incomplete");
    expect(complete[0]!.details).toMatchObject({ tablesChecked: 2, tablesUnchecked: 0 });
  });

  test("a 401 then 429s: the run stops at the first 429 and is not a pass", async () => {
    const sent = stubFetch({
      [`${HOST}/rest/v1/a`]: () => answer(401),
      [`${HOST}/rest/v1/b`]: () => answer(429),
      [`${HOST}/rest/v1/c`]: () => answer(429),
      [`${HOST}/rest/v1/d`]: () => answer(429),
    });
    const checks = await run(
      ctx({
        scripts: [
          script(bundle(`sb.from("a").select();sb.from("b").select();sb.from("c").select();sb.from("d").select()`)),
        ],
      }),
    );
    // Pushback ends the run: no request after the first 429.
    expect(sent.map((r) => new URL(r.url).pathname)).toEqual(["/rest/v1/a", "/rest/v1/b"]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
    expect(checks[0]!.details).toMatchObject({
      throttled: true,
      perProject: [{ protected: 1, throttled: 1 }],
    });
  });

  test("a bot challenge 403 (cf-mitigated) is not protected and not a pass", async () => {
    const challenge = () => answer(403, undefined, { "cf-mitigated": "challenge" });
    const sent = stubFetch({
      [`${HOST}/rest/v1/a`]: challenge,
      [`${HOST}/rest/v1/b`]: challenge,
      [`${HOST}/rest/v1/c`]: challenge,
    });
    const checks = await run(
      ctx({ scripts: [script(bundle(`sb.from("a").select();sb.from("b").select();sb.from("c").select()`))] }),
    );
    expect(sent).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
    expect(checks[0]!.details).toMatchObject({
      throttled: true,
      perProject: [{ protected: 0, throttled: 1 }],
    });
  });

  for (const status of [403, 404, 401]) {
    test(`a run where every table answers an HTML ${status} block page is not a pass`, async () => {
      const block = () => answer(status, undefined, { "content-type": "text/html; charset=UTF-8" });
      const sent = stubFetch({
        [`${HOST}/rest/v1/a`]: block,
        [`${HOST}/rest/v1/b`]: block,
        [`${HOST}/rest/v1/c`]: block,
      });
      const checks = await run(
        ctx({ scripts: [script(bundle(`sb.from("a").select();sb.from("b").select();sb.from("c").select()`))] }),
      );
      expect(sent).toHaveLength(3);
      expect(checks).toHaveLength(1);
      expect(checks.some((c) => c.status === "pass")).toBe(false);
      expect(checks[0]!.status).toBe("skipped");
      expect(checks[0]!.details).toMatchObject({
        perProject: [{ protected: 0, missing: 0, notChecked: 3 }],
      });
    });
  }

  test("an HTML 403 among JSON answers leaves the run probe-incomplete", async () => {
    stubFetch({
      [`${HOST}/rest/v1/a`]: () => answer(403),
      [`${HOST}/rest/v1/b`]: () => answer(403, undefined, { "content-type": "text/html" }),
    });
    const checks = await run(ctx({ scripts: [script(bundle(`sb.from("a").select();sb.from("b").select()`))] }));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
      details: { perProject: [{ protected: 1, notChecked: 1 }] },
    });
  });

  test("JSON 403 (PostgREST 42501) and JSON 404 answers still pass", async () => {
    stubFetch({
      [`${HOST}/rest/v1/a`]: () => answer(403),
      [`${HOST}/rest/v1/b`]: () => answer(404),
    });
    const checks = await run(ctx({ scripts: [script(bundle(`sb.from("a").select();sb.from("b").select()`))] }));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "pass",
      details: { perProject: [{ protected: 1, missing: 1, notChecked: 0 }] },
    });
  });

  test("a network error on one table makes the run not checked, not a pass", async () => {
    const sent = stubFetch({
      [`${HOST}/rest/v1/a`]: () => answer(401),
      [`${HOST}/rest/v1/b`]: () => {
        throw new TypeError("connection reset");
      },
    });
    const checks = await run(
      ctx({ scripts: [script(bundle(`sb.from("a").select();sb.from("b").select()`))] }),
    );
    expect(sent).toHaveLength(2);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      value: "not-checked",
    });
  });

  test("a planted sb_secret_ key sends nothing and never appears in the result", async () => {
    // Assembled at runtime so no secret-shaped literal sits in the source.
    const secretKey = ["sb", "secret", "Zq8RkL2vNw5TxY7pB3mC9dF4gH6jK1"].join("_");
    const sent = stubFetch({ [`${HOST}/rest/v1/todos`]: () => answer(200, "*/5") });
    const result = await rule.run(
      ctx({
        scripts: [
          script(`const sb=createClient("https://${HOST}","${secretKey}");sb.from("todos").select()`),
        ],
      }),
    );
    expect(sent).toHaveLength(0);
    expect(result.checks.some((c) => c.status === "pass")).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("sb_secret_");
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
    // The cap that stopped it, and how far it got.
    expect(checks[0]!.message).toContain("shared probe time budget");
    expect(checks[0]!.message).toContain("0 of 1 table probe(s)");
  });
});
