// repo#2729 end-to-end: a crawl that did not follow links and an audit with
// external link checking off must produce "not checked" link results, through
// the real crawler, the real rules and BOTH rule paths (v1 and streaming).
//
// The fixture's home page links a page the sitemap lists, an internal 404 the
// sitemap does not list, and an external URL. Before repo#2729 the quick crawl
// passed `links/broken-links` and `links/broken-external-links` here.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const RULES = ["links/broken-links", "links/broken-external-links"];

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

function serveSite(opts: { sitemap: boolean }): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = url.origin;
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      switch (url.pathname) {
        case "/":
          return ok(
            html(
              `<a href="/about">About</a> <a href="/missing">Old</a> <a href="https://external.invalid/page">Elsewhere</a>`,
            ),
          );
        case "/about":
          return ok(html(`<a href="/">Home</a>`));
        case "/sitemap.xml":
          if (!opts.sitemap) break;
          return ok(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/about</loc></url></urlset>`,
            "application/xml",
          );
        case "/robots.txt":
          return ok(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, "text/plain");
      }
      return new Response(html("Not found"), { status: 404, headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function audit(
  engine: "v1" | "v2",
  opts: { followLinks: boolean; externalLinks: boolean; sitemap?: boolean },
) {
  const origin = serveSite({ sitemap: opts.sitemap ?? true });
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        disableLinkDiscovery: !opts.followLinks,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
  // External checking itself is not exercised: with it on the engine reads the
  // (here empty) checked-link store, which is the "it ran" state.
  const config = {
    rule_options: {},
    rules: { enable: RULES },
    external_links: { enabled: opts.externalLinks },
  } as unknown as Config;

  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, EMPTY_ASSETS);
      }
      return yield* runStreamingRules(storage, crawlId, config, EMPTY_ASSETS);
    }) as Effect.Effect<{ siteRuleResults: Map<string, CheckResult[]> }, never, never>,
  );
  const checksOf = (id: string) => ran.siteRuleResults.get(id) ?? [];
  return {
    stats: await Effect.runPromise(storage.getStats(crawlId)),
    internal: checksOf("links/broken-links"),
    external: checksOf("links/broken-external-links"),
  };
}

const statuses = (checks: CheckResult[]) => checks.map((c) => `${c.status}:${c.skipReason ?? ""}`);

for (const engine of ["v1", "v2"] as const) {
  describe(`link checks that did not run (${engine})`, () => {
    test("quick-style crawl, external checks off: both rules are not checked, neither passes", async () => {
      const { stats, internal, external } = await audit(engine, {
        followLinks: false,
        externalLinks: false,
      });
      expect(stats?.linkDiscoveryOff).toBe(true);
      expect(statuses(internal)).toEqual(["skipped:link-targets-not-fetched"]);
      expect(internal[0]!.details).toEqual({ linkTargets: 3, unfetchedTargets: 1 });
      expect(statuses(external)).toEqual(["skipped:external-links-not-checked"]);
      expect(external[0]!.details).toEqual({ externalLinksFound: 1 });
    });

    test("links followed: the internal 404 is found, and nothing is marked not checked", async () => {
      const { stats, internal, external } = await audit(engine, {
        followLinks: true,
        externalLinks: true,
      });
      expect(stats?.linkDiscoveryOff).toBeUndefined();
      expect(statuses(internal)).toEqual(["fail:"]);
      expect(internal[0]!.items?.map((i) => i.id)).toEqual([expect.stringContaining("/missing")]);
      // Checking "ran" with an empty store: a real result, not a skip.
      expect(statuses(external)).toEqual(["pass:"]);
    });

    test("no usable sitemap: the crawler follows links after all, so the 404 is found", async () => {
      const { stats, internal } = await audit(engine, {
        followLinks: false,
        externalLinks: false,
        sitemap: false,
      });
      expect(stats?.linkDiscoveryOff).toBeUndefined();
      expect(statuses(internal)).toEqual(["fail:"]);
    });
  });
}
