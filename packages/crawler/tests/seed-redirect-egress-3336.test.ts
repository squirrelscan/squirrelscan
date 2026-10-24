// squirrelscan/repo#3336: the crawl's own redirects were held to the egress
// policy in repo#2830, but resolving the start URL still followed its HTTP
// redirects natively and its meta refresh / JS redirects unchecked, so a start
// URL that redirected to a cloud metadata or link-local address still made the
// auditor's machine request it. Every hop of the seed resolution is now vetted
// like the crawl's; private networks stay allowed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 3,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 3000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  disableLinkDiscovery: true,
};

const SECRET = "metadata-secret-marker";

function isRefusedHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host.startsWith("169.254.") || host.startsWith("fe80:") || host === "metadata.google.internal"
  );
}

// Every request goes through the global fetch: recorded, and a refused
// destination answers with a marker instead of the network.
const realFetch = globalThis.fetch;
let requested: string[] = [];
// The runtime's own following is invisible to this spy, so none may be asked for.
let followed: string[] = [];
beforeEach(() => {
  requested = [];
  followed = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (init?.redirect !== "manual") followed.push(url);
    if (isRefusedHost(url)) {
      return new Response(
        `<html><head><title>${SECRET}</title></head><body>${SECRET}</body></html>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (head: string, body = "Home") =>
  new Response(
    `<!doctype html><html><head><title>Fixture</title>${head}</head><body>${body}</body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

/** The start URL `/` answers with `start`; everything else is a plain page. */
function serve(start: () => Response): string {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === "/" ? start() : html("", "Page")),
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function resolveSeed(seed: string) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: CONFIG, storage });
      const finalUrl = yield* crawler.detectRedirects(seed);
      const crawlId = yield* crawler.start(finalUrl, seed);
      const meta = yield* storage.getCrawl(crawlId);
      const pages = yield* storage.getPages(crawlId);
      return { finalUrl, meta, pages };
    }),
  );
}

describe("resolving the start URL (repo#3336)", () => {
  test.each([
    [
      "an HTTP redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    ],
    [
      "a meta refresh",
      () =>
        html(
          `<meta http-equiv="refresh" content="0; url=http://metadata.google.internal/computeMetadata/v1/">`,
        ),
    ],
    ["a JS redirect", () => html(`<script>window.location.href = "http://[fe80::1]/x";</script>`)],
  ])(
    "%s to a metadata or link-local address is never requested; the start URL is audited",
    async (_kind, start) => {
      const origin = serve(start);
      const { finalUrl, meta, pages } = await resolveSeed(`${origin}/`);

      expect(requested.some((url) => new URL(url).origin === origin)).toBe(true);
      expect(requested.filter(isRefusedHost)).toEqual([]);
      expect(followed).toEqual([]);
      expect(finalUrl).toBe(`${origin}/`);
      expect(meta?.baseUrl).toBe(origin);
      expect(JSON.stringify(pages)).not.toContain(SECRET);
    },
  );

  test("a redirect within the site, and to another private host, still resolves", async () => {
    const other = Bun.serve({ port: 0, fetch: () => html("", "Landed") });
    servers.push(other);
    const origin = serve(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: `http://127.0.0.1:${other.port}/landed` },
        }),
    );
    const { finalUrl } = await resolveSeed(`${origin}/`);
    expect(finalUrl).toBe(`http://127.0.0.1:${other.port}/landed`);
  });
});
