// squirrelscan/repo#3390 end-to-end: with robots.txt respected, the GraphQL
// probe never requests a path the crawl's own robots group (`SquirrelScan`)
// disallows, even when the `*` group allows it. Through the real crawler, the
// real pre-rules phase and both rule engines, with an active probe budget.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";
import { createProbeBudget } from "@squirrelscan/rules";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const ROBOTS = "User-agent: SquirrelScan\nDisallow: /graphql\n\nUser-agent: *\nAllow: /\n";

function serveSite(): { origin: string; seen: string[] } {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (url.pathname === "/") {
        return new Response(
          "<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture</h1></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/robots.txt") {
        return new Response(ROBOTS, { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, seen };
}

async function auditPaths(engine: "v1" | "v2", respectRobots: boolean): Promise<string[]> {
  const site = serveSite();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 5,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "Mozilla/5.0 (compatible; squirrel-test)",
        robotsUserAgent: "SquirrelScan",
        respectRobots,
        incremental: false,
        useCacheControl: false,
        disableLinkDiscovery: true,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${site.origin}/`, `${site.origin}/`));
  const storage = crawler.storage as SQLiteStorage;
  const crawlEnd = site.seen.length;
  // This run's config names another token: the crawl row is what decides.
  const config = {
    rule_options: {},
    rules: { enable: ["security/graphql-introspection"] },
    crawler: { max_pages: 5, exclude: [], respect_robots: true, robots_user_agent: "OtherBot" },
    external_links: { enabled: false, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
    internal_links: { enabled: false },
  } as unknown as Config;
  const scope = { probe: createProbeBudget({ level: "active", budgetMs: 30_000 }) };
  const preRules = await Effect.runPromise(runStreamingPreRules(storage, crawlId, config, {}));
  await Effect.runPromise(
    Effect.gen(function* () {
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, preRules.assets, scope);
      }
      return yield* runStreamingRules(storage, crawlId, config, preRules.assets, scope);
    }) as unknown as Effect.Effect<unknown, never, never>,
  );
  return site.seen.slice(crawlEnd);
}

describe("the GraphQL probe reads robots.txt as the crawl did (#3390)", () => {
  for (const engine of ["v1", "v2"] as const) {
    test(`${engine}: the crawl's SquirrelScan group keeps /graphql unprobed while * allows it`, async () => {
      const paths = await auditPaths(engine, true);
      // The probe ran: the conventional path the group allows was requested.
      expect(paths).toContain("/api/graphql");
      expect(paths).not.toContain("/graphql");
    }, 30_000);

    test(`${engine}: a crawl that ignored robots.txt reads the * group`, async () => {
      const paths = await auditPaths(engine, false);
      expect(paths).toContain("/graphql");
      expect(paths).toContain("/api/graphql");
    }, 30_000);
  }
});
