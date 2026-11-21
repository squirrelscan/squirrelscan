// pub#2093 end-to-end: the `<image:loc>` entries of a sitemap reach images/sitemap-missing through
// the real crawler, store and rule path. The parser kept them, but `sitemap_urls` had no column for
// them and the adapter rebuilt each sitemap URL field by field, so in a real audit the rule saw no
// image entries anywhere and always skipped.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** `/listed` has its og:image in its sitemap image entries; `/missing` lists a different image. */
function serve(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname, origin } = new URL(req.url);
      if (pathname === "/sitemap.xml") {
        const entry = (path: string, image: string) =>
          `<url><loc>${origin}${path}</loc><image:image><image:loc>${origin}${image}</image:loc></image:image></url>`;
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${entry("/", "/img/home.jpg")}${entry("/listed", "/img/listed.jpg")}${entry("/missing", "/img/other.jpg")}</urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (pathname === "/robots.txt") {
        return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
          headers: { "content-type": "text/plain" },
        });
      }
      const image = pathname === "/" ? "/img/home.jpg" : pathname === "/listed" ? "/img/listed.jpg" : "/img/missing.jpg";
      return new Response(
        `<!doctype html><html lang="en"><head><title>Fixture page</title><meta property="og:image" content="${origin}${image}"></head><body><h1>Fixture</h1><a href="/listed">a</a> <a href="/missing">b</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["images/sitemap-missing"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function audit(engine: "v1" | "v2") {
  const origin = serve();
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
  const checks = (ran.ruleResultsMap.get("images/sitemap-missing")?.checks ?? []) as CheckResult[];
  const on = (path: string) => checks.find((x) => x.pageUrl === `${origin}${path}`)?.status;
  return { on, checks };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`images/sitemap-missing sees stored sitemap image entries (pub#2093, ${engine})`, () => {
    test("a listed main image passes and an unlisted one is reported, not skipped", async () => {
      const { on, checks } = await audit(engine);
      expect(checks.some((c) => c.status === "skipped")).toBe(false);
      expect(on("/listed")).toBe("pass");
      expect(on("/missing")).toBe("info");
    });
  });
}
