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
// site's own hosts pinned it connects to the address it checked and does not
// follow redirects, so a start URL that redirects to the metadata service is
// never requested there.
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

    expect(result).toMatchObject({ reachable: true, statusCode: 302 });
    expect(requested.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });
});
