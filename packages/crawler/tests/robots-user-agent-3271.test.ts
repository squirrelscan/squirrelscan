// squirrelscan/repo#3271: `[crawler] robots_user_agent`, the product token
// robots.txt groups are matched against when it differs from the user agent the
// requests send. robots-parser matches a group on the part of the user agent
// before its first `/`, so a browser-style string such as
// `Mozilla/5.0 (compatible; SquirrelScan/2.0; +https://...)` was matched as the
// `Mozilla` group, never as `SquirrelScan`.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";
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
      // An empty token matches on the user agent, as before.
      const empty = await Effect.runPromise(
        fetchRobotsEvaluator(origin, BROWSER_STYLE, true, undefined, undefined, ""),
      );
      expect(empty.isAllowed(`${origin}/private/x`)).toBe(true);
      expect(agents).toEqual([BROWSER_STYLE, BROWSER_STYLE, BROWSER_STYLE]);
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

  test("a resumed crawl matches the group its crawl row records, an older row its user agent", async () => {
    const requests: string[] = [];
    const site = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(path);
        if (path === "/robots.txt") {
          return new Response(ROBOTS.replace("Crawl-delay: 1", "Crawl-delay: 0"), {
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response(
          `<html><head><title>${path}</title></head><body><a href="/private/a">p</a></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const origin = `http://127.0.0.1:${site.port}`;
    const resume = async (recorded: Record<string, unknown>) => {
      requests.length = 0;
      const storage = await Effect.runPromise(createTestStorage());
      const config = {
        maxPages: 10,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: BROWSER_STYLE,
        followRedirects: true,
        respectRobots: true,
        incremental: false,
        include: [],
        exclude: [],
        allowQueryParams: [],
        dropQueryPrefixes: [],
        allowedDomains: [],
        ...recorded,
      };
      const crawlId = await Effect.runPromise(
        storage.createCrawl({
          baseUrl: origin,
          seedUrl: `${origin}/`,
          originalUrl: `${origin}/`,
          startedAt: Date.now(),
          status: "paused",
          config: config as never,
          stats: {
            pagesTotal: 0,
            pagesFetched: 0,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
        }),
      );
      await Effect.runPromise(
        storage.upsertFrontier(crawlId, {
          normalizedUrl: `${origin}/`,
          rawUrl: `${origin}/`,
          depth: 0,
          priority: 1,
          status: "pending",
          source: "seed",
          enqueuedAt: Date.now(),
          retryCount: 0,
        }),
      );
      // This run's own config names the token; the crawl row decides.
      const crawler = await Effect.runPromise(
        createCrawler({
          config: { ...config, robotsUserAgent: "SquirrelScan", discoveryProbes: [] },
          storage,
        }),
      );
      await Effect.runPromise(crawler.resumeFromStorage(crawlId));
      return [...requests];
    };
    try {
      expect(await resume({ robotsUserAgent: "SquirrelScan" })).not.toContain("/private/a");
      // Recorded before the token existed: matched on its user agent, as it started.
      expect(await resume({})).toContain("/private/a");
    } finally {
      site.stop(true);
    }
  });
});
