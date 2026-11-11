// #1762 crawler corners, real crawler against a local site:
//  - a sitemap of 10 URLs that all redirect (unslashed -> slashed) is a working crawl, not "none stored";
//  - a redirect to a destination the crawl would not visit (excluded) stays an ordinary page row,
//    so the audit is not left with no page at all (excluded here, the same for outside `include` or another site).

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
const page = (title: string, body = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${words}</p>${body}</main></body></html>`;
const HTML = { "content-type": "text/html" };

function serve(routes: (url: URL, origin: string) => Response | null): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = `http://localhost:${server.port}`;
      return routes(url, origin) ?? new Response("nf", { status: 404, headers: HTML });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function crawl(origin: string, extra: Record<string, unknown> = {}) {
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 40,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        ...extra,
      },
    }),
  );
  const storage = crawler.storage as SQLiteStorage;
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const pages = await Effect.runPromise(storage.getPages(crawlId));
  const count = await Effect.runPromise(storage.getPageCount(crawlId));
  return { pages, count };
}

describe("redirect rows and the crawl's own bookkeeping (#1762)", () => {
  test("a sitemap of ten unslashed URLs that all redirect does not trip the zero-success breaker", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const origin = serve((url, o) => {
      // The seed redirects too, so no page is stored before the ten redirecting sitemap URLs have been tried.
      if (url.pathname === "/") return new Response(null, { status: 301, headers: { location: "/home/" } });
      if (url.pathname === "/home/") return new Response(page("Home"), { headers: HTML });
      if (url.pathname === "/sitemap.xml") {
        const locs = names.map((n) => `<url><loc>${o}/${n}</loc></url>`).join("");
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      const m = /^\/(s\d)$/.exec(url.pathname);
      if (m) return new Response(null, { status: 301, headers: { location: `/${m[1]}/` } });
      const d = /^\/(s\d)\/$/.exec(url.pathname);
      if (d) return new Response(page(`Dest ${d[1]}`), { headers: HTML });
      return null;
    });
    const { pages, count } = await crawl(origin);
    const destinations = pages.filter((p) => /\/s\d\/$/.test(p.normalizedUrl) && p.status === 200);
    expect(destinations.length).toBe(10);
    expect(pages.some((p) => p.normalizedUrl === `${origin}/home/` && p.status === 200)).toBe(true);
    // The page count the crawl budgets on counts pages (ten destinations and the home page), not redirect rows.
    expect(count).toBe(11);
  }, 60_000);

  test("a redirect to a destination the crawl would not visit (excluded) stays an ordinary page, not a redirect with nothing behind it", async () => {
    const origin = serve((url) => {
      if (url.pathname === "/") return new Response(page("Home", `<a href="/docs/">Docs</a>`), { headers: HTML });
      if (url.pathname === "/docs/") return new Response(null, { status: 301, headers: { location: "/documentation/" } });
      if (url.pathname === "/documentation/") return new Response(page("Documentation"), { headers: HTML });
      return null;
    });
    const { pages } = await crawl(origin, { exclude: ["/documentation/**"] });
    const docs = pages.find((p) => p.normalizedUrl === `${origin}/docs/`);
    expect(docs).toBeDefined();
    // Not a 3xx marker: the destination is not crawled, so the row keeps the page it was.
    expect(docs!.status).toBe(200);
    expect(docs!.html ?? "").toContain("Documentation");
  }, 60_000);
});
