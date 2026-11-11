// #1777 end to end: a real server with a 20 page site, a real crawler given 3 target URLs, both engines.
// The server records every request, so "fetches exactly 3 pages" is what the site saw, not what the crawler
// says. Site-wide rules skip with `targeted-run`, robots.txt is still judged, the other 17 pages get no
// finding, and the report's coverage accounts for every URL given.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { TARGETED_RUN_SKIP_REASON, type CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";
import { isRedirectSourcePage } from "../src/redirect-source";
import { targetedCoverageFor } from "../src/report-stream";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const PAGE_COUNT = 20;

function serve(): { origin: string; hits: string[] } {
  const hits: string[] = [];
  const links = Array.from({ length: PAGE_COUNT }, (_, i) => `<a href="/p/${i}">p${i}</a>`).join(" ");
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
      if (pathname === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (pathname === "/sitemap.xml") return new Response("<urlset/>", { status: 200 });
      if (pathname === "/old") {
        return new Response(null, { status: 301, headers: { location: "/p/9" } });
      }
      // No <title> on odd pages: core/meta-title has a finding to give on them.
      const title = Number(pathname.split("/").pop()) % 2 === 0 ? "<title>A page</title>" : "";
      // A canonical to the page without its query: `?ref=` variants are one page.
      const canonical = `<link rel="canonical" href="http://localhost:${server.port}${pathname}">`;
      return new Response(
        `<!doctype html><html lang="en"><head>${title}${canonical}</head><body><h1>Page</h1>${links}</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits };
}

import type { FrontierRecord } from "@squirrelscan/core-contracts/storage";
import { targetedCoverage } from "../src/report-stream";

const CONFIG = {
  rule_options: {},
  rules: { enable: ["core/meta-title", "links/click-depth", "crawl/robots-txt", "crawl/sitemap-exists"] },
  crawler: { max_pages: 50, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(
  engine: "v1" | "v2",
  targets: (origin: string) => string[],
  maxPages = 50,
  crawlerExtra: Record<string, unknown> = {},
) {
  const { origin, hits } = serve();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: true,
        incremental: false,
        useCacheControl: false,
        targetUrls: targets(origin),
        ...crawlerExtra,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
  const stored = await Effect.runPromise(storage.getPages(crawlId));
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      if (engine === "v1") {
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, pre.assets);
      }
      return yield* runStreamingRules(storage, crawlId, CONFIG, pre.assets);
    }) as Effect.Effect<{ ruleResultsMap: Map<string, { checks: CheckResult[] }> }, never, never>,
  );
  const checks = (id: string) => (ran.ruleResultsMap.get(id)?.checks ?? []) as CheckResult[];
  // The audited pages are the report's: a redirect row is recorded, not a page (#1762).
  const auditedPages = stored.filter((p) => !isRedirectSourcePage(p));
  const coverage = await Effect.runPromise(targetedCoverageFor(storage, crawlId));
  return { origin, hits, checks, coverage, stored: auditedPages };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`a targeted run on a 20 page site (${engine})`, () => {
    test("the site sees exactly 3 pages and robots.txt; whole-site rules skip with the reason; no finding for the other pages", async () => {
      const r = await audit(engine, (o) => [`${o}/p/1`, `${o}/p/3`, `${o}/p/4`]);

      // What the SITE saw: robots.txt and the three pages. No sitemap, no probe, no link followed.
      expect([...r.hits].sort()).toEqual(["/p/1", "/p/3", "/p/4", "/robots.txt"]);
      expect(r.stored.map((p) => new URL(p.url).pathname).sort()).toEqual(["/p/1", "/p/3", "/p/4"]);

      // Site-wide rules: skipped with the reason, never a pass or a finding.
      for (const id of ["links/click-depth", "crawl/sitemap-exists"]) {
        const c = r.checks(id);
        expect(c.length, id).toBeGreaterThan(0);
        expect(c.every((x) => x.status === "skipped" && x.skipReason === TARGETED_RUN_SKIP_REASON), id).toBe(true);
      }
      // robots.txt is fetched whatever is given, so its rule still runs.
      expect(r.checks("crawl/robots-txt").some((x) => x.skipReason === TARGETED_RUN_SKIP_REASON)).toBe(false);

      // Page rules ran on the targets only: /p/1 and /p/3 have no title, /p/4 has one.
      const metaTitle = r.checks("core/meta-title");
      const failingPaths = [
        ...new Set(
          metaTitle.filter((x) => x.status === "fail").map((x) => new URL(x.pageUrl ?? "").pathname),
        ),
      ].sort();
      expect(failingPaths).toEqual(["/p/1", "/p/3"]);
      // Nothing at all was said about a page that was not given.
      expect(
        metaTitle.every((x) => ["/p/1", "/p/3", "/p/4"].includes(new URL(x.pageUrl ?? "").pathname)),
      ).toBe(true);

      expect(r.coverage).toEqual({ requested: 3, audited: 3, unaudited: [] });
    });

    test("query and canonical variants are audited pages, never reported as redirected (#1777 review)", async () => {
      // `ref` is an allowed query parameter, so each value is its own URL; both name the same canonical page.
      const r = await audit(
        engine,
        (o) => [`${o}/p/1?ref=a`, `${o}/p/1?ref=b`, `${o}/p/3`],
        50,
        { allowQueryParams: ["ref"] },
      );
      expect(r.coverage.requested).toBe(3);
      expect(r.coverage.audited).toBe(3);
      expect(r.coverage.unaudited).toEqual([]);
    });

    test("every URL given is accounted for: refused, over the cap, redirected", async () => {
      const r = await audit(
        engine,
        (o) => [`${o}/p/1`, `${o}/private/x`, `${o}/old`, `${o}/p/2`, `${o}/p/3`],
        3,
      );
      const byUrl = Object.fromEntries(
        r.coverage.unaudited.map((u) => [new URL(u.url).pathname, u]),
      );
      expect(byUrl["/private/x"]?.reason).toBe("robots_disallowed");
      // /old redirects to /p/9, which was not listed: not followed, named as the destination.
      expect(byUrl["/old"]?.reason).toBe("redirected");
      expect(new URL(byUrl["/old"]!.destination!).pathname).toBe("/p/9");
      // The request for /old follows its own redirect to record the chain (the site sees /p/9 once), but the
      // destination is not queued or audited as a page.
      expect(r.stored.map((p) => new URL(p.url).pathname)).not.toContain("/p/9");
      // maxPages 3 caps the list: /p/1 and /p/2 are audited (the redirect and the refused URL are no pages),
      // the rest is listed as not audited.
      expect(r.coverage.requested).toBe(5);
      expect(r.coverage.audited + r.coverage.unaudited.length).toBe(5);
    });
  });
}

describe("targetedCoverage (pure)", () => {
  const row = (url: string, status: FrontierRecord["status"], extra: Partial<FrontierRecord> = {}): FrontierRecord => ({
    normalizedUrl: url,
    rawUrl: url,
    depth: 0,
    priority: 0,
    status,
    source: "carried",
    enqueuedAt: 0,
    retryCount: 0,
    ...extra,
  });

  test("a done row is audited unless its stored row is a redirect", () => {
    const c = targetedCoverage(
      [row("https://e.test/a", "done"), row("https://e.test/old", "done"), row("https://e.test/b?ref=1", "done")],
      ["https://e.test/old"],
    );
    expect(c).toEqual({
      requested: 3,
      audited: 2,
      unaudited: [{ url: "https://e.test/old", reason: "redirected" }],
    });
  });

  test("the URLs past the limit are counted as requested and not audited, without rows", () => {
    const c = targetedCoverage([row("https://e.test/a", "done")], [], 7);
    expect(c).toMatchObject({ requested: 8, audited: 1, overLimit: 7 });
  });
});
