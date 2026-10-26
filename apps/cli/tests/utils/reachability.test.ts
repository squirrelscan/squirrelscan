// Tests for reachability utilities

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkReachability } from "../../src/utils/reachability";

describe("checkReachability", () => {
  test("returns reachable for valid URLs", async () => {
    const result = await checkReachability("http://localhost:0");
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns unreachable for non-existent domains", async () => {
    const result = await checkReachability(
      "https://this-domain-definitely-does-not-exist-12345.com"
    );
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns unreachable for invalid URLs", async () => {
    const result = await checkReachability("http://localhost:9");
    expect(result.reachable).toBe(false);
  });
});

// squirrelscan/repo#3430: the probe is the first request of every run. With the
// site's own hosts pinned it connects to the address it checked and follows
// redirects through the same guard, so a start URL that redirects to
// the metadata service is never requested there.
describe("checkReachability and the site's own hosts (repo#3430)", () => {
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    requested.length = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.redirect("http://169.254.169.254/latest/meta-data/", 302),
    });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url.startsWith("http://169.254.169.254"))
        return new Response("metadata");
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
  });

  test("a start URL that redirects to the metadata address is not followed there", async () => {
    const result = await checkReachability(`http://localhost:${server.port}/`);

    expect(result.reachable).toBe(false);
    expect(result.error).toContain("Not requested");
    expect(requested.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  test("a redirect to an ordinary page is still followed", async () => {
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<html><title>t</title></html>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const hop = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(`http://localhost:${target.port}/`, 302),
    });
    try {
      const result = await checkReachability(`http://localhost:${hop.port}/`);
      expect(result).toMatchObject({ reachable: true, statusCode: 200 });
    } finally {
      hop.stop(true);
      target.stop(true);
    }
  });
});

// squirrelscan/squirrelscan#819: `squirrel audit --offline` sends nothing to
// another site, so the probe, the first request of the run, does not follow a
// start URL's redirect to another host. The start URL answered, so it is
// reachable; the crawl records the redirect.
describe("checkReachability and an offline audit (#819)", () => {
  const seen: Array<{ path: string; host: string | null }> = [];
  let other: ReturnType<typeof Bun.serve>;
  let site: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    seen.length = 0;
    other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          host: req.headers.get("host"),
        });
        return new Response("<html><body>elsewhere</body></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.redirect(`http://localhost:${other.port}/landed`, 302),
    });
  });

  afterEach(() => {
    site.stop(true);
    other.stop(true);
  });

  test("offline: the redirect to another host is not followed and the start URL is reachable", async () => {
    const result = await checkReachability(`http://127.0.0.1:${site.port}/`, {
      ownSiteOnly: true,
    });
    expect(result.reachable).toBe(true);
    expect(seen).toEqual([]);
  });

  test("control: without the flag the redirect is followed", async () => {
    const result = await checkReachability(`http://127.0.0.1:${site.port}/`);
    expect(result.reachable).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.host).toBe(`localhost:${other.port}`);
  });
});
