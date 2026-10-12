// repo#2729: the internal link probe must never change state on the audited
// site. Through the real crawler and the real pre-rules phase, a home page
// links action URLs (log out, a tokened unsubscribe, add to cart, a confirm
// token, a nofollow "Delete") next to a plain missing page. The server records
// every request: the action URLs get none, the missing page gets one HEAD, and
// no probe request carries the audit's custom headers or any credentials.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";

import { probeLinkTargets } from "../src/link-target-probe";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

const ACTION_LINKS = [
  `<a href="/logout">Log out</a>`,
  `<a href="/unsubscribe?token=4f9c2b7e1d8a6f3c">Stop emails</a>`,
  `<a href="/cart/add?id=1">Add</a>`,
  `<a href="/confirm/abc123def456">Confirm your address</a>`,
  `<a href="/account/12" rel="nofollow">Delete account</a>`,
  `<a href="/posts?id=7&_wpnonce=a1b2c3d4e5">Trash</a>`,
  `<a href="/old-settings">Settings</a>`,
];
const ACTION_PATHS = [
  "/logout",
  "/unsubscribe",
  "/cart/add",
  "/confirm/abc123def456",
  "/account/12",
  "/posts",
];

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}

function serveSite(): { origin: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
      });
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      switch (url.pathname) {
        case "/":
          return ok(html(`${ACTION_LINKS.join(" ")} <a href="/missing-page">Old post</a>`));
        case "/sitemap.xml":
          return ok(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.origin}/</loc></url></urlset>`,
            "application/xml",
          );
        case "/robots.txt":
          return ok(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, "text/plain");
        // An innocent-looking link that redirects to an action: the probe
        // stops at the redirect and never follows it.
        case "/old-settings":
          return new Response(null, { status: 302, headers: { location: "/logout" } });
      }
      return new Response(html("Not found"), { status: 404, headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, seen };
}

async function auditQuick() {
  const site = serveSite();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        disableLinkDiscovery: true,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${site.origin}/`, `${site.origin}/`));
  const crawlEnd = site.seen.length;
  const config = {
    rule_options: {},
    rules: { enable: ["links/broken-links"] },
    // A custom-header audit: the header may carry auth, so the probe must
    // never send it.
    crawler: { max_pages: 10, exclude: [], headers: { "X-Site-Auth": "secret-value" } },
    external_links: { enabled: false, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
    internal_links: { enabled: true },
  } as unknown as Config;
  const preRules = await Effect.runPromise(runStreamingPreRules(crawler.storage, crawlId, config, {}));
  return { ...site, crawlEnd, assets: preRules.assets };
}

describe("the internal link probe never changes state (repo#2729)", () => {
  test("action URLs get zero requests; the missing page gets one HEAD, with no custom headers or credentials", async () => {
    const { seen, crawlEnd, assets } = await auditQuick();
    const probes = seen.slice(crawlEnd);

    for (const path of ACTION_PATHS) {
      expect(seen.filter((r) => r.path === path), path).toEqual([]);
    }

    const missing = probes.filter((r) => r.path === "/missing-page");
    expect(missing.map((r) => r.method)).toEqual(["HEAD"]);
    for (const request of probes) {
      expect(request.headers["x-site-auth"]).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    }

    // The redirecting link was asked once (HEAD) and reported as its 302.
    expect(probes.filter((r) => r.path === "/old-settings").map((r) => r.method)).toEqual([
      "HEAD",
    ]);
    const byPath = new Map(
      (assets.linkTargetStatuses ?? []).map((s) => [new URL(s.url).pathname, s.status]),
    );
    expect(byPath.get("/missing-page")).toBe(404);
    expect(byPath.get("/old-settings")).toBe(302);
    expect(assets.internalLinkProbe?.outOfScope).toBe(6);
  });
});

