// squirrelscan/repo#3430: with the site's own hosts pinned (the CLI), the asset
// phase vets them too. A stylesheet or script on the www twin or a
// project-domain subdomain whose DNS answers a cloud metadata address is never
// requested there, and the site's own assets connect to the address checked.
// Without `pinOwnHosts` the own hosts are trusted by name, as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";
import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";

import { runStreamingPreRules } from "../src/streaming-pre-rules";

const REFUSED = ["169.254.169.254", "fd00:ec2::254"];
const MARKER = "metadata-response-marker";

let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;
let requested: Array<{ url: string; host: string | null }> = [];

beforeEach(() => {
  requested = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const port = server.port;
      if (url.pathname === "/") {
        return new Response(
          `<!doctype html><html><head><title>Fixture</title>` +
            `<link rel="stylesheet" href="/style.css">` +
            `<link rel="stylesheet" href="http://www.site.test:${port}/twin.css">` +
            `<script src="http://cdn.site.test:${port}/app.js"></script>` +
            `</head><body>Home</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname.endsWith(".css")) {
        return new Response("body{color:red}", { headers: { "content-type": "text/css" } });
      }
      if (url.pathname.endsWith(".js")) {
        return new Response("1", { headers: { "content-type": "text/javascript" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push({ url, host: new Headers(init?.headers).get("host") });
    const address = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (REFUSED.includes(address)) return new Response(MARKER);
    if (address === "127.0.0.1") return realFetch(input, init);
    // Sent by name: the test's names have no real DNS, so answer from the fixture.
    return realFetch(url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${server.port}`), init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

const resolveHost = async (hostname: string): Promise<string[]> => {
  const answers: Record<string, string[]> = {
    "site.test": ["127.0.0.1"],
    "www.site.test": ["169.254.169.254"],
    "cdn.site.test": ["fd00:ec2::254"],
  };
  const answer = answers[hostname];
  if (!answer) throw new Error(`ENOTFOUND ${hostname}`);
  return answer;
};

async function assetsOf(pinOwnHosts: boolean) {
  const origin = `http://site.test:${server.port}`;
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
        discoveryProbes: [],
        pinOwnHosts,
        resolveHost,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  requested = [];
  const config = {
    rule_options: {},
    rules: { enable: ["*"] },
    project: { domains: ["site.test"] },
    crawler: { max_pages: 10, exclude: [] },
    external_links: { enabled: false },
    internal_links: { enabled: false },
  } as unknown as Config;
  const pre = await Effect.runPromise(
    runStreamingPreRules(crawler.storage, crawlId, config, {
      resourceOverrides: { pinOwnHosts, resolveHost },
    }),
  );
  return { origin, assets: pre.assets };
}

describe("the asset phase and the site's own hosts (repo#3430)", () => {
  test("pinned: an own-host asset answering a metadata address is refused, never requested", async () => {
    const { origin, assets } = await assetsOf(true);

    const css = new Map(assets.resourceSizes.css.map((c) => [c.url, c]));
    expect(css.get(`${origin}/style.css`)?.status).toBe(200);
    expect(css.get(`http://www.site.test:${server.port}/twin.css`)?.error).toBe(
      ASSET_FETCH_REFUSED_ERROR,
    );
    const script = assets.scripts.find((s) => s.url.startsWith("http://cdn.site.test"));
    expect(script?.error).toBe(ASSET_FETCH_REFUSED_ERROR);

    expect(
      requested.filter((r) => REFUSED.includes(new URL(r.url).hostname.replace(/^\[|\]$/g, ""))),
    ).toEqual([]);
    expect(requested.filter((r) => /www\.site\.test|cdn\.site\.test/.test(r.url + r.host))).toEqual(
      [],
    );
    // The site's own stylesheet went to the address checked, under its name.
    const own = requested.find((r) => r.url.endsWith("/style.css"));
    expect(own && new URL(own.url).hostname).toBe("127.0.0.1");
    expect(own?.host).toBe(`site.test:${server.port}`);
  });

  test("not pinned: the own hosts go out by name, as before", async () => {
    await assetsOf(false);

    expect(requested.some((r) => new URL(r.url).hostname === "www.site.test")).toBe(true);
  });
});
