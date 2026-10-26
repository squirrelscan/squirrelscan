// squirrelscan/repo#2759 (review): the external link check follows redirects
// by hand, and every hop, the first request included, goes through the same
// egress guard: public addresses only (private ones too when the audited site
// is itself private), never link-local or cloud metadata, http(s) only,
// connected to the address that was vetted (unless the transport pins), and no
// headers but User-Agent and Accept.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";
import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { checkExternalLinks } from "../src/external-checker";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Every request the server saw: path, Host, and the header names it carried. */
let seen: Array<{ path: string; host: string; headers: string[] }> = [];

function serve(): number {
  seen = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        host: req.headers.get("host") ?? "",
        headers: [...req.headers.keys()],
      });
      const redirect = (location: string) =>
        new Response(null, { status: 302, headers: { location } });
      switch (url.pathname) {
        case "/hop-meta":
          return redirect("http://169.254.169.254/latest/meta-data/");
        case "/hop-meta-name":
          return redirect("http://metadata.google.internal/computeMetadata/v1/");
        case "/hop-link-local":
          return redirect("http://[fe80::1]/x");
        case "/hop-file":
          return redirect("file:///etc/passwd");
        case "/hop-private":
          return redirect(`http://localhost:${url.port}/landed`);
        case "/hop-public":
          return redirect(`http://public-b.example.com:${url.port}/landed`);
        case "/":
          return new Response(
            `<!doctype html><html><head><title>Fixture</title></head><body><a href="http://localhost:${url.port}/landed">Elsewhere</a></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        default:
          return new Response("landed", { headers: { "content-type": "text/plain" } });
      }
    },
  });
  servers.push(server);
  return server.port;
}

/**
 * The policy a public site's audit uses, with two "public" names that resolve
 * to the local server (and are let through as such), so the guard can be
 * watched on a real socket.
 */
function publicSite(): EgressPolicy {
  const names: Record<string, string[]> = {
    "public-a.example.com": ["127.0.0.1"],
    "public-b.example.com": ["127.0.0.1"],
  };
  return {
    allowPrivateNetwork: false,
    resolve: async (host) => {
      const answer = names[host];
      if (!answer) throw new Error(`ENOTFOUND ${host}`);
      return answer;
    },
    allowPrivateTarget: (url) => url.hostname in names,
  };
}

const ALLOWED_HEADERS = new Set(["host", "user-agent", "accept", "accept-encoding", "connection"]);

describe("every hop of the external check goes through the egress guard", () => {
  const options = (egress: EgressPolicy) => ({
    concurrency: 4,
    timeoutMs: 5_000,
    userAgent: "squirrel-test",
    egress,
  });

  test("each hop is vetted by its own name and pinned to the vetted address, Host kept", async () => {
    const port = serve();
    const [result] = await Effect.runPromise(
      checkExternalLinks([`http://public-a.example.com:${port}/hop-public`], null, options(publicSite())),
    );
    expect(result).toMatchObject({
      status: 200,
      error: null,
      redirectTarget: `http://public-b.example.com:${port}/landed`,
    });
    // Both names reached the server through the vetted 127.0.0.1, by name.
    expect(seen.map((r) => `${r.host} ${r.path}`)).toEqual([
      `public-a.example.com:${port} /hop-public`,
      `public-b.example.com:${port} /landed`,
    ]);
  });

  test("a redirect into a private, link-local or metadata address, or a non-http scheme, is not followed", async () => {
    const port = serve();
    const urls = ["hop-private", "hop-meta", "hop-meta-name", "hop-link-local", "hop-file"].map(
      (path) => `http://public-a.example.com:${port}/${path}`,
    );
    const results = await Effect.runPromise(checkExternalLinks(urls, null, options(publicSite())));
    for (const r of results) {
      // The redirect is the link's answer; its target was never requested.
      expect(r.status).toBe(302);
      expect(r.error).toBeNull();
    }
    expect(seen.map((r) => r.path).sort()).toEqual([
      "/hop-file",
      "/hop-link-local",
      "/hop-meta",
      "/hop-meta-name",
      "/hop-private",
    ]);
  });

  test("a first request to a private address is refused: never sent, never broken, never cached", async () => {
    const port = serve();
    const cacheWrites: unknown[] = [];
    const cache = {
      getCachedBulk: () => new Map(),
      setCachedBulk: (entries: unknown[]) => cacheWrites.push(...entries),
    };
    const [result] = await Effect.runPromise(
      checkExternalLinks([`http://127.0.0.1:${port}/landed`], cache, options(publicSite())),
    );
    expect(result).toMatchObject({ status: null, error: null });
    expect(seen).toEqual([]);
    expect(cacheWrites).toEqual([]);
  });

  test("with no policy given, the check fails closed: public addresses only", async () => {
    const port = serve();
    const [result] = await Effect.runPromise(
      checkExternalLinks([`http://127.0.0.1:${port}/landed`], null, {
        concurrency: 1,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
      }),
    );
    expect(result).toMatchObject({ status: null, error: null });
    expect(seen).toEqual([]);
  });

  test("no request carries anything but User-Agent and Accept", async () => {
    const port = serve();
    await Effect.runPromise(
      checkExternalLinks([`http://public-a.example.com:${port}/hop-public`], null, options(publicSite())),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.headers.filter((h) => !ALLOWED_HEADERS.has(h))).toEqual([]);
    }
  });
});

describe("the audit's external link phase", () => {
  async function linkFetchUrls(egressPinnedByTransport: boolean): Promise<string[]> {
    const port = serve();
    // The audited site is 127.0.0.1 (private, so private links are allowed);
    // its external link is the same server under `localhost`.
    const home = `http://127.0.0.1:${port}/`;
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
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(home, home));
    const config = {
      rule_options: {},
      rules: { enable: ["links/broken-external-links"] },
      crawler: { max_pages: 1, exclude: [] },
      external_links: { enabled: true, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
      internal_links: { enabled: false },
    } as unknown as Config;
    const real = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/landed")) fetched.push(url);
      return real(input, init);
    }) as typeof fetch;
    try {
      await Effect.runPromise(
        runStreamingPreRules(crawler.storage, crawlId, config, {
          externalLinks: { config: config.external_links, linkCache: null },
          resourceOverrides: { egressPinnedByTransport },
        }),
      );
    } finally {
      globalThis.fetch = real;
    }
    return fetched;
  }

  test("on the CLI, a link's request connects to the vetted address", async () => {
    const fetched = await linkFetchUrls(false);
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) expect(new URL(url).hostname).toMatch(/^(127\.0\.0\.1|\[::1\])$/);
  });

  test("in the hosted container, whose transport pins, it goes by name", async () => {
    const fetched = await linkFetchUrls(true);
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) expect(new URL(url).hostname).toBe("localhost");
  });
});
