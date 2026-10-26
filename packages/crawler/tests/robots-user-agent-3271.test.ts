// squirrelscan/repo#3271: `[crawler] robots_user_agent`, the product token
// robots.txt groups are matched against when it differs from the user agent the
// requests send. robots-parser matches a group on the part of the user agent
// before its first `/`, so a browser-style string such as
// `Mozilla/5.0 (compatible; SquirrelScan/2.0; +https://...)` was matched as the
// `Mozilla` group, never as `SquirrelScan`.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { createRobotsEvaluator, fetchRobotsEvaluator } from "../src/robots";

const BROWSER_STYLE = "Mozilla/5.0 (compatible; SquirrelScan/2.0; +https://example.com/crawler)";

const ROBOTS = [
  "User-agent: SquirrelScan",
  "Disallow: /private",
  "Crawl-delay: 1",
  "",
  "User-agent: *",
  "Allow: /",
].join("\n");

describe("robots.txt groups are matched on the robots token (#3271)", () => {
  test("a browser-style user agent alone is matched as its first token, not the bot's", () => {
    const evaluator = createRobotsEvaluator("https://example.com/robots.txt", ROBOTS, BROWSER_STYLE);
    expect(evaluator.isAllowed("https://example.com/private/page")).toBe(true);
    expect(evaluator.crawlDelayMs).toBeNull();
  });

  test("the robots token selects the bot's group, Disallow and Crawl-delay included", () => {
    const evaluator = createRobotsEvaluator("https://example.com/robots.txt", ROBOTS, "SquirrelScan");
    expect(evaluator.isAllowed("https://example.com/private/page")).toBe(false);
    expect(evaluator.isAllowed("https://example.com/public")).toBe(true);
    expect(evaluator.crawlDelayMs).toBe(1_000);
  });

  test("the fetch still sends the user agent; only the group match uses the token", async () => {
    const agents: string[] = [];
    const site = Bun.serve({
      port: 0,
      fetch(req) {
        agents.push(req.headers.get("user-agent") ?? "");
        return new Response(ROBOTS, { headers: { "content-type": "text/plain" } });
      },
    });
    try {
      const origin = `http://127.0.0.1:${site.port}`;
      const withToken = await Effect.runPromise(
        fetchRobotsEvaluator(origin, BROWSER_STYLE, true, undefined, undefined, "SquirrelScan"),
      );
      expect(withToken.isAllowed(`${origin}/private/x`)).toBe(false);
      const without = await Effect.runPromise(fetchRobotsEvaluator(origin, BROWSER_STYLE, true));
      expect(without.isAllowed(`${origin}/private/x`)).toBe(true);
      expect(agents).toEqual([BROWSER_STYLE, BROWSER_STYLE]);
    } finally {
      site.stop(true);
    }
  });

  test("a crawl honouring robots skips the token's disallowed pages and sends its user agent", async () => {
    const requests: Array<{ path: string; agent: string }> = [];
    const site = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push({ path, agent: req.headers.get("user-agent") ?? "" });
        if (path === "/robots.txt") {
          return new Response(ROBOTS.replace("Crawl-delay: 1", "Crawl-delay: 0"), {
            headers: { "content-type": "text/plain" },
          });
        }
        if (path === "/") {
          return new Response(
            '<html><head><title>home</title></head><body><a href="/private/a">p</a><a href="/public">q</a></body></html>',
            { headers: { "content-type": "text/html" } },
          );
        }
        if (path === "/public" || path === "/private/a") {
          return new Response(`<html><head><title>${path}</title></head><body>x</body></html>`, {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${site.port}`;
    const config: Partial<CrawlerConfig> = {
      maxPages: 10,
      concurrency: 1,
      perHostConcurrency: 1,
      delayMs: 0,
      perHostDelayMs: 0,
      timeoutMs: 5_000,
      userAgent: BROWSER_STYLE,
      robotsUserAgent: "SquirrelScan",
      respectRobots: true,
      incremental: false,
      useCacheControl: false,
      breadthFirst: true,
      coverageMode: "full",
      discoveryProbes: [],
    };
    try {
      const crawler = await Effect.runPromise(createCrawler({ config }));
      const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
      const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
      const crawled = new Set(pages.map((p) => new URL(p.finalUrl).pathname));
      expect(crawled.has("/public")).toBe(true);
      expect(crawled.has("/private/a")).toBe(false);
      expect(requests.some((r) => r.path === "/private/a")).toBe(false);
      for (const r of requests) expect(r.agent, r.path).toBe(BROWSER_STYLE);
      // The token travels with the crawl, so a resumed crawl matches the same group.
      const crawl = await Effect.runPromise(crawler.storage.getCrawl(crawlId));
      expect(crawl?.config.robotsUserAgent).toBe("SquirrelScan");
    } finally {
      site.stop(true);
    }
  });
});
