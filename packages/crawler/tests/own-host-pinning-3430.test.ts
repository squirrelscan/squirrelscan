// squirrelscan/repo#3430: on the CLI the crawl's own hosts (the audited host,
// its www twin, the project domains) went out by name with no address check,
// so a site that controls its DNS could point one of them at the cloud
// metadata service and the crawl would request it and store the answer. With
// `pinOwnHosts` they are resolved once per crawl, a link-local or metadata
// answer is never requested, and every request connects to the address that
// was checked. Private networks, localhost and mDNS names keep working, and
// where something else resolves the name (an HTTP proxy from the environment,
// a transport that pins) the own hosts still go out by name.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 20,
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
/** Addresses a request must never reach. */
const REFUSED = ["169.254.169.254", "fd00:ec2::254", "fe80::1"];
/** Private addresses with no server behind them: answered from a table. */
const CANNED = new Set(["10.0.0.5"]);

/** The fixture site, served on 127.0.0.1 whatever name the request used. */
let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;
let requested: Array<{ url: string; host: string | null }> = [];

const page = (body: string, title = "Fixture") =>
  new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

beforeEach(() => {
  requested = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const port = server.port;
      switch (url.pathname) {
        case "/":
          return page(
            [
              `<a href="/about">About</a>`,
              `<a href="/go-www">twin</a>`,
              `<a href="/go-cdn">cdn</a>`,
            ].join(""),
          );
        case "/about":
          return page("About us", "About");
        // Redirects into the site's own other hosts: the www twin and a
        // project-domain subdomain, each of which the test's DNS points at a
        // metadata address.
        case "/go-www":
          return Response.redirect(`http://www.site.test:${port}/twin`, 302);
        case "/go-cdn":
          return Response.redirect(`http://cdn.site.test:${port}/cdn`, 302);
        default:
          return page("elsewhere", "Elsewhere");
      }
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const host = new Headers(init?.headers).get("host");
    requested.push({ url, host });
    const address = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (REFUSED.includes(address)) return page(MARKER, MARKER);
    if (CANNED.has(address)) return page(`<a href="/lan-about">About</a>`, "LAN");
    if (address === "127.0.0.1") return realFetch(input, init);
    // A request by name: the resolver in the test never reaches the network,
    // so answer the fixture site's page for the logical URL.
    return realFetch(url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${server.port}`), init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
  delete process.env.HTTP_PROXY;
});

/** A resolver from a fixed table that counts every name it is asked for. */
function resolver(answers: Record<string, string[] | (() => string[])>) {
  const asked: string[] = [];
  const resolveHost = async (hostname: string) => {
    asked.push(hostname);
    const answer = answers[hostname];
    if (!answer) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return typeof answer === "function" ? answer() : answer;
  };
  return { resolveHost, asked };
}

async function crawl(seed: string, config: Partial<CrawlerConfig>) {
  const storage = new SQLiteStorage(":memory:");
  const failed: Array<{ url: string; error: string }> = [];
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: { ...CONFIG, ...config }, storage });
      const events = Effect.runFork(
        Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
          Effect.sync(() => {
            if (event.type === "page:failed") failed.push({ url: event.url, error: event.error });
          }),
        ),
      );
      const crawlId = yield* crawler.start(seed, seed);
      const pages = yield* storage.getPages(crawlId);
      yield* Fiber.interrupt(events);
      return { pages, failed };
    }),
  );
}

const reachedRefused = () =>
  requested.filter((r) => REFUSED.includes(new URL(r.url).hostname.replace(/^\[|\]$/g, "")));

describe.each([
  ["the crawler's own fetch", {}],
  ["a document fetcher", { documentFetcher: createFetchDocumentFetcher() }],
] as const)("own hosts on the CLI, via %s (repo#3430)", (_name, fetcher) => {
  test("an audited host that resolves to the metadata address is never requested", async () => {
    const { resolveHost } = resolver({ "meta.test": ["169.254.169.254"] });
    const seed = `http://meta.test:${server.port}/`;
    const { pages, failed } = await crawl(seed, { ...fetcher, pinOwnHosts: true, resolveHost });

    expect(reachedRefused()).toEqual([]);
    expect(requested.filter((r) => r.url.includes("meta.test"))).toEqual([]);
    expect(pages.filter((p) => p.status === 200)).toEqual([]);
    expect(failed.map((f) => f.url)).toContain(seed);
    expect(failed.find((f) => f.url === seed)?.error).toContain("Not requested");
  });

  test("a redirect to a www twin or project domain answering a metadata address is not followed", async () => {
    const { resolveHost } = resolver({
      "site.test": ["127.0.0.1"],
      "www.site.test": ["169.254.169.254"],
      "cdn.site.test": ["93.184.216.34", "fd00:ec2::254"],
    });
    const origin = `http://site.test:${server.port}`;
    const { pages } = await crawl(`${origin}/`, {
      ...fetcher,
      pinOwnHosts: true,
      resolveHost,
      allowedDomains: ["site.test"],
    });

    const ok = pages.filter((p) => p.status === 200).map((p) => p.url);
    expect(ok).toContain(`${origin}/`);
    expect(ok).toContain(`${origin}/about`);
    // Both redirects were reached, so each refusal was a real decision.
    const ended = pages.filter((p) => p.url.includes("/go-")).map((p) => [p.url, p.status]);
    expect(ended.sort()).toEqual([
      [`${origin}/go-cdn`, 302],
      [`${origin}/go-www`, 302],
    ]);
    expect(reachedRefused()).toEqual([]);
    // Neither refused name went out by name either.
    expect(requested.filter((r) => /www\.site\.test|cdn\.site\.test/.test(r.url + r.host))).toEqual(
      [],
    );
    expect(JSON.stringify(pages)).not.toContain(MARKER);
  });

  test("every request connects to the address checked, looked up once (no rebinding)", async () => {
    let calls = 0;
    const { resolveHost, asked } = resolver({
      // A rebinding resolver: public-looking first, the metadata address after.
      "site.test": () => (++calls === 1 ? ["127.0.0.1"] : ["169.254.169.254"]),
    });
    const origin = `http://site.test:${server.port}`;
    const { pages } = await crawl(`${origin}/`, { ...fetcher, pinOwnHosts: true, resolveHost });

    expect(pages.filter((p) => p.status === 200).map((p) => p.url)).toContain(`${origin}/about`);
    expect(asked.filter((h) => h === "site.test")).toHaveLength(1);
    const own = requested.filter((r) => r.host === `site.test:${server.port}`);
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const r of own) expect(new URL(r.url).hostname).toBe("127.0.0.1");
    expect(reachedRefused()).toEqual([]);
  });

  test.each([
    ["localhost", ["127.0.0.1", "::1"]],
    ["an mDNS name that also answers a scoped link-local address", ["fe80::1%en0", "127.0.0.1"]],
  ])("%s keeps crawling", async (_label, answer) => {
    const name = _label === "localhost" ? "localhost" : "printer.local";
    const { resolveHost } = resolver({ [name]: answer });
    const origin = `http://${name}:${server.port}`;
    const { pages } = await crawl(`${origin}/`, { ...fetcher, pinOwnHosts: true, resolveHost });

    expect(pages.filter((p) => p.status === 200).map((p) => p.url)).toContain(`${origin}/about`);
    expect(reachedRefused()).toEqual([]);
  });

  test("a site on a private network keeps crawling", async () => {
    const { resolveHost } = resolver({ "lan.test": ["10.0.0.5"] });
    const { pages } = await crawl("http://lan.test/", {
      ...fetcher,
      pinOwnHosts: true,
      resolveHost,
    });

    expect(pages.filter((p) => p.status === 200).map((p) => p.url)).toContain("http://lan.test/");
    expect(requested.some((r) => new URL(r.url).hostname === "10.0.0.5")).toBe(true);
  });
});

describe("where something else resolves the name, own hosts still go out by name (repo#3430)", () => {
  test.each([
    ["an HTTP proxy from the environment", { pinOwnHosts: true }, true],
    [
      "a transport that pins (the hosted container)",
      { pinOwnHosts: true, egressPinnedByTransport: true },
      false,
    ],
    ["a crawl without pinOwnHosts", {}, false],
  ] as const)("%s", async (_name, config, proxy) => {
    if (proxy) process.env.HTTP_PROXY = "http://127.0.0.1:9";
    const { resolveHost, asked } = resolver({ "site.test": ["127.0.0.1"] });
    const origin = `http://site.test:${server.port}`;
    const { pages } = await crawl(`${origin}/`, { ...config, resolveHost });

    expect(pages.filter((p) => p.status === 200).map((p) => p.url)).toContain(`${origin}/about`);
    expect(requested.some((r) => new URL(r.url).hostname === "site.test")).toBe(true);
    expect(asked).not.toContain("site.test");
  });
});
