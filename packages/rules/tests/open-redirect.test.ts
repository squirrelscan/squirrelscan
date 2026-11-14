// security/open-redirect (repo#1936): probes redirect-shaped query parameters
// on same-origin URLs with an off-site canary, reads only the 3xx Location and
// never follows it. Runs against a real local HTTP server that logs every
// request it receives, so "never requested" and "never followed" are observed
// on the wire, not inferred from a stub.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { LinkData, RobotsTxtData } from "@squirrelscan/core-contracts";

import type { EndpointCandidate } from "../src/endpoint-surface";
import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  classifyRedirect,
  isRedirectParamName,
  MAX_OPEN_REDIRECT_CANDIDATES,
  OPEN_REDIRECT_CANARY_HOST,
  openRedirectRule,
  selectOpenRedirectCandidates,
} from "../src/security/open-redirect";
import type { CheckResult, RuleContext, SiteData } from "../src/types";

const CANARY_ABSOLUTE = `https://${OPEN_REDIRECT_CANARY_HOST}/`;
const CANARY_RELATIVE = `//${OPEN_REDIRECT_CANARY_HOST}/`;

interface Hit {
  method: string;
  path: string;
  params: URLSearchParams;
}

let server: ReturnType<typeof Bun.serve>;
let BASE = "";
const hits: Hit[] = [];

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push({ method: req.method, path: u.pathname, params: u.searchParams });
      const q = (name: string) => u.searchParams.get(name) ?? "";
      switch (u.pathname) {
        // Vulnerable: redirects to whatever `next` says.
        case "/login":
          return redirect(q("next") || "/");
        // Vulnerable only to the protocol-relative form: refuses a scheme, but `//host` starts with `/`.
        case "/go":
          return redirect(q("url").startsWith("/") ? q("url") : "/");
        // Safe: an allowlist. Anything off it goes to the one partner host it trusts.
        case "/sso":
          return redirect(
            q("returnTo") === "https://partner.example.org/" ? q("returnTo") : "https://partner.example.org/"
          );
        // Safe: same-origin only. Keeps the path of the value and drops its host.
        case "/home":
          return redirect(new URL(q("continue") || "/", "http://x.invalid").pathname.replace(/^\/+/, "/landing/"));
        // Rejects the value outright.
        case "/bounce":
          return new Response("bad redirect", { status: 400 });
        // Echoes the value in a 200. Not a redirect.
        case "/echo":
          return new Response(`<a href="${q("dest")}">continue</a>`, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        // State-changing paths: the rule must never request these.
        case "/logout":
        case "/account/delete":
        case "/search":
          return redirect(q("next") || q("redirect") || q("url") || "/");
        default:
          return new Response("ok", { status: 200 });
      }
    },
  });
  BASE = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function link(path: string): LinkData {
  return { url: `${BASE}${path}`, text: "link", isInternal: true };
}

function page(path: string, links: LinkData[] = []): SiteData["pages"][number] {
  return {
    url: `${BASE}${path}`,
    statusCode: 200,
    parsed: { links } as unknown as SiteData["pages"][number]["parsed"],
  };
}

function ctxFor(opts: {
  pages: SiteData["pages"];
  level?: ProbeLevel;
  noProbe?: boolean;
  budgetMs?: number;
  now?: () => number;
  surface?: EndpointCandidate[];
  robotsTxt?: RobotsTxtData | null;
}): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as RuleContext["parsed"],
    site: { baseUrl: `${BASE}/`, pages: opts.pages, robotsTxt: opts.robotsTxt ?? null, sitemaps: null },
    endpointSurface: opts.surface
      ? { candidates: opts.surface, total: opts.surface.length, truncated: false, scriptsSkipped: 0 }
      : undefined,
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({
          level: opts.level ?? "active",
          budgetMs: opts.budgetMs ?? 60_000,
          ...(opts.now ? { now: opts.now } : {}),
        }),
    options: {},
  };
}

async function run(ctx: RuleContext): Promise<{ checks: CheckResult[]; sent: Hit[] }> {
  hits.length = 0;
  const { checks } = await openRedirectRule.run(ctx);
  return { checks, sent: [...hits] };
}

const warns = (checks: CheckResult[]) => checks.filter((c) => c.status === "warn");

