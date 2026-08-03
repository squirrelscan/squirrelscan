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
    // Crawled with the moved page linked, so there ARE multi-hop chains to
    // inspect — on a purely canonical site every chain is one hop and
    // `hops.slice(0, -1)` is empty, which would make this assertion vacuous.
    const site = track(serveSlashCanonical({ linkMovedPage: true, alsoLinkNoSlash: true }));

    const pages = await crawl(`${site.origin}/`);

    const nonFinalHops = pages.flatMap((p) => p.redirectChain?.hops.slice(0, -1) ?? []);
    expect(nonFinalHops.length).toBeGreaterThan(0);
    for (const hop of nonFinalHops) {
      const is2xx = hop.statusCode >= 200 && hop.statusCode < 300;
      expect(is2xx).toBe(false);
    }
  });
});

describe("a site that links BOTH forms of the same path", () => {
  test("crawls both, so the one that redirects is actually found", async () => {
    // The two forms are different request targets and only a fetch can say which
    // of them redirects. Collapsing them would answer that by discovery order.
    const site = track(serveSlashCanonical({ alsoLinkNoSlash: true }));

    const pages = await crawl(`${site.origin}/`);

    const slash = pages.find((p) => p.url === `${site.origin}/o-mnie/`);
    const noSlash = pages.find((p) => p.url === `${site.origin}/o-mnie`);
    expect(slash).toBeDefined();
    expect(noSlash).toBeDefined();

    // The linked no-slash form is the one that genuinely redirects here.
    expect(noSlash!.redirectChain?.hops[0]?.statusCode).toBe(301);
    expect(noSlash!.finalUrl).toBe(`${site.origin}/o-mnie/`);
    expect(slash!.redirectChain?.chainLength ?? 0).toBe(0);
  });
});

describe("a NO-SLASH-canonical site (canonicalized the other way)", () => {
  // Mirror image of the reported case: `/o-mnie` is the real page and the SLASH
  // form is the one that 301s. Discovery order must not decide whether that
  // redirect is reported.
  function serveNoSlashCanonical(linkFirst: "slash" | "no-slash"): Site {
    const requested: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        requested.push(path);

        if (path !== "/" && path.endsWith("/")) {
          return new Response(null, {
            status: 301,
            headers: { location: path.slice(0, -1) },
          });
        }
        if (path !== "/" && path !== "/o-mnie") {
          return new Response("not found", { status: 404 });
        }

        const hrefs =
          linkFirst === "slash"
            ? [`<a href="/o-mnie/">a</a>`, `<a href="/o-mnie">b</a>`]
            : [`<a href="/o-mnie">b</a>`, `<a href="/o-mnie/">a</a>`];
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

  test.each(["slash", "no-slash"] as const)(
    "reports the slash form's genuine 301 when %s is linked first",
    async (linkFirst) => {
      const site = track(serveNoSlashCanonical(linkFirst));

      const pages = await crawl(`${site.origin}/`);

      const slash = pages.find((p) => p.url === `${site.origin}/o-mnie/`);
      expect(slash).toBeDefined();
      expect(slash!.redirectChain?.hops[0]?.statusCode).toBe(301);
      expect(slash!.finalUrl).toBe(`${site.origin}/o-mnie`);

      // The canonical form is crawled too and is not itself a redirect.
      const canonical = pages.find((p) => p.url === `${site.origin}/o-mnie`);
      expect(canonical).toBeDefined();
      expect(canonical!.redirectChain?.chainLength ?? 0).toBe(0);
    },
  );
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
