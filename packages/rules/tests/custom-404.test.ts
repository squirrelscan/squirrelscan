// crawl/custom-404: one probe for a path that cannot exist, judged for status,
// default-vs-branded page, route back and noindex. Runs against real fixture
// servers on localhost.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { custom404Rule, isDefaultErrorPage, readErrorPage } from "../src/crawl/custom-404";
import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import { clearRequestAsync, setRequestAsync } from "../src/tools";
import type { CheckResult, RuleContext } from "../src/types";

type Handler = (req: Request) => Response | Promise<Response>;

const servers: Array<{ stop: () => void }> = [];

function serve(handler: Handler): { origin: string; seen: string[] } {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return handler(req);
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { origin: `http://127.0.0.1:${server.port}`, seen };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});
beforeAll(() => setRequestAsync(() => Promise.reject(new Error("unused"))));
afterAll(() => clearRequestAsync());

function ctx(origin: string, opts: { level?: ProbeLevel; noProbe?: boolean; budgetMs?: number } = {}): RuleContext {
  return {
    page: { url: `${origin}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as RuleContext["parsed"],
    site: { baseUrl: `${origin}/`, pages: [], robotsTxt: null, sitemaps: null },
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({ level: opts.level ?? "active", budgetMs: opts.budgetMs ?? 60_000 }),
    options: {},
  };
}

const run = async (c: RuleContext): Promise<CheckResult[]> => (await custom404Rule.run(c)).checks;
const html = (body: string, status = 404, headers: Record<string, string> = {}) => () =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

const BRANDED = `<!doctype html><html><head><title>Not found | Acme</title>
  <meta name="robots" content="noindex"><link rel="stylesheet" href="/s.css"></head>
  <body><header><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></header>
  <main><h1>That page wandered off</h1><form action="/search"><input type="search" name="q"></form>
  <p>Try the <a href="/">homepage</a>.</p></main></body></html>`;

const NGINX = `<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx/1.24.0</center></body></html>`;

describe("crawl/custom-404", () => {
  test("pass: a branded 404 with nav, search and noindex stays clean (no false positive)", async () => {
    const { origin, seen } = serve(html(BRANDED));
    const checks = await run(ctx(origin));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["custom-404-ok", "pass"]]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^GET \/squirrelscan-missing-page-[0-9a-f]{16}$/);
  });

  test("fail: a missing URL answering 200 is a soft 404", async () => {
    const { origin } = serve(html(BRANDED, 200));
    const checks = await run(ctx(origin));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["custom-404-soft", "fail"]]);
  });

  test("warn: a redirect of missing URLs", async () => {
    const { origin } = serve(() => new Response(null, { status: 302, headers: { location: "/" } }));
    const checks = await run(ctx(origin));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["custom-404-redirect", "warn"]]);
    expect(checks[0]!.message).toContain("to /");
  });

  test("warn: the stock nginx page is a bare default, and is also indexable", async () => {
    const { origin } = serve(html(NGINX));
    const checks = await run(ctx(origin));
    expect(checks.map((c) => c.name)).toEqual(["custom-404-default", "custom-404-indexable"]);
    expect(checks.every((c) => c.status === "warn")).toBe(true);
    expect(checks[0]!.message).toContain("nginx");
  });

  test("warn: a styled 404 with no link back into the site", async () => {
    const page = `<html><head><title>x</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/a.css"></head><body><main><h1>Gone</h1><p>${"This page is missing. ".repeat(30)}</p></main></body></html>`;
    const { origin } = serve(html(page));
    const checks = await run(ctx(origin));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["custom-404-no-route", "warn"]]);
  });

  test("warn: indexable branded 404 (noindex via X-Robots-Tag clears it)", async () => {
    const noMeta = BRANDED.replace('<meta name="robots" content="noindex">', "");
    const a = serve(html(noMeta));
    expect((await run(ctx(a.origin))).map((c) => c.name)).toEqual(["custom-404-indexable"]);
    const b = serve(html(noMeta, 404, { "x-robots-tag": "noindex, nofollow" }));
    expect((await run(ctx(b.origin))).map((c) => c.name)).toEqual(["custom-404-ok"]);
  });

  test("410 is accepted like 404", async () => {
    const { origin } = serve(html(BRANDED, 410));
    expect((await run(ctx(origin))).map((c) => c.name)).toEqual(["custom-404-ok"]);
  });

  test("skipped: passive probing sends nothing and says how to enable it", async () => {
    const { origin, seen } = serve(html(BRANDED));
    for (const c of [ctx(origin, { level: "passive" }), ctx(origin, { noProbe: true })]) {
      const checks = await run(c);
      expect(checks.map((x) => [x.name, x.status])).toEqual([["custom-404-not-checked", "skipped"]]);
      expect(checks[0]!.message).toContain("--probe active");
    }
    expect(seen).toHaveLength(0);
  });

  test("skipped: no request tool (analyze) sends nothing", async () => {
    clearRequestAsync();
    try {
      const { origin, seen } = serve(html(BRANDED));
      const checks = await run(ctx(origin));
      expect(checks[0]!.status).toBe("skipped");
      expect(checks[0]!.skipReason).toBe("analyze-offline");
      expect(seen).toHaveLength(0);
    } finally {
      setRequestAsync(() => Promise.reject(new Error("unused")));
    }
  });

  test("skipped, not pass: throttling, a server error, a network failure or an exhausted budget", async () => {
    for (const status of [429, 403, 503]) {
      const { origin } = serve(html("x", status));
      const checks = await run(ctx(origin));
      expect(checks.map((x) => x.status)).toEqual(["skipped"]);
    }
    const down = serve(html("x"));
    const url = down.origin;
    servers.splice(0).forEach((s) => s.stop());
    expect((await run(ctx(url))).map((x) => x.status)).toEqual(["skipped"]);
    const live = serve(html(BRANDED));
    expect((await run(ctx(live.origin, { budgetMs: 0 }))).map((x) => x.status)).toEqual(["skipped"]);
    expect(live.seen).toHaveLength(0);
  });

  test("skipped: a JSON 404 is not an HTML error page", async () => {
    const { origin } = serve(() => Response.json({ error: "not found" }, { status: 404 }));
    expect((await run(ctx(origin))).map((x) => x.status)).toEqual(["skipped"]);
  });
});

describe("readErrorPage", () => {
  const headers = new Headers();
  test("recognises stock pages", () => {
    const apache = "<h1>Not Found</h1><p>The requested URL /x was not found on this server.</p>";
    expect(readErrorPage(apache, "https://a.test", headers).defaultServer).toBe("Apache");
    expect(readErrorPage("<pre>Cannot GET /x</pre>", "https://a.test", headers).defaultServer).toBe("Express");
  });
  test("a branded page is not a default; same-origin absolute links count as routes", () => {
    const r = readErrorPage(`<body><a href="https://a.test/about">About</a></body>`, "https://a.test", headers);
    expect(r.siteLinks).toBe(1);
    expect(isDefaultErrorPage(readErrorPage(BRANDED, "https://a.test", headers))).toBe(false);
  });
  test("external and fragment links are not routes back", () => {
    const r = readErrorPage(`<a href="#top">t</a><a href="https://other.test/">o</a>`, "https://a.test", headers);
    expect(r.siteLinks).toBe(0);
  });
});
