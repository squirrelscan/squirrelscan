// repo#2729 AC4, as regression tests: does a Surface-style crawl still report (a) a 404 that shares an
// already-sampled URL pattern, and (b) a 404 the previous run found (#1146) on a site larger than
// the page budget? Real crawler, real pre-rules phase (the internal link check), real rule.
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { runStreamingRules } from "../src/adapter";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

/** `pages`: live paths. `dead`: paths answered 404 (they are linked from the home page). */
function serveSite(pages: string[], dead: string[]): string {
  const links = [...pages, ...dead].map((p) => `<a href="${p}">${p}</a>`).join(" ");
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname, origin } = new URL(req.url);
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      if (pathname === "/") return ok(html(links));
      if (pathname === "/robots.txt") return ok("User-agent: *\nAllow: /\n", "text/plain");
      if (pathname === "/sitemap.xml") {
        return ok(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, "application/xml");
      }
      if (pages.includes(pathname)) return ok(html(`page ${pathname} <a href="/">home</a>`));
      return new Response(html("Not found"), { status: 404, headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

async function audit(opts: {
  pages: string[];
  dead: string[];
  maxPages: number;
  coverageMode: "surface" | "quick";
  deprioritizedPaths?: string[];
}) {
  const origin = serveSite(opts.pages, opts.dead);
  const crawler = await Effect.runPromise(
    createCrawler({
      config: {
        maxPages: opts.maxPages,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: false,
        useCacheControl: false,
        coverageMode: opts.coverageMode,
        breadthFirst: true,
        deprioritizedUrls: (opts.deprioritizedPaths ?? []).map((p) => `${origin}${p}`),
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
  const config = {
    rule_options: {},
    rules: { enable: ["links/broken-links"] },
    crawler: { max_pages: opts.maxPages, exclude: [] },
    external_links: { enabled: false },
    internal_links: { enabled: true },
  } as unknown as Config;
  const preRules = await Effect.runPromise(runStreamingPreRules(storage, crawlId, config, {}));
  const ran = (await Effect.runPromise(
    runStreamingRules(storage, crawlId, config, preRules.assets) as Effect.Effect<
      { siteRuleResults: Map<string, CheckResult[]> },
      never,
      never
    >,
  )) as { siteRuleResults: Map<string, CheckResult[]> };
  const pagesCrawled = (await Effect.runPromise(storage.getPages(crawlId))).map((p) => new URL(p.url).pathname);
  const checks = ran.siteRuleResults.get("links/broken-links") ?? [];
  const broken = checks
    .filter((c) => c.status === "fail")
    .flatMap((c) => c.items ?? [])
    .map((i) => ({ path: new URL(i.id).pathname, status: i.meta?.statusCode, sources: i.sourcePages }));
  return { broken, pagesCrawled, checks };
}

describe("repo#2729 AC4 characterization (Surface-style crawl)", () => {
  test("a 404 sharing an already-sampled URL pattern is reported with its status and source page", async () => {
    const { broken, pagesCrawled } = await audit({
      pages: ["/blog/a", "/blog/b", "/blog/c"],
      dead: ["/blog/gone"],
      maxPages: 10,
      coverageMode: "surface",
    });
    expect(broken.map((b) => b.path)).toContain("/blog/gone");
    expect(broken.find((b) => b.path === "/blog/gone")?.status).toBe(404);
    expect(broken.find((b) => b.path === "/blog/gone")?.sources?.length).toBeGreaterThan(0);
  });

  test("a 404 the previous run found (#1146) on a site larger than the budget is still reported", async () => {
    const live = Array.from({ length: 8 }, (_, i) => `/p${i}`);
    const { broken, pagesCrawled } = await audit({
      pages: live,
      dead: ["/old-page"],
      maxPages: 3,
      coverageMode: "surface",
      deprioritizedPaths: ["/old-page"],
    });
    expect(pagesCrawled).not.toContain("/old-page");
    expect(broken.map((b) => b.path)).toContain("/old-page");
    expect(broken.find((b) => b.path === "/old-page")?.status).toBe(404);
  });
});
