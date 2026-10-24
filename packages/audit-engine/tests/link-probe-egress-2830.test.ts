// squirrelscan/repo#2830: the internal link probe's per-hop checks were scope
// only. Every request now also goes through the audit's own-site egress policy
// (#2764), so a hop the scope admits but the policy refuses (a link-local or
// cloud metadata address) is never sent, whatever the scope config says.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";
import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { probeLinkTargets } from "../src/link-target-probe";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

function fakeSite(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const send = async (url: string, _init: RequestInit) => {
    calls.push(url);
    return routes[new URL(url).pathname]?.() ?? new Response(null, { status: 404 });
  };
  return { calls, send };
}

const resolved: string[] = [];
// The site's own policy as the adapter builds it: its hosts sent by name,
// private networks allowed, link-local and metadata refused.
const egress: EgressPolicy = {
  allowPrivateNetwork: true,
  pin: false,
  resolve: async (host) => {
    resolved.push(host);
    return ["10.0.0.5"];
  },
  trustTarget: (url) => url.hostname === "example.com",
};

const base = {
  userAgent: "squirrel-test",
  timeoutMs: 5_000,
  concurrency: 1,
  // A scope that admits every hop, so only the egress policy stands in the way.
  mayRequest: () => true,
  egress,
};

describe("the internal link probe's egress (repo#2830)", () => {
  test("a redirect hop to a metadata or link-local address is never sent: the 3xx answers", async () => {
    const site = fakeSite({
      "/go-ip": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/" },
        }),
      "/go-name": () =>
        new Response(null, {
          status: 301,
          headers: { location: "http://metadata.google.internal/v1/" },
        }),
      "/go-v6": () =>
        new Response(null, { status: 307, headers: { location: "http://[fe80::1]/x" } }),
    });
    const { results } = await Effect.runPromise(
      probeLinkTargets(
        ["https://example.com/go-ip", "https://example.com/go-name", "https://example.com/go-v6"],
        { ...base, send: site.send },
      ),
    );
    expect(results.map((r) => r.status)).toEqual([302, 301, 307]);
    expect(site.calls).toEqual([
      "https://example.com/go-ip",
      "https://example.com/go-name",
      "https://example.com/go-v6",
    ]);
  });

  test("a target the policy refuses is never sent", async () => {
    const site = fakeSite({});
    const { results } = await Effect.runPromise(
      probeLinkTargets(["http://169.254.169.254/latest/"], { ...base, send: site.send }),
    );
    expect(results[0]).toMatchObject({ status: null, error: "not requested" });
    expect(site.calls).toEqual([]);
  });

  test("the site's own hosts go by name, and a private hop elsewhere is still followed", async () => {
    resolved.length = 0;
    const site = fakeSite({
      "/moved": () =>
        new Response(null, { status: 301, headers: { location: "http://intranet.test/new" } }),
      "/new": () => new Response(null, { status: 200 }),
    });
    const { results } = await Effect.runPromise(
      probeLinkTargets(["https://example.com/moved"], { ...base, send: site.send }),
    );
    expect(results[0]?.status).toBe(200);
    expect(site.calls).toEqual(["https://example.com/moved", "http://intranet.test/new"]);
    // Only the hop off the site was looked up.
    expect(resolved).toEqual(["intranet.test"]);
  });
});

describe("the audit wires the probe to the site's egress policy (repo#2830)", () => {
  const realFetch = globalThis.fetch;
  const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const s of servers.splice(0)) s.stop(true);
  });

  test("a link whose redirect the scope admits but the policy refuses is never followed there", async () => {
    // `project.domains` lists a metadata name, so the scope admits the hop and
    // only the egress policy can stop it (same port, so a port-strict scope
    // admits it too).
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") {
          return new Response(
            `<!doctype html><html><head><title>Home</title></head><body><a href="/go">Docs</a></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/go") {
          return new Response(null, {
            status: 302,
            headers: {
              location: `http://metadata.google.internal:${url.port}/computeMetadata/v1/`,
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;
    const domains = ["localhost", "metadata.google.internal"];

    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (new URL(url).hostname === "metadata.google.internal") return new Response("metadata");
      return realFetch(input, init);
    }) as typeof fetch;

    const crawler = await Effect.runPromise(
      createCrawler({
        config: {
          maxPages: 1,
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
          allowedDomains: domains,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
    const config = {
      rule_options: {},
      rules: { enable: ["links/broken-links"] },
      project: { domains },
      crawler: { max_pages: 1, exclude: [] },
      external_links: { enabled: false, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
      internal_links: { enabled: true },
    } as unknown as Config;
    const { assets } = await Effect.runPromise(
      runStreamingPreRules(crawler.storage, crawlId, config, {}),
    );

    // Non-vacuous: the probe asked the link, and the redirect was its answer.
    expect(requested).toContain(`${origin}/go`);
    const go = (assets.linkTargetStatuses ?? []).find((s) => new URL(s.url).pathname === "/go");
    expect(go?.status).toBe(302);
    expect(requested.filter((url) => new URL(url).hostname === "metadata.google.internal")).toEqual(
      [],
    );
  });
});