describe("security/open-redirect", () => {
  test("a vulnerable param is flagged with the page and the param, from the absolute form", async () => {
    const { checks, sent } = await run(ctxFor({ pages: [page("/", [link("/login?next=/account")])] }));
    const w = warns(checks);
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain(`${BASE}/login`);
    expect(w[0]!.message).toContain("next parameter");
    expect(w[0]!.items?.[0]).toMatchObject({
      id: `${BASE}/login?next`,
      meta: { page: `${BASE}/login`, param: "next", payload: "absolute", status: 302, foundVia: "link" },
    });
    // One request: the absolute form was enough, so the protocol-relative one is not sent.
    expect(sent.map((h) => `${h.method} ${h.path} ${h.params.get("next")}`)).toEqual([
      `GET /login ${CANARY_ABSOLUTE}`,
    ]);
  });

  test("the protocol-relative bypass is tried when the absolute form is refused", async () => {
    const { checks, sent } = await run(ctxFor({ pages: [page("/go?url=/docs")] }));
    const w = warns(checks);
    expect(w).toHaveLength(1);
    expect(w[0]!.items?.[0]?.meta).toMatchObject({ param: "url", payload: "protocol-relative", foundVia: "page-url" });
    expect(sent.map((h) => h.params.get("url"))).toEqual([CANARY_ABSOLUTE, CANARY_RELATIVE]);
  });

  test("an allowlisted redirect, a same-origin-only redirect, a rejection and a 200 echo are not flagged", async () => {
    const { checks, sent } = await run(
      ctxFor({
        pages: [
          page("/", [
            link("/sso?returnTo=https://partner.example.org/"),
            link("/home?continue=/dashboard"),
            link("/bounce?r=/x"),
            link("/echo?dest=/y"),
          ]),
        ],
      })
    );
    expect(warns(checks)).toHaveLength(0);
    const pass = checks.find((c) => c.status === "pass");
    expect(pass?.message).toBe("No redirect parameter sent visitors off-site (4 parameter(s) probed)");
    // Both forms were tried on every one of them.
    expect(sent).toHaveLength(8);
  });

  test("the redirect is never followed: same-origin and off-site Location targets are never requested", async () => {
    const { sent } = await run(
      ctxFor({ pages: [page("/", [link("/home?continue=/dashboard"), link("/login?next=/a")])] })
    );
    // /home redirects to /landing/... on this same server; a followed redirect would show up here.
    expect(sent.some((h) => h.path.startsWith("/landing"))).toBe(false);
    expect(sent.every((h) => h.path === "/home" || h.path === "/login")).toBe(true);
    expect(sent.every((h) => h.method === "GET")).toBe(true);
  });

  test("state-changing paths and non-GET call sites are never requested", async () => {
    const { checks, sent } = await run(
      ctxFor({
        pages: [page("/", [link("/logout?next=/"), link("/account/delete?redirect=/")])],
        surface: [
          {
            url: `${BASE}/search?url=/x`,
            method: "POST",
            source: "static-html",
            discoveredVia: "form-action",
            sameOrigin: true,
            probeEligible: true,
          },
        ],
      })
    );
    expect(sent).toHaveLength(0);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "pass", details: { skippedStateChanging: 3 } });
  });

  test("below the active level: no request, and a not-checked result that says how to enable it", async () => {
    for (const opts of [{ level: "passive" as const }, { noProbe: true }]) {
      const { checks, sent } = await run(ctxFor({ pages: [page("/login?next=/")], ...opts }));
      expect(sent).toHaveLength(0);
      expect(checks).toEqual([
        {
          name: "open-redirect",
          status: "skipped",
          skipReason: "probing-passive",
          message:
            "Probing is passive, so no redirect parameter was probed. Run with --probe active to check for open redirects.",
        },
      ]);
    }
  });

  test("probes are capped per run and the rest are counted", async () => {
    const links = Array.from({ length: MAX_OPEN_REDIRECT_CANDIDATES + 3 }, (_, i) => link(`/p${i}?next=/`));
    const { checks, sent } = await run(ctxFor({ pages: [page("/", links)] }));
    // Default route answers 200: each candidate costs both forms.
    expect(sent).toHaveLength(MAX_OPEN_REDIRECT_CANDIDATES * 2);
    expect(checks[0]).toMatchObject({ status: "pass", details: { skippedCap: 3 } });
  });

  test("an exhausted budget sends nothing more and is not a pass", async () => {
    let t = 0;
    const ctx = ctxFor({
      pages: [page("/", [link("/p1?next=/"), link("/p2?next=/")])],
      budgetMs: 1000,
      now: () => t,
    });
    // The clock jumps past the deadline once the first request is recorded.
    const probe = ctx.probe!;
    const record = probe.record.bind(probe);
    probe.record = (n?: number) => {
      record(n);
      t += 2000;
    };
    const { checks, sent } = await run(ctx);
    expect(sent).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-budget" });
    expect(checks[0]!.message).toContain("after 1 of 2 redirect parameter(s)");
  });

  test("an unreachable server is not a pass", async () => {
    const ctx = ctxFor({ pages: [] });
    ctx.site = { ...ctx.site!, baseUrl: "http://127.0.0.1:1/", pages: [{ ...page("/"), url: "http://127.0.0.1:1/login?next=/" }] };
    const { checks } = await run(ctx);
    expect(checks[0]).toMatchObject({ status: "skipped", skipReason: "probe-errors" });
  });
});

