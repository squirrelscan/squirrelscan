// squirrelscan/repo#3336: the reachability probe is the first request of every
// audit. It followed a start URL's redirects natively whenever the site's own
// hosts were not pinned (SQUIRREL_NO_HOST_PINNING, or an environment proxy),
// so a start URL that answered 302 to the metadata service made the auditor's
// machine request it. Every hop now goes through the egress guard, pinned or
// not, and a start URL whose redirect is refused is still reachable: the audit
// goes on and audits the start URL itself. An allowed redirect is still
// followed, and the WAF check reads the page it lands on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkReachability } from "../../src/utils/reachability";

/** Hosts a request must never reach. */
function isRefusedHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host.startsWith("169.254.") ||
    host.startsWith("fe80:") ||
    host === "metadata.google.internal"
  );
}

/** Public-looking names and literals the stub answers from the fixture, never the network. */
const FIXTURE_HOSTS = new Set([
  "site.test",
  "www.site.test",
  "93.184.216.34",
  "93.184.216.35",
]);

const REFUSED_TARGETS: Record<string, string> = {
  "/to-metadata-ip": "http://169.254.169.254/latest/meta-data/",
  "/to-metadata-name": "http://metadata.google.internal/computeMetadata/v1/",
  "/to-link-local": "http://[fe80::1]/x",
};

const realFetch = globalThis.fetch;
const savedPinning = process.env.SQUIRREL_NO_HOST_PINNING;
let server: ReturnType<typeof Bun.serve>;
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const refused = REFUSED_TARGETS[path];
      if (refused) {
        return new Response(null, {
          status: 302,
          headers: { location: refused },
        });
      }
      if (path === "/to-other-site") {
        return Response.redirect("http://93.184.216.35/challenge", 302);
      }
      if (path === "/to-www") {
        return Response.redirect("http://www.site.test/challenge", 301);
      }
      if (path === "/challenge") {
        return new Response(
          "<html><head><title>Just a moment...</title></head><body>challenge</body></html>",
          {
            status: 403,
            headers: {
              "content-type": "text/html",
              "cf-mitigated": "challenge",
              server: "cloudflare",
            },
          }
        );
      }
      return new Response("<html><title>ok</title></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (isRefusedHost(url)) return new Response("metadata-response-marker");
    const parsed = new URL(url);
    if (FIXTURE_HOSTS.has(parsed.hostname)) {
      return realFetch(
        `http://127.0.0.1:${server.port}${parsed.pathname}${parsed.search}`,
        init
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
  if (savedPinning === undefined) delete process.env.SQUIRREL_NO_HOST_PINNING;
  else process.env.SQUIRREL_NO_HOST_PINNING = savedPinning;
});

const reachedRefused = () => requested.filter(isRefusedHost);

describe.each([
  ["own hosts pinned (the default)", ""],
  ["own hosts not pinned (SQUIRREL_NO_HOST_PINNING)", "1"],
] as const)(
  "reachability and a start URL's redirects, %s (repo#3336)",
  (_name, noPinning) => {
    beforeEach(() => {
      process.env.SQUIRREL_NO_HOST_PINNING = noPinning;
    });

    test.each(Object.keys(REFUSED_TARGETS))(
      "localhost start URL redirecting %s: never requested there, start URL reachable",
      async (path) => {
        const result = await checkReachability(
          `http://localhost:${server.port}${path}`
        );

        expect(reachedRefused()).toEqual([]);
        expect(requested.some((u) => u.includes(path))).toBe(true);
        expect(result).toMatchObject({ reachable: true, statusCode: 302 });
      }
    );

    test.each(Object.keys(REFUSED_TARGETS))(
      "public start URL redirecting %s: never requested there, start URL reachable",
      async (path) => {
        const result = await checkReachability(`http://93.184.216.34${path}`);

        expect(reachedRefused()).toEqual([]);
        expect(requested.some((u) => u.includes(path))).toBe(true);
        expect(result).toMatchObject({ reachable: true, statusCode: 302 });
      }
    );

    test("a WAF challenge on the final page of an allowed redirect is still detected", async () => {
      const result = await checkReachability(
        "http://93.184.216.34/to-other-site"
      );

      expect(requested.some((u) => u.endsWith("/challenge"))).toBe(true);
      expect(result).toMatchObject({
        reachable: true,
        statusCode: 403,
        wafDetected: true,
        wafProvider: "cloudflare",
      });
    });

    test("an allowed redirect from a localhost start URL is followed", async () => {
      const result = await checkReachability(
        `http://localhost:${server.port}/to-other-site`
      );

      expect(requested.some((u) => u.endsWith("/challenge"))).toBe(true);
      expect(result).toMatchObject({ reachable: true, statusCode: 403 });
    });
  }
);

describe("reachability with the own hosts not pinned (repo#3336)", () => {
  test("the start URL's own hosts go out by name and its www redirect is followed to the WAF page", async () => {
    process.env.SQUIRREL_NO_HOST_PINNING = "1";
    const result = await checkReachability("http://site.test/to-www");

    expect(requested.map((u) => new URL(u).host)).toEqual([
      "site.test",
      "www.site.test",
    ]);
    expect(result).toMatchObject({
      reachable: true,
      statusCode: 403,
      wafDetected: true,
      wafProvider: "cloudflare",
    });
  });
});
