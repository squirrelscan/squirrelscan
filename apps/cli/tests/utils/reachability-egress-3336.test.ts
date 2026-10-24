// squirrelscan/repo#3336: the reachability check, which runs before the crawl,
// followed the start URL's redirects natively, so a start URL that redirected to
// a cloud metadata or link-local address made the auditor's machine request it.
// Its hops are now vetted like the crawl's (repo#2830): the redirect itself is
// the answer, and the site still counts as reachable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  checkReachability,
  reachabilitySend,
} from "../../src/utils/reachability";

const realFetch = globalThis.fetch;
let requested: Array<{ url: string; headers: Headers }> = [];

function isRefusedHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host.startsWith("169.254.") ||
    host.startsWith("fe80:") ||
    host === "metadata.google.internal"
  );
}

/** The global fetch, recorded; `routes` answers by URL, never the network. */
function fakeNetwork(routes: Record<string, () => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url];
    if (route) return route();
    if (isRefusedHost(url)) return new Response("metadata");
    return realFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  requested = [];
});

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const s of servers.splice(0)) s.stop(true);
});

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe("reachability check redirects (repo#3336)", () => {
  test("a localhost start URL that redirects to a metadata address is reachable, and the address is never requested", async () => {
    fakeNetwork({});
    const server = Bun.serve({
      port: 0,
      fetch: () => redirect("http://169.254.169.254/latest/meta-data/"),
    });
    servers.push(server);
    const result = await checkReachability(`http://localhost:${server.port}/`);

    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(302);
    expect(requested.filter((r) => isRefusedHost(r.url))).toEqual([]);
  });

  test.each([
    "http://169.254.169.254/latest/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[fe80::1]/x",
  ])("a hop to %s is not followed: the redirect answers", async (location) => {
    fakeNetwork({ "https://site.example/": () => redirect(location) });
    const response = await reachabilitySend("https://site.example/")(
      "https://site.example/",
      {
        method: "GET",
        redirect: "follow",
      }
    );
    expect(response.status).toBe(302);
    expect(requested.map((r) => r.url)).toEqual(["https://site.example/"]);
  });

  test("an allowed hop to another host is followed with the same browser headers", async () => {
    fakeNetwork({
      "https://site.example/": () =>
        redirect("https://93.184.215.14/home", 301),
      "https://93.184.215.14/home": () => new Response("ok"),
    });
    const response = await reachabilitySend("https://site.example/")(
      "https://site.example/",
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "sec-ch-ua": '"Chromium";v="140"',
          "User-Agent": "squirrel-test",
        },
      }
    );
    expect(response.status).toBe(200);
    expect(requested.map((r) => r.url)).toEqual([
      "https://site.example/",
      "https://93.184.215.14/home",
    ]);
    expect(requested[1]?.headers.get("sec-ch-ua")).toBe('"Chromium";v="140"');
  });

  test("with redirects off it sends one request", async () => {
    fakeNetwork({
      "https://site.example/": () => redirect("https://site.example/a"),
    });
    const response = await reachabilitySend("https://site.example/")(
      "https://site.example/",
      {
        method: "GET",
        redirect: "manual",
      }
    );
    expect(response.status).toBe(302);
    expect(requested).toHaveLength(1);
  });

  test("a start URL that is itself a link-local address is the user's choice: its redirects are followed", async () => {
    fakeNetwork({
      "http://169.254.10.10/": () => redirect("http://169.254.10.10/admin"),
    });
    const response = await reachabilitySend("http://169.254.10.10/")(
      "http://169.254.10.10/",
      {
        method: "GET",
        redirect: "follow",
      }
    );
    expect(response.status).toBe(200);
    expect(requested.map((r) => r.url)).toEqual([
      "http://169.254.10.10/",
      "http://169.254.10.10/admin",
    ]);
  });
});
