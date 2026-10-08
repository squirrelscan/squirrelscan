// #437 — a <meta http-equiv="refresh"> inside <noscript> never fires in a
// browser with scripting on, so the crawl must be seeded at the page the user
// asked for, not the no-JS fallback it points at. Driven through the real
// crawler.start() against a local server.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 5,
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

const REFRESH = `<meta http-equiv="refresh" content="0; url=/no-js.html">`;
const page = (head: string, title: string) =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><p>${title}</p></body></html>`;

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

// `/` carries `rootHead` in its <head>; `/no-js.html` is the refresh target.
function serve(rootHead: string): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const html =
        path === "/"
          ? page(rootHead, "seed page")
          : path === "/no-js.html"
            ? page("", "no-js fallback")
            : null;
      return html === null
        ? new Response("not found", { status: 404 })
        : new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function crawl(origin: string) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: CONFIG, storage });
      const crawlId = yield* crawler.start(`${origin}/`, `${origin}/`);
      const meta = yield* storage.getCrawl(crawlId);
      const pages = yield* storage.getPages(crawlId);
      return { meta, pages };
    }),
  );
}

describe("seed page with a <noscript> meta refresh (#437)", () => {
  test("is audited at the seed URL, not the refresh target", async () => {
    const origin = serve(`<noscript>${REFRESH}</noscript>`);
    const { meta, pages } = await crawl(origin);

    expect(meta?.seedUrl).toBe(`${origin}/`);
    const seed = pages.find((p) => p.normalizedUrl === `${origin}/`);
    expect(seed?.html).toContain("seed page");
    expect(pages.some((p) => p.html?.includes("no-js fallback"))).toBe(false);
  });

  test("negative control: the same refresh outside <noscript> re-seeds the crawl", async () => {
    const origin = serve(REFRESH);
    const { meta } = await crawl(origin);

    expect(meta?.seedUrl).toBe(`${origin}/no-js.html`);
  });
});
