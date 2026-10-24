// squirrelscan/repo#2830: the internal link probe's per-hop checks were scope
// only. Every request now also goes through the audit's own-site egress policy
// (#2764), so a hop the scope admits but the policy refuses (a link-local or
// cloud metadata address) is never sent, whatever the scope config says.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { probeLinkTargets } from "../src/link-target-probe";

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