describe("open-redirect candidate selection", () => {
  test("only same-origin URLs with redirect-shaped params, deduped on path and param", () => {
    const ctx = ctxFor({
      pages: [
        page("/login?next=/a", [
          link("/login?next=/b"),
          link("/login?NEXT=/c"),
          link("/cb?return_to=/x&utm_source=y"),
          link("/q?query=next"),
          { url: "https://other.example/login?next=/", text: "", isInternal: false },
          { url: "https://other.example/login?next=/", text: "", isInternal: true },
        ]),
      ],
    });
    const { candidates } = selectOpenRedirectCandidates(ctx);
    expect(candidates.map((c) => `${new URL(c.page).pathname} ${c.param}`)).toEqual([
      "/login next",
      "/cb return_to",
    ]);
  });

  test("robots.txt disallowed paths are skipped below aggressive and included when aggressive", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: `${BASE}/robots.txt`,
      content: null,
      sizeBytes: 0,
      sitemaps: [],
      rules: [{ userAgent: "*", rules: [{ type: "disallow", path: "/private" }] }],
      errors: [],
    };
    const pages = [page("/private/login?next=/")];
    expect(selectOpenRedirectCandidates(ctxFor({ pages, robotsTxt }))).toMatchObject({
      candidates: [],
      skippedRobots: 1,
    });
    expect(
      selectOpenRedirectCandidates(ctxFor({ pages, robotsTxt, level: "aggressive" })).candidates
    ).toHaveLength(1);
  });

  test("param names match without case, underscores or dashes", () => {
    for (const name of ["next", "returnTo", "return_url", "redirect-to", "continue", "dest", "r", "url"]) {
      expect(isRedirectParamName(name)).toBe(true);
    }
    for (const name of ["q", "page", "nextPage", "ref", "utm_source"]) {
      expect(isRedirectParamName(name)).toBe(false);
    }
  });
});

describe("classifyRedirect", () => {
  const req = "https://example.com/login?next=x";
  test("only a Location on the canary host is open", () => {
    expect(classifyRedirect(302, CANARY_ABSOLUTE, req).kind).toBe("open");
    expect(classifyRedirect(301, CANARY_RELATIVE, req).kind).toBe("open");
    expect(classifyRedirect(307, `/\\${OPEN_REDIRECT_CANARY_HOST}/`, req).kind).toBe("open");
    expect(classifyRedirect(302, "/dashboard", req).kind).toBe("same-origin");
    expect(classifyRedirect(302, "https://example.com/x", req).kind).toBe("same-origin");
    expect(classifyRedirect(302, "https://partner.example.org/", req).kind).toBe("other-host");
    expect(classifyRedirect(302, `https://example.com/?u=${CANARY_ABSOLUTE}`, req).kind).toBe("same-origin");
    expect(classifyRedirect(200, CANARY_ABSOLUTE, req).kind).toBe("no-redirect");
    expect(classifyRedirect(302, null, req).kind).toBe("no-redirect");
  });
});
