// #2096 end to end: a targeted run with a comparison set. A real server records every request, so "fetched
// once" is what the site saw. A site rule that declares `comparisonSet: "listed-pages"` runs over targets plus
// the comparison set, any other site rule stays skipped with `targeted-run`, and without a comparison set
// nothing changes.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { TARGETED_RUN_SKIP_REASON, type CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

// /p/1, /p/2 and /p/5 share one description; /p/3 has its own.
const DESCRIPTIONS: Record<string, string> = {
  "/p/1": "The same words everywhere",
  "/p/2": "The same words everywhere",
  "/p/5": "The same words everywhere",
  "/p/3": "Something else entirely",
};

function serve(): { origin: string; hits: string[] } {
  const hits: string[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
      if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
      const desc = DESCRIPTIONS[pathname] ?? "";
      return new Response(
        `<!doctype html><html lang="en"><head><title>${pathname}</title><meta name="description" content="${desc}"></head><body><h1>Page</h1><a href="/p/9">more</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, hits };
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["content/duplicate-description", "links/click-depth", "crawl/schema-noindex-conflict"] },
  crawler: { max_pages: 50, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(
  engine: "v1" | "v2",
  targets: string[],
  compare: string[] | undefined,
) {
  const { origin, hits } = serve();
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: 50,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: true,
        incremental: false,
        useCacheControl: false,
        targetUrls: targets.map((t) => `${origin}${t}`),
        ...(compare ? { compareUrls: compare.map((t) => `${origin}${t}`) } : {}),
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage as SQLiteStorage;
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
  return { hits, checks };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`a targeted run with a comparison set (${engine})`, () => {
    test("duplicate-description judges targets plus the set; the site sees each page once; unbounded rules still skip", async () => {
      // /p/2 is in both lists: one fetch. /p/5 is in neither: never fetched, never part of the cluster.
      const r = await audit(engine, ["/p/1", "/p/2"], ["/p/2", "/p/3"]);

      expect([...r.hits].sort()).toEqual(["/p/1", "/p/2", "/p/3", "/robots.txt"]);

      const dup = r.checks("content/duplicate-description");
      const fail = dup.find((c) => c.status === "warn");
      expect(fail, "the cluster is found over the fetched pages").toBeDefined();
      const clusterPaths = (fail?.items ?? [])
        .flatMap((i) => i.sourcePages ?? [])
        .map((u) => new URL(u).pathname)
        .sort();
      expect(clusterPaths).toEqual(["/p/1", "/p/2"]);
      expect(dup.some((c) => c.skipReason === TARGETED_RUN_SKIP_REASON)).toBe(false);

      // A site rule that judges the whole site is not given the set: not checked, never a pass.
      const depth = r.checks("links/click-depth");
      expect(depth.length).toBeGreaterThan(0);
      expect(depth.every((c) => c.status === "skipped" && c.skipReason === TARGETED_RUN_SKIP_REASON)).toBe(true);
    });

    test("without a comparison set the same rule is not checked, never clean", async () => {
      const r = await audit(engine, ["/p/1", "/p/2"], undefined);
      const dup = r.checks("content/duplicate-description");
      expect(dup.length).toBeGreaterThan(0);
      expect(dup.every((c) => c.status === "skipped" && c.skipReason === TARGETED_RUN_SKIP_REASON)).toBe(true);
    });
  });
}
