// #1753 end-to-end: images/image-file-size names the pages that embed an oversized image, and
// perf/total-byte-weight names the heaviest resource on the heaviest page.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { runRulesOnStorage, runStreamingRules, buildSiteContext } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const RULES = ["images/image-file-size", "perf/total-byte-weight"];
const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const BIG = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(1_200_000)}--></svg>`;
const SMALL = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;

const html = (body: string, head = "") =>
  `<!doctype html><html><head><title>Fixture page</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;

const PAGES = ["/", "/about", "/blog"];

function serve(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const ok = (body: string, type: string) =>
        new Response(body, { headers: { "content-type": type } });
      switch (url.pathname) {
        case "/":
          return ok(
            html(
              `<img src="/big.svg" width="800" height="600" alt="Hero"><a href="/about">About</a> <a href="/blog">Blog</a>`,
            ),
            "text/html; charset=utf-8",
          );
        case "/about":
          return ok(
            html(
              `<img src="/big.svg" width="400" height="300" alt="Hero again"><img src="/small.svg" width="10" height="10" alt="Small">`,
            ),
            "text/html; charset=utf-8",
          );
        case "/blog":
          return ok(
            html(`<img src="/small.svg" width="10" height="10" alt="Small">`),
            "text/html; charset=utf-8",
          );
        case "/big.svg":
          return ok(BIG, "image/svg+xml");
        case "/small.svg":
          return ok(SMALL, "image/svg+xml");
        case "/sitemap.xml":
          return ok(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PAGES.map((p) => `<url><loc>${url.origin}${p}</loc></url>`).join("")}</urlset>`,
            "application/xml",
          );
        case "/robots.txt":
          return ok("User-agent: *\nAllow: /\n", "text/plain");
      }
      return new Response("nope", { status: 404 });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

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
  const storage = crawler.storage;
  const config = {
    rule_options: {},
    rules: { enable: RULES },
    crawler: { max_pages: 10, exclude: [] },
    external_links: { enabled: false, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
    internal_links: { enabled: false },
  } as unknown as Config;
  const preRules = await Effect.runPromise(runStreamingPreRules(storage, crawlId, config, {}));
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      if (engine === "v1") {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        return yield* runRulesOnStorage(storage, crawlId, siteContext, config, preRules.assets);
      }
      return yield* runStreamingRules(storage, crawlId, config, preRules.assets);
    }) as Effect.Effect<{ siteRuleResults: Map<string, CheckResult[]> }, never, never>,
  );
  return { origin, ran };
}

for (const engine of ["v1", "v2"] as const) {
  describe(`oversized image pages (${engine}, #1753)`, () => {
    test("images/image-file-size names every page that embeds the file, in sourcePages and in meta", async () => {
      const { origin, ran } = await audit(engine);
      const checks = ran.siteRuleResults.get("images/image-file-size") ?? [];
      const fail = checks.find((c) => c.status === "fail")!;
      expect(fail.items).toHaveLength(1);
      const item = fail.items![0]!;
      expect(item.id).toBe(`${origin}/big.svg`);
      expect([...(item.sourcePages ?? [])].sort()).toEqual([`${origin}/`, `${origin}/about`]);
      expect([...((item.meta?.pages as string[]) ?? [])].sort()).toEqual([
        `${origin}/`,
        `${origin}/about`,
      ]);
      expect(item.meta?.pageCount).toBe(2);
      expect(item.label).toBe(`${origin}/big.svg (1.1 MB, embedded on 2 pages)`);
    }, 30_000);

    test("perf/total-byte-weight names the heaviest resource on the heaviest page", async () => {
      const { origin, ran } = await audit(engine);
      const check = (ran.siteRuleResults.get("perf/total-byte-weight") ?? [])[0]!;
      expect(check.message).toContain(`, largest resource ${origin}/big.svg 1172KB (`);
      expect(check.details?.heaviestResource).toBe(`${origin}/big.svg`);
      expect(check.details?.heaviestResourceKb).toBe("1172KB");
      expect(check.details?.heaviestResourceKind).toBe("images");
    }, 30_000);
  });
}
