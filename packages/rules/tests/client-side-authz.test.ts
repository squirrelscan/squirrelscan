// security/client-side-authz: admin endpoints referenced in the site's own
// JavaScript are probed with one unauthenticated GET each; an answer with data
// is flagged, and a 401/403, a redirect, HTML, an empty or health-shaped body,
// or a 200 that says unauthorized is not. Every test runs the rule fresh
// against a stubbed fetch, so no result is replayed from a cache.

import { afterEach, describe, expect, test } from "bun:test";

import type { ScriptContentData } from "@squirrelscan/core-contracts";

import {
  ADMIN_RESPONSE_CAP,
  buildAdminProbe,
  classifyAdminResponse,
  clientSideAuthzRule,
  findClientRoleChecks,
  isAdminActionPath,
  isPrivilegedPath,
  MAX_ADMIN_ENDPOINTS,
  readExposedData,
  selectAdminCandidates,
} from "../src/security/client-side-authz";
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

const USERS = `${BASE}/api/admin/users`;

/** A JS call site with no stated method (`fetch("/api/admin/users")`). */
function getRef(path: string, over: Parameters<typeof candidate>[1] = {}) {
  return candidate(path, { method: undefined, ...over });
}

function script(url: string, content: string): ScriptContentData {
  return { url, status: 200, error: null, contentType: "text/javascript", sizeBytes: content.length, content, sourcePages: [`${BASE}/`] };
}

async function run(
  routes: Record<string, Route>,
  ctxOpts: Parameters<typeof ruleCtx>[0] = {},
  scripts?: ScriptContentData[]
): Promise<{ checks: CheckResult[]; sent: SentRequest[] }> {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const ctx = ruleCtx(ctxOpts);
  if (scripts) ctx.site = { ...ctx.site!, scripts };
  const { checks } = await clientSideAuthzRule.run(ctx);
  return { checks, sent: stub.sent };
}

const userList = [
  { id: 1, email: "a@example.com", role: "admin", passwordHash: "x" },
  { id: 2, email: "b@example.com", role: "user", passwordHash: "y" },
];

describe("gating: runs only when probing is active or aggressive", () => {
  test("passive sends nothing and records one skipped check", async () => {
    const { checks, sent } = await run({ [USERS]: () => json(userList) }, { level: "passive", surface: surface([getRef("/api/admin/users")]) });
    expect(sent).toHaveLength(0);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "client-side-authz", status: "skipped", skipReason: "probing-passive" });
  });

  test("no probe budget at all sends nothing", async () => {
    const { checks, sent } = await run({ [USERS]: () => json(userList) }, { noProbe: true, surface: surface([getRef("/api/admin/users")]) });
    expect(sent).toHaveLength(0);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("a zero budget sends nothing and is not a pass", async () => {
    const { checks, sent } = await run({ [USERS]: () => json(userList) }, { budgetMs: 0, surface: surface([getRef("/api/admin/users")]) });
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
  });
});

