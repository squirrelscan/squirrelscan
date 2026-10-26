// squirrelscan/repo#2830: on the CLI, the page crawl and the root probes
// followed any http(s) redirect, so an open redirect on the audited site
// (`/go?u=http://169.254.169.254/...`) sent the auditor's machine to a cloud
// metadata or link-local address. A redirect hop that leaves the crawl's hosts
// is now vetted like the asset phase's (#2764): link-local and metadata
// addresses are refused before anything is sent, private networks stay allowed
// (this fixture is itself a localhost audit), and the hop connects to the
// address it was vetted on unless the transport pins (the hosted container).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
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
  breadthFirst: false,
  coverageMode: "full",
};

const METADATA_IP = "http://169.254.169.254/latest/meta-data/";
const METADATA_HOST = "http://metadata.google.internal/computeMetadata/v1/";
const LINK_LOCAL = "http://[fe80::1]/x";
const MARKER = "metadata-response-marker";

/** A refused destination: a link-local address or a cloud metadata name. */
function isRefusedHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host.startsWith("169.254.") || host.startsWith("fe80:") || host === "metadata.google.internal"
  );
}

// Every request the crawl makes goes through the global fetch. Recorded here;
// one to a refused destination is answered with a marker instead of the
// network, so a regression shows up as a recorded request and stored marker.
const realFetch = globalThis.fetch;
let requested: Array<{ url: string; host: string | null }> = [];
beforeEach(() => {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push({ url, host: new Headers(init?.headers).get("host") });
    if (isRefusedHost(url)) {
      return new Response(
        `<html><head><title>${MARKER}</title></head><body>${MARKER}</body></html>`,
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

const html = (body: string, title = "Fixture") =>
  new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/**
 * The audited site is `localhost`. Its pages link to open redirects into
 * metadata and link-local addresses, and its root files either redirect there
 * (llms-full.txt, a well-known file, index.md, one sitemap) or name one
 * outright (a robots.txt `Sitemap:` line). Its own pages, robots.txt, llms.txt
 * and sitemap.xml are ordinary.
 */
function serveSite(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = `http://localhost:${url.port}`;
      switch (url.pathname) {
        case "/":
          return html(
            [
              `<a href="/about">About</a>`,
              `<a href="/go?u=meta-ip">a</a>`,
              `<a href="/go?u=meta-host">b</a>`,
              `<a href="/go?u=link-local">c</a>`,
            ].join(""),
          );
        case "/about":
          return html("About us", "About");
        case "/go": {
          const to = url.searchParams.get("u");
          return redirect(
            to === "meta-ip" ? METADATA_IP : to === "meta-host" ? METADATA_HOST : LINK_LOCAL,
          );
        }
        case "/robots.txt":
          return new Response(
            `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\nSitemap: ${origin}/sitemap-go.xml\nSitemap: http://169.254.169.254/sitemap.xml\n`,
            { headers: { "content-type": "text/plain" } },
          );
        case "/sitemap.xml":
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/about</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        case "/sitemap-go.xml":
          return redirect(`${METADATA_IP}sitemap.xml`);
        case "/llms.txt":
          return new Response("# Fixture\n\n- [About](/about)\n", {
            headers: { "content-type": "text/plain" },
          });
        case "/llms-full.txt":
          return redirect(`${METADATA_IP}llms-full.txt`);
        case "/index.md":
          return redirect(LINK_LOCAL);
        case "/.well-known/security.txt":
          return redirect(METADATA_HOST);
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function crawl(seed: string, config: Partial<CrawlerConfig> = {}) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: { ...CONFIG, ...config }, storage });
      const crawlId = yield* crawler.start(seed, seed);
      return {
        pages: yield* storage.getPages(crawlId),
        robots: yield* storage.getRobotsTxt(crawlId),
        llms: yield* storage.getLlmsTxt(crawlId),
        wellKnown: yield* storage.getWellKnownProbe(crawlId),
        markdown: yield* storage.getMarkdownProbe(crawlId),
      };
    }),
  );
}

