// squirrelscan/repo#3271: the internal link probe is held to what the crawl may
// request, robots.txt included, so it must read robots.txt as the same group
// the crawl was matched as: the crawl row's `robotsUserAgent`, not the probe's
// user agent. Through the real crawler and the real pre-rules phase.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";

import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (body: string) =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

function serveSite(): { origin: string; seen: string[] } {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      const ok = (body: string, type = "text/html; charset=utf-8") =>
        new Response(body, { headers: { "content-type": type } });
      if (url.pathname === "/") return ok(html('<a href="/members/old">Old</a>'));
      if (url.pathname === "/robots.txt") {
        return ok(
          "User-agent: SquirrelScan\nDisallow: /members\n\nUser-agent: *\nAllow: /\n",
          "text/plain",
        );
      }
      return new Response(html("Not found"), { status: 404, headers: { "content-type": "text/html" } });
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, seen };
}

describe("the internal link probe reads robots.txt as the crawl did (#3271)", () => {
  test("a target the crawl's robots group disallows is never probed", async () => {
    const site = serveSite();
    const crawler = await Effect.runPromise(
      createCrawler({
        config: {
          maxPages: 10,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 5_000,
          userAgent: "Mozilla/5.0 (compatible; SquirrelScan/2.0)",
          robotsUserAgent: "SquirrelScan",
          respectRobots: true,
          incremental: false,
          useCacheControl: false,
          disableLinkDiscovery: true,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(`${site.origin}/`, `${site.origin}/`));
    const crawlEnd = site.seen.length;
    // This run's config names no token: the crawl row is what decides.
    const config = {
      rule_options: {},
      rules: { enable: ["links/broken-links"] },
      crawler: { max_pages: 10, exclude: [], respect_robots: true, robots_user_agent: "" },
      external_links: { enabled: false, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
      internal_links: { enabled: true },
    } as unknown as Config;
    await Effect.runPromise(runStreamingPreRules(crawler.storage, crawlId, config, {}));
    expect(site.seen.slice(crawlEnd)).not.toContain("/members/old");
  });
});