describe("extracting admin endpoints referenced in JS", () => {
  test("privileged path words", () => {
    for (const p of ["/api/admin/users", "/admin/api/stats", "/api/adminUsers", "/api/internal/metrics", "/api/staff/list", "/backoffice/orders", "/api/super-admin"]) {
      expect(isPrivilegedPath(p), p).toBe(true);
    }
    expect(isPrivilegedPath("/api/superadmin")).toBe(true);
    for (const p of ["/api/users", "/api/administrative-areas-of-mars", "/api/badminton", "/api/dashboard"]) {
      expect(isPrivilegedPath(p), p).toBe(false);
    }
  });

  test("action paths are never probed", () => {
    for (const p of ["/api/admin/users/delete", "/api/admin/impersonate", "/api/admin/ban-user", "/api/admin/logout", "/wp-admin/admin-ajax.php", "/api/admin/export"]) {
      expect(isAdminActionPath(p), p).toBe(true);
    }
    expect(isAdminActionPath("/api/admin/users")).toBe(false);
  });

  test("selects same-origin privileged JS references, deduped, query string dropped", () => {
    const sel = selectAdminCandidates(
      ruleCtx({
        surface: surface([
          getRef("/api/admin/users?page=2"),
          getRef("/api/admin/users", { discoveredVia: "axios.get" }),
          getRef("/api/products"),
          getRef("https://other.example/api/admin/users"),
          getRef("/api/admin/health", { source: "convention", discoveredVia: "convention:nextjs" }),
          getRef("/api/admin/stats", { discoveredVia: "string-literal" }),
        ]),
      })
    );
    expect(sel.candidates).toEqual([
      { url: USERS, discoveredVia: "fetch" },
      { url: `${BASE}/api/admin/stats`, discoveredVia: "string-literal" },
    ]);
  });

  test("a candidate whose probeEligible lies about its origin is still refused", () => {
    const sel = selectAdminCandidates(
      ruleCtx({ surface: surface([getRef("https://evil.example/api/admin/users", { sameOrigin: true, probeEligible: true })]) })
    );
    expect(sel.candidates).toEqual([]);
  });

  test("write-only references are skipped; GET anywhere makes the path probeable", () => {
    const sel = selectAdminCandidates(
      ruleCtx({
        surface: surface([
          candidate("/api/admin/settings", { method: "POST" }),
          candidate("/api/admin/settings", { method: "PUT" }),
          candidate("/api/admin/users", { method: "POST" }),
          candidate("/api/admin/users", { method: "GET", discoveredVia: "axios.get" }),
        ]),
      })
    );
    expect(sel.candidates).toEqual([{ url: USERS, discoveredVia: "axios.get" }]);
    expect(sel.skippedWriteOnly).toBe(1);
  });

  test("robots.txt is respected below aggressive, and the endpoint cap holds", () => {
    const refs = Array.from({ length: MAX_ADMIN_ENDPOINTS + 3 }, (_, i) => getRef(`/api/admin/r${i}`));
    const active = selectAdminCandidates(ruleCtx({ surface: surface(refs), robotsTxt: robots(["/api/admin/r0"]) }));
    expect(active.skippedRobots).toBe(1);
    expect(active.candidates).toHaveLength(MAX_ADMIN_ENDPOINTS);
    expect(active.skippedCap).toBe(2);
    const aggressive = selectAdminCandidates(ruleCtx({ level: "aggressive", surface: surface(refs), robotsTxt: robots(["/api/admin/r0"]) }));
    expect(aggressive.skippedRobots).toBe(0);
    expect(aggressive.candidates[0]?.url).toBe(`${BASE}/api/admin/r0`);
  });

  test("client-side role checks are found in same-origin scripts only", () => {
    const ctx = ruleCtx({});
    ctx.site = {
      ...ctx.site!,
      scripts: [
        script(`${BASE}/app.js`, 'if(u.role==="admin"){show()}'),
        script(`${BASE}/b.js`, "const ok = user.roles.includes('admin');"),
        script(`${BASE}/plain.js`, "console.log('administrator manual')"),
        script("https://cdn.example/x.js", "if(isAdmin){}"),
      ],
    };
    expect(findClientRoleChecks(ctx)).toEqual([`${BASE}/app.js`, `${BASE}/b.js`]);
  });
});

describe("what is sent", () => {
  test("one GET per endpoint, no cookies, no redirects, no query string, no body", async () => {
    const { sent } = await run({}, { surface: surface([getRef("/api/admin/users?action=delete&id=1"), getRef("/api/admin/stats")]) });
    expect(sent).toHaveLength(2);
    for (const req of sent) {
      expect(req.method).toBe("GET");
      expect(req.body).toBeNull();
      expect(req.credentials).toBe("omit");
      expect(req.redirect).toBe("manual");
      expect(new URL(req.url).search).toBe("");
      expect(Object.keys(req.headers).some((h) => h === "authorization" || h === "cookie")).toBe(false);
    }
    expect(sent.map((r) => r.url)).toEqual([USERS, `${BASE}/api/admin/stats`]);
  });

  test("buildAdminProbe pins the request", () => {
    const { url, init } = buildAdminProbe(`${USERS}?x=1#frag`);
    expect(url).toBe(USERS);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    expect(init.body).toBeUndefined();
  });

  test("nothing goes to another origin or to a write-only or action path", async () => {
    const { sent } = await run(
      {},
      {
        surface: surface([
          getRef("https://api.other.example/admin/users"),
          candidate("/api/admin/users", { method: "DELETE" }),
          getRef("/api/admin/users/delete"),
          getRef("/api/admin/impersonate"),
        ]),
      }
    );
    expect(sent).toHaveLength(0);
  });
});

