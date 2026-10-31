// #1405 (follow-up to #1369), driven through the real crawler.start() against a local server:
// the seed is put ahead of the sitemap only for a deep URL the user TYPED, and a seed that is
// also a sitemap URL still counts as a pending sitemap URL.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

const page = (title: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p>${links
    .map((href) => `<a href="${href}">${href}</a>`)
    .join("")}</body></html>`;

interface Fixture {
  origin: string;
  requested: string[];
}

function serve(sitemapPaths: string[]): Fixture {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(url.pathname);
      const origin = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/sitemap.xml") {
        const locs = sitemapPaths.map((p) => `<url><loc>${origin}${p}</loc></url>`).join("");
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (url.pathname === "/") {
        return new Response(null, { status: 302, headers: { location: `${origin}/en/` } });
      }
      if (url.pathname === "/en/") {
        return new Response(page("en", ["/other"]), { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/other" || url.pathname === "/s1") {
        return new Response(page(url.pathname), { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, requested };
}

const BASE: Partial<CrawlerConfig> = {
  maxPages: 10,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 2000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
};

async function crawl(
  fixture: Fixture,
  config: Partial<CrawlerConfig>,
  start: (origin: string) => { target: string; original?: string },
) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: { ...BASE, ...config }, storage });
      const args = start(fixture.origin);
      const crawlId = yield* crawler.start(args.target, args.original);
      const en = yield* storage.getFrontierEntry(crawlId, `${fixture.origin}/en/`);
      return { en };
    }),
  );
}

describe("seed order keys on the URL the user typed (#1405)", () => {
  test("a deep typed start gets the seed source even when the sitemap lists it", async () => {
    const fixture = serve(["/en/", "/s1"]);
    const { en } = await crawl(fixture, {}, (o) => ({ target: `${o}/en/`, original: `${o}/en/` }));
    expect(en?.source).toBe("seed");
  }, 30000);

  test("a root start that redirects to a deep page keeps the root-start order", async () => {
    const fixture = serve(["/en/", "/s1"]);
    // The typed root redirects to /en/; the crawl is started from the destination, as the CLI does.
    const { en } = await crawl(fixture, {}, (o) => ({ target: `${o}/en/`, original: `${o}/` }));
    // The sitemap copy won the frontier dedup, as it did before deep starts were prioritised.
    expect(en?.source).toBe("sitemap");
  }, 30000);

  test("a seed that is also the only sitemap URL still counts as a pending sitemap URL", async () => {
    const fixture = serve(["/en/"]);
    await crawl(fixture, { disableLinkDiscovery: true }, (o) => ({
      target: `${o}/en/`,
      original: `${o}/en/`,
    }));
    // Quick mode keeps link discovery off while the sitemap has a pending URL: /other is
    // linked from /en/ only, so it is never requested. A seed that no longer counted would
    // read as an empty sitemap and turn discovery back on.
    expect(fixture.requested).toContain("/en/");
    expect(fixture.requested).not.toContain("/other");
  }, 30000);
});
