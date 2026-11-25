// security/firebase-open-rules (#2325): finds the Firebase database URL and
// project in fetched scripts, then makes one anonymous REST read per target.
// The stub serves secret values in every body; none may reach a result.

import type { ScriptContentData } from "@squirrelscan/core-contracts";

import { afterEach, describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  buildProbe,
  classifyResponse,
  createFirebaseOpenRulesRule,
  discoverFirebase,
  MAX_COLLECTIONS_PER_PROJECT,
  MAX_DATABASES,
  MAX_PATH_NAME_CHARS,
  MAX_PATHS_REPORTED,
  MAX_PROBES,
  redactPaths,
} from "../src/security/firebase-open-rules";

const DB_HOST = "demo-app-default-rtdb.europe-west1.firebasedatabase.app";
const API_KEY = `AIza${"a".repeat(35)}`;
const PROJECT = "demo-app";
const CONFIG = `const cfg={apiKey:"${API_KEY}",projectId:"${PROJECT}",databaseURL:"https://${DB_HOST}"};`;
const PUBLIC_IP = "104.18.38.10";
const SECRET = "jane.doe@victim-mail.example";

function script(
  content: string,
  url = "https://example.com/app.js"
): ScriptContentData {
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
  redirect: RequestRedirect | undefined;
}

let realFetch: typeof fetch | undefined;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
});

function stubFetch(routes: Record<string, () => Response>): Sent[] {
  realFetch ??= globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers)) headers[k] = v;
    const u = new URL(url);
    const host = headers.host ?? u.host;
    sent.push({
      url,
      host,
      method: init?.method ?? "GET",
      headers,
      redirect: init?.redirect,
    });
    const route = routes[`${host}${u.pathname}`];
    return route ? route() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return sent;
}

const json = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });

function ctx(opts: {
  scripts?: ScriptContentData[];
  level?: ProbeLevel;
  noProbe?: boolean;
  externalOff?: boolean;
}): RuleContext {
  return {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: "https://example.com/",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      scripts: opts.scripts ?? [],
      ...(opts.externalOff
        ? {}
        : { externalLinks: [], mayRequestOtherHosts: true }),
    },
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({
          level: opts.level ?? "aggressive",
          budgetMs: 60_000,
        }),
    options: {},
  };
}

const rule = createFirebaseOpenRulesRule({ resolve: async () => [PUBLIC_IP] });
async function run(c: RuleContext): Promise<CheckResult[]> {
  return (await rule.run(c)).checks;
}

describe("discovery (sends nothing)", () => {
  test("reads the database host, project and queried collections", () => {
    const d = discoverFirebase([
      {
        url: "a.js",
        content: `${CONFIG} collection(db,"users"); fs.collection('orders').get()`,
      },
    ]);
    expect(d.databases.map((x) => x.host)).toEqual([DB_HOST]);
    expect(d.projects.map((x) => x.projectId)).toEqual([PROJECT]);
    expect(d.collections).toEqual(["orders", "users"]);
  });

  test("a legacy firebaseio.com URL builds its host", () => {
    const d = discoverFirebase([
      {
        url: "a.js",
        content: `{"databaseURL":"https://my-app.firebaseio.com"}`,
      },
    ]);
    expect(d.databases.map((x) => x.host)).toEqual(["my-app.firebaseio.com"]);
  });

  test("a projectId without a Firebase API key is not a project", () => {
    const d = discoverFirebase([
      { url: "a.js", content: `projectId:"demo-app"` },
    ]);
    expect(d.projects).toEqual([]);
  });

  test("a foreign host in databaseURL is ignored", () => {
    const d = discoverFirebase([
      {
        url: "a.js",
        content: `databaseURL:"https://evil.example.org/x.firebaseio.com"`,
      },
    ]);
    expect(d.databases).toEqual([]);
  });

  test("databases are capped in host order", () => {
    const content = ["c", "a", "d", "b"]
      .map((n) => `databaseURL:"https://${n}-app.firebaseio.com"`)
      .join(";");
    const d = discoverFirebase([{ url: "a.js", content }]);
    expect(d.databases.map((x) => x.host)).toEqual(
      ["a-app", "b-app", "c-app", "d-app"]
        .slice(0, MAX_DATABASES)
        .map((n) => `${n}.firebaseio.com`)
    );
    expect(d.databasesSkipped).toBe(4 - MAX_DATABASES);
  });
});

