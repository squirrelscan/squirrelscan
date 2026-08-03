// End-to-end guard for the false-positive class in #1510: a site whose every
// internal link ends in `/` (the WordPress / Hugo / Jekyll default) must never
// be asked for the no-slash form, because the origin answers 301 and the audit
// then reports a redirect the site never had. The server here is deliberately
// strict — it 301s any no-slash path — so a single normalization slip shows up
// as a recorded redirect rather than as a silent extra request.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 20,
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

const PAGES = ["/", "/o-mnie/", "/blog/", "/kontakt/"];
/** A page that genuinely moved: linked with its slash, and still a real 301. */
const MOVED = "/stary-wpis/";
const MOVED_TARGET = "/blog/";

interface Site {
  origin: string;
  requested: string[];
  stop: () => void;
}

/**
 * A trailing-slash-canonical site. Every internal href ends in `/`; any request
 * for the no-slash form gets the 301 a real origin would send.
 */
function serveSlashCanonical(
  options: { alsoLinkNoSlash?: boolean; linkMovedPage?: boolean } = {},
): Site {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requested.push(path);

      if (path !== "/" && !path.endsWith("/")) {
        return new Response(null, { status: 301, headers: { location: `${path}/` } });
      }
      if (path === MOVED) {
        return new Response(null, { status: 301, headers: { location: MOVED_TARGET } });
      }
      if (!PAGES.includes(path)) return new Response("not found", { status: 404 });

      const hrefs = PAGES.filter((p) => p !== path).map((p) => `<a href="${p}">${p}</a>`);
      if (options.alsoLinkNoSlash) {
        hrefs.push(`<a href="/o-mnie">no-slash</a>`);
      }
      if (options.linkMovedPage) {
        hrefs.push(`<a href="${MOVED}">moved</a>`);
      }
      return new Response(
        `<!doctype html><html><head><title>${path}</title></head><body>${hrefs.join("")}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requested,
    stop: () => server.stop(true),
  };
}

const sites: Site[] = [];
function track(site: Site): Site {
  sites.push(site);
  return site;
}
afterEach(() => {
  while (sites.length > 0) sites.pop()?.stop();
});

async function crawl(seed: string) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: CONFIG, storage });
      const crawlId = yield* crawler.start(seed, seed);
      return yield* storage.getPages(crawlId);
    }),
  );
}

describe("a trailing-slash-canonical site", () => {
  test("is never asked for the no-slash form of a linked page", async () => {
    const site = track(serveSlashCanonical());

    const pages = await crawl(`${site.origin}/`);

    // Non-vacuous: the crawl really did walk the site.
    expect(pages.length).toBeGreaterThanOrEqual(PAGES.length);

    const documentPaths = site.requested.filter((p) => !p.includes("."));
    const noSlash = documentPaths.filter((p) => p !== "/" && !p.endsWith("/"));
    expect(noSlash).toEqual([]);
  });

  test("records no redirects at all", async () => {
    const site = track(serveSlashCanonical());

    const pages = await crawl(`${site.origin}/`);

    for (const page of pages) {
      expect(page.status).toBe(200);
      expect(page.finalUrl).toBe(page.url);
      expect(page.redirectChain?.chainLength ?? 0).toBe(0);
    }
  });

  test("no stored chain claims a 2xx status on a hop it says redirected", async () => {
    const site = track(serveSlashCanonical());

    const pages = await crawl(`${site.origin}/`);

    for (const page of pages) {
      for (const hop of page.redirectChain?.hops.slice(0, -1) ?? []) {
        const is2xx = hop.statusCode >= 200 && hop.statusCode < 300;
        expect(is2xx).toBe(false);
      }
    }
  });
});

describe("a site that links BOTH forms of the same path", () => {
  test("crawls only one of them — the budget is not spent twice", async () => {
    const site = track(serveSlashCanonical({ alsoLinkNoSlash: true }));

    const pages = await crawl(`${site.origin}/`);

    const oMnie = pages.filter((p) => p.url.replace(/\/$/, "").endsWith("/o-mnie"));
    expect(oMnie).toHaveLength(1);
    // Whichever form was seen first is the one crawled; here the slash form is
    // linked first, so the no-slash request is never made.
    expect(oMnie[0]!.url).toBe(`${site.origin}/o-mnie/`);
  });
});

describe("a variant the crawl refused", () => {
  test("does not suppress the form the crawl is allowed to fetch", async () => {
    // `/o-mnie/` is excluded by scope, so it is recorded as a SKIPPED frontier
    // entry. That is not a crawl of that path, so the no-slash form — which the
    // exclude pattern does not match — must still be crawled.
    const site = track(serveSlashCanonical({ alsoLinkNoSlash: true }));

    const storage = new SQLiteStorage(":memory:");
    const pages = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawler = yield* createCrawler({
          config: { ...CONFIG, exclude: ["/o-mnie/"] },
          storage,
        });
        const crawlId = yield* crawler.start(`${site.origin}/`, `${site.origin}/`);
        return yield* storage.getPages(crawlId);
      }),
    );

    expect(pages.some((p) => p.url === `${site.origin}/o-mnie/`)).toBe(false);
    expect(pages.some((p) => p.url === `${site.origin}/o-mnie`)).toBe(true);
  });
});

describe("a genuine redirect", () => {
  test("is still recorded, with the real 301 on the hop that served it", async () => {
    // A page the site really moved, linked in its canonical (slashed) form.
    const site = track(serveSlashCanonical({ linkMovedPage: true }));

    const pages = await crawl(`${site.origin}/`);

    const redirected = pages.find((p) => p.url === `${site.origin}${MOVED}`);
    expect(redirected).toBeDefined();
    expect(redirected!.finalUrl).toBe(`${site.origin}${MOVED_TARGET}`);
    expect(redirected!.redirectChain?.chainLength).toBe(1);
    expect(redirected!.redirectChain?.hops[0]?.statusCode).toBe(301);
    expect(redirected!.redirectChain?.hops[1]?.statusCode).toBe(200);
  });
});