describe.each([
  ["the crawler's own fetch", {}],
  ["a document fetcher", { documentFetcher: createFetchDocumentFetcher() }],
] as const)("redirect hops off the site on the CLI, via %s (repo#2830)", (_name, fetcher) => {
  test("a page, root file or sitemap redirect to a metadata or link-local address is never requested", async () => {
    const origin = serveSite();
    const stored = await crawl(`${origin}/`, fetcher);

    // Non-vacuous: every redirect was reached, so each hop was a real decision.
    const paths = requested.map((r) => new URL(r.url)).filter((u) => u.origin === origin);
    const seen = new Set(paths.map((u) => `${u.pathname}${u.search}`));
    for (const path of [
      "/go?u=meta-ip",
      "/go?u=meta-host",
      "/go?u=link-local",
      "/llms-full.txt",
      "/index.md",
      "/.well-known/security.txt",
      "/sitemap-go.xml",
    ]) {
      expect(seen).toContain(path);
    }

    expect(requested.filter((r) => isRefusedHost(r.url)).map((r) => r.url)).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain(MARKER);
  });

  test("the localhost site's own pages and root files are still crawled", async () => {
    const origin = serveSite();
    const { pages, robots, llms } = await crawl(`${origin}/`, fetcher);

    const ok = pages.filter((p) => p.status === 200 && p.html).map((p) => p.url);
    expect(ok).toContain(`${origin}/`);
    expect(ok).toContain(`${origin}/about`);
    expect(robots?.exists).toBe(true);
    expect(llms?.llmsTxt.exists).toBe(true);
    // Refused at the hop: no answer, so recorded as absent, never as the
    // metadata service's reply.
    expect(llms?.llmsFullTxt.exists).toBe(false);
  });
});

describe("an off-site redirect hop that is allowed (repo#2830)", () => {
  /** `/hop` on 127.0.0.1 redirects to `localhost`, another host on the same server. */
  function serveHop(): string {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") return html(`<a href="/hop">hop</a>`);
        if (url.pathname === "/hop") return redirect(`http://localhost:${url.port}/landed`);
        if (url.pathname === "/landed") return html("Landed", "Landed");
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  test("on the CLI it connects to the address it was vetted on, Host kept", async () => {
    const origin = serveHop();
    await crawl(`${origin}/`);
    const port = new URL(origin).port;
    const landed = requested.filter((r) => new URL(r.url).pathname === "/landed");
    expect(landed.length).toBeGreaterThan(0);
    for (const r of landed) {
      expect(new URL(r.url).hostname).not.toBe("localhost");
      expect(r.host).toBe(`localhost:${port}`);
    }
  });

  test("in the hosted container, whose transport pins, it goes by name", async () => {
    const origin = serveHop();
    await crawl(`${origin}/`, { egressPinnedByTransport: true });
    const port = new URL(origin).port;
    const landed = requested.filter((r) => new URL(r.url).pathname === "/landed");
    expect(landed.map((r) => r.url)).toContain(`http://localhost:${port}/landed`);
    expect(landed.every((r) => new URL(r.url).hostname === "localhost")).toBe(true);
  });
});

describe("root files that redirect off the site (repo#2830)", () => {
  test("a robots.txt redirect and a sitemap index child on a metadata address are never requested", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const origin = `http://localhost:${url.port}`;
        switch (url.pathname) {
          case "/":
            return html(`<a href="/about">About</a>`);
          case "/about":
            return html("About us", "About");
          case "/robots.txt":
            return redirect(`${METADATA_IP}robots.txt`);
          case "/sitemap.xml":
            return new Response(
              `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
                `<sitemap><loc>${origin}/sitemap-a.xml</loc></sitemap>` +
                `<sitemap><loc>http://169.254.169.254/child.xml</loc></sitemap></sitemapindex>`,
              { headers: { "content-type": "application/xml" } },
            );
          case "/sitemap-a.xml":
            return new Response(
              `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/about</loc></url></urlset>`,
              { headers: { "content-type": "application/xml" } },
            );
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;
    const { pages, robots } = await crawl(`${origin}/`);

    const own = new Set(
      requested
        .map((r) => new URL(r.url))
        .filter((u) => u.origin === origin)
        .map((u) => u.pathname),
    );
    for (const path of ["/robots.txt", "/sitemap.xml", "/sitemap-a.xml"])
      expect(own).toContain(path);
    expect(requested.filter((r) => isRefusedHost(r.url)).map((r) => r.url)).toEqual([]);
    // Refused at the hop: robots.txt got no answer, which is not a missing file.
    expect(robots?.exists).toBe(false);
    expect(JSON.stringify(robots)).not.toContain(MARKER);
    expect(pages.filter((p) => p.status === 200).map((p) => p.url)).toContain(`${origin}/about`);
  });
});

describe("the audited host on another port (repo#2830)", () => {
  test("is sent by name, as the crawl sends it, not looked up and pinned", async () => {
    const other = Bun.serve({ port: 0, fetch: () => html("Landed", "Landed") });
    servers.push(other);
    const site = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") return html(`<a href="/other">other</a>`);
        if (url.pathname === "/other") return redirect(`http://localhost:${other.port}/landed`);
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(site);
    await crawl(`http://localhost:${site.port}/`);
    const landed = requested.filter((r) => new URL(r.url).pathname === "/landed");
    expect(landed.map((r) => r.url)).toEqual([`http://localhost:${other.port}/landed`]);
  });
});