describe("probeLinkTargets", () => {
  function fakeSite(routes: Record<string, (method: string) => Response>) {
    const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
    const send = async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, init });
      const route = routes[new URL(url).pathname];
      return route ? route(method) : new Response(null, { status: 404 });
    };
    return { calls, send };
  }
  const base = {
    userAgent: "squirrel-test",
    timeoutMs: 5_000,
    concurrency: 1,
    mayRequest: (url: string) => new URL(url).host === "example.com" && !url.includes("logout"),
  };

  test("GET only when HEAD answers 405 or 501, as a one-byte range", async () => {
    const site = fakeSite({
      "/a": (m) => new Response(null, { status: m === "HEAD" ? 405 : 206 }),
      "/b": (m) => new Response(null, { status: m === "HEAD" ? 501 : 200 }),
      "/c": () => new Response(null, { status: 500 }),
    });
    const { results } = await Effect.runPromise(
      probeLinkTargets(
        ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d"],
        { ...base, send: site.send },
      ),
    );
    expect(results.map((r) => r.status)).toEqual([206, 200, 500, 404]);
    expect(site.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "HEAD /a",
      "GET /a",
      "HEAD /b",
      "GET /b",
      "HEAD /c",
      "HEAD /d",
    ]);
    const get = site.calls.find((c) => c.method === "GET")!;
    expect(new Headers(get.init.headers).get("range")).toBe("bytes=0-0");
  });

  test("sends only User-Agent and Accept, never credentials", async () => {
    const site = fakeSite({ "/a": () => new Response(null, { status: 200 }) });
    await Effect.runPromise(probeLinkTargets(["https://example.com/a"], { ...base, send: site.send }));
    const [call] = site.calls;
    expect([...new Headers(call!.init.headers).keys()].sort()).toEqual(["accept", "user-agent"]);
    expect(call!.init.credentials).toBe("omit");
    expect(call!.init.redirect).toBe("manual");
  });

  test("follows a redirect only while every hop may be requested", async () => {
    const site = fakeSite({
      "/moved": () => new Response(null, { status: 301, headers: { location: "/gone" } }),
      "/out": () => new Response(null, { status: 302, headers: { location: "https://other.example/x" } }),
      "/to-action": () => new Response(null, { status: 302, headers: { location: "/logout" } }),
    });
    const { results } = await Effect.runPromise(
      probeLinkTargets(
        ["https://example.com/moved", "https://example.com/out", "https://example.com/to-action"],
        { ...base, send: site.send },
      ),
    );
    expect(results.map((r) => r.status)).toEqual([404, 302, 302]);
    expect(site.calls.map((c) => c.url)).toEqual([
      "https://example.com/moved",
      "https://example.com/gone",
      "https://example.com/out",
      "https://example.com/to-action",
    ]);
  });

  test("a site whose HEAD fails on a page it serves: no 4xx or 5xx is trusted", async () => {
    const site = fakeSite({
      "/": (m) => new Response(null, { status: m === "HEAD" ? 404 : 200 }),
      "/a": (m) => new Response(null, { status: m === "HEAD" ? 404 : 200 }),
      "/b": () => new Response(null, { status: 200 }),
    });
    const probe = await Effect.runPromise(
      probeLinkTargets(["https://example.com/a", "https://example.com/b"], {
        ...base,
        controlUrl: "https://example.com/",
        send: site.send,
      }),
    );
    expect(probe.headUnreliable).toBe(true);
    expect(probe.results.map((r) => [r.status, r.error])).toEqual([
      [null, "head unreliable"],
      [200, null],
    ]);
    // Still HEAD only: the control does not unlock a GET.
    expect(site.calls.map((c) => c.method)).toEqual(["HEAD", "HEAD", "HEAD"]);
  });

  test("the control is the audited URL: asked even where the filters skip it, and no answer trusts nothing less", async () => {
    const site = fakeSite({ "/cart": () => new Response(null, { status: 200 }) });
    const skipsCart = { ...base, mayRequest: (url: string) => !url.includes("cart") };
    const asked = await Effect.runPromise(
      probeLinkTargets(["https://example.com/gone"], {
        ...skipsCart,
        controlUrl: "https://example.com/cart",
        send: site.send,
      }),
    );
    expect(asked.headUnreliable).toBe(false);
    expect(site.calls.map((c) => new URL(c.url).pathname)).toEqual(["/cart", "/gone"]);
    expect(asked.results[0]?.status).toBe(404);

    const failing = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/") throw new Error("connection reset");
      return site.send(url, init);
    };
    const unknown = await Effect.runPromise(
      probeLinkTargets(["https://example.com/gone"], {
        ...base,
        controlUrl: "https://example.com/",
        send: failing,
      }),
    );
    expect(unknown.headUnreliable).toBe(false);
    expect(unknown.results[0]?.status).toBe(404);
  });

  test("a site whose HEAD answers the control: a target's 404 stands", async () => {
    const site = fakeSite({ "/": () => new Response(null, { status: 200 }) });
    const probe = await Effect.runPromise(
      probeLinkTargets(["https://example.com/gone"], {
        ...base,
        controlUrl: "https://example.com/",
        send: site.send,
      }),
    );
    expect(probe.headUnreliable).toBe(false);
    expect(probe.results[0]?.status).toBe(404);
  });

  test("a target it may not request is never sent", async () => {
    const site = fakeSite({});
    const {
      results: [result],
    } = await Effect.runPromise(
      probeLinkTargets(["https://example.com/logout"], { ...base, send: site.send }),
    );
    expect(result).toMatchObject({ status: null, error: "not requested" });
    expect(site.calls).toEqual([]);
  });
});
