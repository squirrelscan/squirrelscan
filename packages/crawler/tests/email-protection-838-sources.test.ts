// pub#838: whatever names Cloudflare's `/cdn-cgi/l/email-protection` path, a sitemap or a
// carried finding as well as a link, the crawl must not fetch it: it is a mailto in the
// browser and a 404 when requested. Driven through the real crawler.start() against a
// local server that answers 200 on the path, so a fetch would show as a stored page.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const OBFUSCATION = "/cdn-cgi/l/email-protection";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

const page = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

function serve(requested: string[]): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") {
        const origin = `http://127.0.0.1:${server.port}`;
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>${origin}/</loc></url><url><loc>${origin}/about</loc></url>` +
            `<url><loc>${origin}${OBFUSCATION}</loc></url></urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (url.pathname === "/" || url.pathname === "/about" || url.pathname === OBFUSCATION) {
        return new Response(page(url.pathname), { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("the crawl never fetches the Cloudflare email obfuscation path (pub#838)", () => {
  test("a sitemap entry and a carried URL naming it are not queued, the rest are", async () => {
    const requested: string[] = [];
    const origin = serve(requested);
    const config: Partial<CrawlerConfig> = {
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
      carriedSeedUrls: [`${origin}${OBFUSCATION}`, `${origin}/about`],
    };
    const storage = new SQLiteStorage(":memory:");
    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawler = yield* createCrawler({ config, storage });
        const crawlId = yield* crawler.start(`${origin}/`, `${origin}/`);
        return yield* storage.getPages(crawlId);
      }),
    );

    // Sanity: the sitemap really was read and the ordinary pages crawled.
    expect(requested).toContain("/sitemap.xml");
    expect(pages.map((p) => new URL(p.normalizedUrl).pathname).sort()).toEqual(["/", "/about"]);
    expect(requested).not.toContain(OBFUSCATION);
  }, 30000);
});
