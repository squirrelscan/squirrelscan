// repo#2729 end-to-end: a crawl that did not follow links and an audit with
// external link checking off must produce "not checked" link results, through
// the real crawler, the real rules and BOTH rule paths (v1 and streaming).
//
// The fixture's home page links a page the sitemap lists, an internal 404 the
// sitemap does not list, and an external URL (the same server under another
// host name, so a real check can reach it). Before repo#2729 the quick crawl
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
} from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const RULES = ["links/broken-links", "links/broken-external-links"];

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

/** Every path the fixture server was asked for, across the last audit. */
let requested: string[] = [];

function serveSite(opts: { sitemap: boolean }): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(url.pathname);
      const origin = url.origin;
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      switch (url.pathname) {
        case "/":
          return ok(
            html(
              `<a href="/about">About</a> <a href="/missing">Old</a> <a href="http://127.0.0.1:${url.port}/elsewhere">Elsewhere</a>`,
            ),
          );
        case "/about":
          return ok(
            html(
              `<a href="/">Home</a> <a href="http://127.0.0.1:${url.port}/elsewhere">Elsewhere</a> <a href="http://127.0.0.1:${url.port}/elsewhere-two">Elsewhere too</a>`,
            ),
          );
        case "/elsewhere":
        case "/elsewhere-two":
          return ok(html("Another site"));
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
  opts: {
    followLinks: boolean;
    externalLinks: boolean;
    internalLinks?: boolean;
    maxLinks?: number;
    sitemap?: boolean;
    exclude?: string[];
  },
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
  const config = {
    rule_options: {},
    rules: { enable: RULES },
    crawler: { max_pages: 10, exclude: opts.exclude ?? [] },
    external_links: {
      enabled: opts.externalLinks,
      concurrency: 1,
      timeout_ms: 5_000,
      cache_ttl_days: 1,
      ...(opts.maxLinks !== undefined ? { max_links: opts.maxLinks } : {}),
    },
    internal_links: { enabled: opts.internalLinks ?? true },
  } as unknown as Config;
  // The real pre-rules phase, as the CLI and the cloud container run it: the
  // external-link check gated on the setting, then the asset phase, which
  // carries the internal link probe.
  const preRules = await Effect.runPromise(
    runStreamingPreRules(storage, crawlId, config, {
      ...(opts.externalLinks
        ? { externalLinks: { config: config.external_links, linkCache: null } }
        : {}),
    }),
  );
  const assets = preRules.assets;

  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, assets);
      }
      return yield* runStreamingRules(storage, crawlId, config, assets);
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
    test("quick-style crawl, both link checks off: both rules are not checked, neither passes", async () => {
      const { stats, internal, external } = await audit(engine, {
        followLinks: false,
        externalLinks: false,
        internalLinks: false,
      });
      expect(stats?.linkDiscoveryOff).toBe(true);
      expect(statuses(internal)).toEqual(["skipped:link-targets-not-fetched"]);
      expect(internal[0]!.details).toEqual({
        linkTargets: 3,
        unfetchedTargets: 1,
        probedTargets: 0,
        notFetched: { off: 1 },
      });
      expect(internal[0]!.message).toContain("internal link checks were off");
      expect(statuses(external)).toEqual(["skipped:external-links-not-checked"]);
      expect(external[0]!.details).toEqual({ externalLinksFound: 2 });
    });

    test("quick-style crawl with the default internal link probe: the linked 404 is found", async () => {
      // repo#2729 item 3: the crawl never fetched /missing, the probe did.
      const { stats, internal } = await audit(engine, {
        followLinks: false,
        externalLinks: false,
      });
      expect(stats?.linkDiscoveryOff).toBe(true);
      expect(statuses(internal)).toEqual(["fail:"]);
      expect(internal[0]!.items?.map((i) => [i.id, i.meta?.probed])).toEqual([
        [expect.stringContaining("/missing"), true],
      ]);
    });

    test("the probe stays inside the crawl scope: an excluded target is not requested", async () => {
      // [crawler] exclude keeps /missing out of the crawl, and out of the probe.
      const { internal } = await audit(engine, {
        followLinks: false,
        externalLinks: false,
        exclude: ["/missing"],
      });
      expect(statuses(internal)).toEqual(["skipped:link-targets-not-fetched"]);
      expect(internal[0]!.message).toContain("outside the crawl scope");
      // And nothing ever asked for it: not the crawl, not the probe.
      expect(requested.filter((path) => path === "/missing")).toEqual([]);
    });

    test("over the per-audit external link limit: the most-linked are checked, the rest not checked", async () => {
      const { stats, external } = await audit(engine, {
        followLinks: true,
        externalLinks: true,
        maxLinks: 1,
      });
      expect(stats?.externalLinkCheck).toEqual({ found: 2, checked: 1, cap: 1 });
      expect(statuses(external)).toEqual(["pass:", "skipped:external-links-over-cap"]);
      // /elsewhere is on both pages, /elsewhere-two on one: the first is the one checked.
      expect(external[0]!.message).toBe("All 1 external link(s) are working");
      expect(external[1]!.message).toBe(
        "1 of 2 external link(s) were not checked: over this audit's limit of 1, which checks the most-linked first",
      );
    });

    test("links followed: the internal 404 is found, and nothing is marked not checked", async () => {
      const { stats, internal, external } = await audit(engine, {
        followLinks: true,
        externalLinks: true,
      });
      expect(stats?.linkDiscoveryOff).toBeUndefined();
      expect(statuses(internal)).toEqual(["fail:"]);
      expect(internal[0]!.items?.map((i) => i.id)).toEqual([expect.stringContaining("/missing")]);
      expect(statuses(external)).toEqual(["pass:"]);
      expect(external[0]!.message).toBe("All 2 external link(s) are working");
      // Unset max_links is the page budget, at least 200.
      expect(stats?.externalLinkCheck).toEqual({ found: 2, checked: 2, cap: 200 });
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