describe("verdicts", () => {
  test("an admin API that answers a user list without credentials fails, naming fields, never values", async () => {
    const { checks } = await run(
      { [USERS]: () => json(userList) },
      { surface: surface([getRef("/api/admin/users")]) },
      [script(`${BASE}/app.js`, 'if (user.role === "admin") renderAdmin()')]
    );
    const fail = checks.filter((c) => c.status === "fail");
    expect(fail).toHaveLength(1);
    expect(fail[0]!.message).toContain(USERS);
    expect(fail[0]!.message).toContain("2 records");
    expect(fail[0]!.message).toContain("checks the user's role client-side");
    expect(fail[0]!.message).toContain("cannot show whether one signed-in user can read another's data");
    expect(fail[0]!.items?.[0]?.meta).toMatchObject({ status: 200, records: 2, sensitiveFields: ["email", "role", "passwordHash"] });
    expect(JSON.stringify(fail[0])).not.toContain("a@example.com");
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("401 and 403 are not flagged: the server enforces", async () => {
    const { checks } = await run(
      {
        [USERS]: () => json({ error: "Unauthorized" }, 401),
        [`${BASE}/api/admin/stats`]: () => json({ users: 10, revenue: 5 }, 403),
      },
      { surface: surface([getRef("/api/admin/users"), getRef("/api/admin/stats")]) }
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "pass" });
    expect(checks[0]!.message).toContain("2 refused with 401 or 403");
  });

  test("a 200 whose body says unauthorized is not flagged", () => {
    const r = (body: unknown) => classifyAdminResponse({ status: 200, contentType: "application/json", body: JSON.stringify(body), truncated: false });
    expect(r({ error: "Unauthorized" }).kind).toBe("enforced");
    expect(r({ success: false, message: "Authentication required" }).kind).toBe("enforced");
    expect(r({ authenticated: false, users: [{ id: 1 }] }).kind).toBe("enforced");
    expect(r({ errors: [{ message: "Forbidden" }] }).kind).toBe("enforced");
  });

  test("redirects, HTML shells, 404s, empty and health-shaped answers are not flagged", async () => {
    const { checks } = await run(
      {
        [USERS]: () => new Response(null, { status: 302, headers: { location: "/login" } }),
        [`${BASE}/api/admin/a`]: () => html("<!doctype html><div id=root></div>", 200),
        [`${BASE}/api/admin/b`]: () => json([]),
        [`${BASE}/api/admin/c`]: () => json({ status: "ok", version: "1.2.3" }),
        [`${BASE}/api/admin/d`]: () => json({ data: [], total: 0 }),
        [`${BASE}/api/admin/e`]: () => json({ users: [{ id: 1, email: "x" }] }, 500),
      },
      { surface: surface(["/api/admin/users", "/api/admin/a", "/api/admin/b", "/api/admin/c", "/api/admin/d", "/api/admin/e", "/api/admin/f"].map((p) => getRef(p))) }
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "pass" });
  });

  test("data shapes that count as exposed", () => {
    expect(readExposedData({ users: [{ id: 1, email: "x" }] })?.records).toBe(1);
    expect(readExposedData({ data: { items: [{ id: 1 }, { id: 2 }] } })?.records).toBe(2);
    expect(readExposedData({ totalUsers: 120, mrr: 4000, status: "ok" })?.fields).toEqual(["totalUsers", "mrr"]);
    expect(readExposedData({ id: 1 })).toBeNull();
    expect(readExposedData([null, ""])).toBeNull();
    expect(readExposedData("ok")).toBeNull();
  });

  test("an empty paginated list is not data; a populated one still is", () => {
    const r = (body: unknown) => classifyAdminResponse({ status: 200, contentType: "application/json", body: JSON.stringify(body), truncated: false });
    expect(r({ users: [], total: 0, page: 1, per_page: 20 }).kind).toBe("not-data");
    expect(r({ data: [] }).kind).toBe("not-data");
    expect(r({ items: [], count: 0, limit: 50, offset: 0, next: null, prev: null, cursor: "abc", has_more: false }).kind).toBe("not-data");
    const populated = r({ users: [{ id: 1, email: "a@b.c" }], total: 1 });
    expect(populated.kind).toBe("exposed");
    expect(populated.kind === "exposed" && populated.data).toMatchObject({ records: 1, fields: ["id", "email"], sensitiveFields: ["email"] });
  });

  test("a JSON answer longer than the cap is flagged at lower confidence", () => {
    const body = `[${'{"id":1},'.repeat(ADMIN_RESPONSE_CAP / 8)}`;
    const v = classifyAdminResponse({ status: 200, contentType: "application/json", body: body.slice(0, ADMIN_RESPONSE_CAP), truncated: true });
    expect(v).toMatchObject({ kind: "exposed", data: { truncated: true } });
    const htmlBig = classifyAdminResponse({ status: 200, contentType: "text/html", body: "<html>", truncated: true });
    expect(htmlBig.kind).toBe("not-data");
  });

  test("an over-cap answer is read only up to the cap and flagged lower confidence", async () => {
    const big = JSON.stringify(Array.from({ length: 40_000 }, (_, i) => ({ id: i, email: `u${i}@x.example` })));
    expect(big.length).toBeGreaterThan(ADMIN_RESPONSE_CAP);
    const { checks } = await run({ [USERS]: () => json(JSON.parse(big)) }, { surface: surface([getRef("/api/admin/users")]) });
    expect(checks[0]).toMatchObject({ status: "fail" });
    expect(checks[0]!.items?.[0]?.meta).toMatchObject({ truncated: true, confidence: "lower" });
  });

  test("every probe erroring is skipped, never a pass", async () => {
    const { checks } = await run(
      { [USERS]: () => Promise.reject(new TypeError("connection refused")) },
      { surface: surface([getRef("/api/admin/users")]) }
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-errors" });
  });

  test("a budget that runs out partway with no finding is skipped, not a pass", async () => {
    let t = 0;
    const { checks, sent } = await run(
      {
        [USERS]: () => {
          t += 10_000;
          return json({ error: "Unauthorized" }, 401);
        },
      },
      { budgetMs: 5_000, now: () => t, surface: surface([getRef("/api/admin/users"), getRef("/api/admin/stats")]) }
    );
    expect(sent).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
    expect(checks[0]!.message).toContain("1 of 2");
  });

  test("no admin endpoint referenced passes without sending anything", async () => {
    const { checks, sent } = await run({}, { surface: surface([getRef("/api/products")]) });
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "pass" });
  });
});

describe("robots.txt", () => {
  test("an admin endpoint robots.txt disallows is not probed below aggressive, and the pass says so", async () => {
    const { checks, sent } = await run(
      { [USERS]: () => json(userList) },
      { surface: surface([getRef("/api/admin/users")]), robotsTxt: robots(["/api/admin"]) }
    );
    expect(sent).toHaveLength(0);
    expect(checks[0]).toMatchObject({ status: "pass" });
    expect(checks[0]!.message).toContain("1 disallowed by robots.txt");
  });

  test("aggressive probes it anyway", async () => {
    const { checks, sent } = await run(
      { [USERS]: () => json(userList) },
      { level: "aggressive", surface: surface([getRef("/api/admin/users")]), robotsTxt: robots(["/api/admin"]) }
    );
    expect(sent).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "fail" });
  });
});
