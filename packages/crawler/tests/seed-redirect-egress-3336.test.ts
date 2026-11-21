// squirrelscan/repo#3336: seed resolution (`detectRedirects`) runs before the
// crawl and followed the start URL's redirects natively whenever the site's own
// hosts were not pinned, HTTP hops and page-controlled client-side ones (meta
// refresh, script) alike. A start URL that redirected to a link-local or cloud
// metadata address made the auditor's machine request it. Every hop now goes
// through the crawl's own egress policy, pinned or not: the refused hop is
// never sent and the crawl audits the start URL itself. A redirect within the
// site, and a localhost or LAN start URL, resolve as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlerConfig } from "../src/core/types";

import { createCrawler } from "../src/core/crawler";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 5,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 3000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: true,
  coverageMode: "full",
  discoveryProbes: [],
};

const MARKER = "metadata-response-marker";
const TARGETS = {
  "metadata-ip": "http://169.254.169.254/latest/meta-data/",
  "metadata-name": "http://metadata.google.internal/computeMetadata/v1/",
  "link-local": "http://[fe80::1]/x",
} as const;

function isRefusedHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host.startsWith("169.254.") ||
    host.startsWith("fe80:") ||
    host === "metadata.google.internal"
  );
}

const html = (head: string, body = "start page") =>
  new Response(
    `<!doctype html><html><head><title>Start</title>${head}</head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

/** The fixture: `/<kind>/<target>` redirects to that target the way `kind` says. */
let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const [, kind, key] = url.pathname.split("/");
      const target = TARGETS[key as keyof typeof TARGETS];
      if (target && kind === "http") {
        return new Response(null, {
          status: 302,
          headers: { location: target },
        });
      }
      if (target && kind === "meta") {
        return html(`<meta http-equiv="refresh" content="0; url=${target}">`);
      }
      if (target && kind === "js") {
        return html(`<script>window.location.href = "${target}";</script>`);
      }
      if (url.pathname === "/to-landing") {
        return Response.redirect(`http://${url.host}/landing`, 302);
      }
      return html("", "landing");
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (isRefusedHost(url)) return html(`<title>${MARKER}</title>`, MARKER);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

const resolveHost = async (hostname: string) => {
  if (hostname === "localhost") return ["127.0.0.1"];
  throw Object.assign(new Error(`ENOTFOUND ${hostname}`), {
    code: "ENOTFOUND",
  });
};

async function run(seed: string, config: Partial<CrawlerConfig>) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({
        config: { ...CONFIG, ...config },
        storage,
      });
      const resolved = yield* crawler.detectRedirects(seed);
      const crawlId = yield* crawler.start(seed, seed);
      const crawl = yield* storage.getCrawl(crawlId);
      const pages = yield* storage.getPages(crawlId);
      return { resolved, crawl, pages };
    })
  );
}

const reachedRefused = () => requested.filter(isRefusedHost);

describe.each([
  ["own hosts pinned (the CLI default)", { pinOwnHosts: true, resolveHost }],
  ["own hosts not pinned (SQUIRREL_NO_HOST_PINNING)", {}],
  [
    "a transport that pins (the hosted container)",
    { egressPinnedByTransport: true },
  ],
] as const)("seed resolution, %s (repo#3336)", (_name, config) => {
  for (const kind of ["http", "meta", "js"] as const) {
    test.each(Object.keys(TARGETS))(
      `a start URL whose ${kind} redirect points at %s is never followed there, and is audited itself`,
      async (key) => {
        const seed = `http://localhost:${server.port}/${kind}/${key}`;
        const { resolved, crawl, pages } = await run(seed, config);

        expect(reachedRefused()).toEqual([]);
        expect(resolved).toBe(seed);
        expect(crawl?.seedUrl).toBe(seed);
        expect(pages.map((p) => p.url)).toContain(seed);
        expect(JSON.stringify(pages)).not.toContain(MARKER);
        const start = pages.find((p) => p.url === seed);
        expect(start?.status).toBe(kind === "http" ? 302 : 200);
      }
    );
  }

  test("a redirect within the site still resolves", async () => {
    const seed = `http://localhost:${server.port}/to-landing`;
    const { resolved } = await run(seed, config);

    expect(resolved).toBe(`http://localhost:${server.port}/landing`);
  });
});