describe("what is sent", () => {
  test("RTDB probe is a shallow GET with no credentials", () => {
    const { url, init } = buildProbe({ kind: "rtdb", host: DB_HOST });
    expect(url).toBe(`https://${DB_HOST}/.json?shallow=true`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers as object)).toEqual(["User-Agent"]);
  });

  test("Firestore probe masks every field", () => {
    const { url } = buildProbe({
      kind: "firestore",
      projectId: PROJECT,
      collection: "users",
    });
    expect(url).toBe(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users?pageSize=1&mask.fieldPaths=__name__`
    );
  });

  test("a host or collection outside the patterns is refused", () => {
    expect(() =>
      buildProbe({ kind: "rtdb", host: "evil.example.org" })
    ).toThrow();
    expect(() =>
      buildProbe({
        kind: "firestore",
        projectId: PROJECT,
        collection: "a/../b",
      })
    ).toThrow();
  });
});

describe("classification", () => {
  const H = new Headers({ "content-type": "application/json" });
  test("RTDB object of keys is exposed; null, {} are empty; 401 is protected", () => {
    expect(
      classifyResponse("rtdb", 200, H, '{"users":true,"posts":true}')
    ).toEqual({
      kind: "exposed",
      paths: ["posts", "users"],
      redacted: 0,
    });
    expect(classifyResponse("rtdb", 200, H, "null").kind).toBe("empty");
    expect(classifyResponse("rtdb", 200, H, "{}").kind).toBe("empty");
    expect(
      classifyResponse("rtdb", 401, H, '{"error":"Permission denied"}').kind
    ).toBe("protected");
    expect(classifyResponse("rtdb", 404, H, "").kind).toBe("missing");
    expect(classifyResponse("rtdb", 200, H, "true").kind).toBe("other");
    expect(classifyResponse("rtdb", 429, H, "").kind).toBe("throttled");
  });
  test("Firestore listing documents is exposed; {} empty; 403 protected", () => {
    expect(
      classifyResponse("firestore", 200, H, '{"documents":[{"name":"x"}]}').kind
    ).toBe("exposed");
    expect(classifyResponse("firestore", 200, H, "{}").kind).toBe("empty");
    expect(
      classifyResponse(
        "firestore",
        403,
        H,
        '{"error":{"status":"PERMISSION_DENIED"}}'
      ).kind
    ).toBe("protected");
  });
  test("an HTML 403 is not judged", () => {
    expect(
      classifyResponse(
        "rtdb",
        403,
        new Headers({ "content-type": "text/html" }),
        "<html>"
      ).kind
    ).toBe("other");
  });
  test("ids, emails and long names are redacted to a count and the list is bounded", () => {
    const keys = [
      "users",
      SECRET,
      "x".repeat(MAX_PATH_NAME_CHARS + 1),
      ...Array.from(
        { length: MAX_PATHS_REPORTED + 3 },
        (_, i) => `p${String(i).padStart(2, "0")}`
      ),
    ];
    const r = redactPaths(keys);
    expect(r.paths).toHaveLength(MAX_PATHS_REPORTED);
    expect(r.paths).not.toContain(SECRET);
    expect(r.redacted).toBe(keys.length - MAX_PATHS_REPORTED);
  });
});

describe("rule", () => {
  const exposedRoutes = {
    [`${DB_HOST}/.json`]: () => json(`{"users":true,"${SECRET}":true}`),
    "firestore.googleapis.com/v1/projects/demo-app/databases/(default)/documents/users":
      () =>
        json(
          `{"documents":[{"name":"projects/demo-app/documents/users/${SECRET}"}]}`
        ),
  };
  const files = [script(`${CONFIG} collection(db,"users")`)];

  test("flags open RTDB and Firestore, naming paths and never values", async () => {
    const sent = stubFetch(exposedRoutes);
    const checks = await run(ctx({ scripts: files }));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    const labels = checks[0]!.items!.map((i) => i.label);
    expect(labels).toContain("/users");
    expect(labels).toContain("users");
    expect(JSON.stringify(checks)).not.toContain(SECRET);
    expect(
      sent.every((s) => s.method === "GET" && s.redirect === "manual")
    ).toBe(true);
    expect(
      sent.every(
        (s) => !("authorization" in s.headers) && !("cookie" in s.headers)
      )
    ).toBe(true);
    expect(new Set(sent.map((s) => s.host))).toEqual(
      new Set([DB_HOST, "firestore.googleapis.com"])
    );
  });

  test("denied answers pass", async () => {
    stubFetch({
      [`${DB_HOST}/.json`]: () => json('{"error":"Permission denied"}', 401),
      "firestore.googleapis.com/v1/projects/demo-app/databases/(default)/documents/users":
        () => json("{}", 403),
    });
    expect((await run(ctx({ scripts: files })))[0]!.status).toBe("pass");
  });

  test("empty databases pass", async () => {
    stubFetch({
      [`${DB_HOST}/.json`]: () => json("null"),
      "firestore.googleapis.com/v1/projects/demo-app/databases/(default)/documents/users":
        () => json("{}"),
    });
    expect((await run(ctx({ scripts: files })))[0]!.status).toBe("pass");
  });

  test("an unjudgeable answer is not a pass", async () => {
    stubFetch({ [`${DB_HOST}/.json`]: () => json("true") });
    const c = (await run(ctx({ scripts: [script(CONFIG)] })))[0]!;
    expect(c.status).toBe("skipped");
  });

  test("a throttle stops the run as not checked", async () => {
    const sent = stubFetch({
      [`${DB_HOST}/.json`]: () => new Response("", { status: 429 }),
    });
    const c = (await run(ctx({ scripts: files })))[0]!;
    expect(c.status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  test.each([
    ["passive", { level: "passive" as ProbeLevel }, "probing-passive"],
    ["standard", { level: "standard" as ProbeLevel }, "probing-not-aggressive"],
    ["no budget", { noProbe: true }, "probing-passive"],
    ["offline", { externalOff: true }, "external-requests-off"],
  ])("sends nothing when %s", async (_n, opts, reason) => {
    const sent = stubFetch(exposedRoutes);
    const c = (await run(ctx({ scripts: files, ...opts })))[0]!;
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toBe(reason);
    expect(sent).toHaveLength(0);
  });

  test("no Firebase config is not applicable", async () => {
    const sent = stubFetch({});
    const c = (await run(ctx({ scripts: [script("console.log(1)")] })))[0]!;
    expect(c.skipReason).toBe("not-applicable");
    expect(sent).toHaveLength(0);
  });

  test("a project with no collections in code is not probed", async () => {
    const sent = stubFetch({});
    const c = (
      await run(
        ctx({ scripts: [script(`apiKey:"${API_KEY}",projectId:"${PROJECT}"`)] })
      )
    )[0]!;
    expect(c.status).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  test("requests are capped and the cap is reported as not checked", async () => {
    const names = Array.from(
      { length: 30 },
      (_, i) => `c${String(i).padStart(2, "0")}`
    );
    const code = `${CONFIG}${names.map((n) => `collection(db,"${n}");`).join("")}`;
    const sent = stubFetch({});
    const c = (await run(ctx({ scripts: [script(code)] })))[0]!;
    expect(sent.length).toBeLessThanOrEqual(MAX_PROBES);
    expect(sent.length).toBeLessThanOrEqual(1 + MAX_COLLECTIONS_PER_PROJECT);
    expect(c.status).toBe("skipped");
  });

  test("a host resolving to a private address is never requested", async () => {
    const guarded = createFirebaseOpenRulesRule({
      resolve: async () => ["10.0.0.5"],
    });
    const sent = stubFetch(exposedRoutes);
    const c = (await guarded.run(ctx({ scripts: files }))).checks[0]!;
    expect(sent).toHaveLength(0);
    expect(c.status).not.toBe("fail");
  });
});
