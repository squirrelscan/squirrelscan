// squirrelscan/repo#3346: the crawl built each request's headers by spreading
// records, `{ "User-Agent": ua, Accept, ...customHeaders }`. A custom header
// whose name differed only in case from a built-in one (`user-agent`, `accept`)
// became a second key, and the request sent both values combined
// ("squirrel-test, custom-agent"). A custom header now replaces the built-in one
// on every request the crawl sends to the audited site.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

type Seen = { path: string; userAgent: string | null; accept: string | null };

function serve(): { origin: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        userAgent: req.headers.get("user-agent"),
        accept: req.headers.get("accept"),
      });
      const origin = `http://localhost:${url.port}`;
      switch (url.pathname) {
        case "/":
          return new Response(
            `<!doctype html><html><head><title>Home</title></head><body><a href="/about">About</a></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        case "/robots.txt":
          return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
            headers: { "content-type": "text/plain" },
          });
        case "/sitemap.xml":
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/about</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        default:
          return new Response(
            `<!doctype html><html><head><title>Page</title></head><body>Page</body></html>`,
            { headers: { "content-type": "text/html" } },
          );
      }
    },
  });
  servers.push(server);
  return { origin: `http://localhost:${server.port}`, seen };
}

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 3,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 3000,
  userAgent: "squirrel-test",
  respectRobots: true,
  incremental: false,
  useCacheControl: false,
};

describe("custom headers that differ only in case from a built-in one (repo#3346)", () => {
  test("replace it on every request the crawl sends, never combined with it", async () => {
    const { origin, seen } = serve();
    const storage = new SQLiteStorage(":memory:");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawler = yield* createCrawler({
          config: {
            ...CONFIG,
            headers: { "user-agent": "custom-agent", accept: "text/x-custom" },
          },
          storage,
        });
        yield* crawler.start(`${origin}/`, `${origin}/`);
      }),
    );

    // Non-vacuous: pages, robots.txt, the sitemap and the root probes all went out.
    const paths = new Set(seen.map((s) => s.path));
    for (const path of ["/", "/about", "/robots.txt", "/sitemap.xml", "/llms.txt"]) {
      expect(paths).toContain(path);
    }
    // No request carried two values for one name.
    expect(
      seen
        .filter((s) => s.userAgent?.includes("custom-agent") && s.userAgent !== "custom-agent")
        .map((s) => s.path),
    ).toEqual([]);
    expect(
      seen
        .filter((s) => s.accept?.includes("text/x-custom") && s.accept !== "text/x-custom")
        .map((s) => s.path),
    ).toEqual([]);
    // The agent-access probe of `/` keeps its fixed identities over the custom agent.
    const homeAgents = seen.filter((s) => s.path === "/").map((s) => s.userAgent ?? "");
    expect(homeAgents.some((ua) => ua.includes("GPTBot"))).toBe(true);
    expect(homeAgents.some((ua) => ua.includes("Claude-User"))).toBe(true);
    // The crawl's own requests send the custom agent alone. (`/` is also asked
    // by the seed probe, which sends only the crawl's agent, and by the
    // agent-access probe as its fixed identities, both on purpose.)
    for (const s of seen.filter((s) => s.path !== "/")) {
      expect(s.userAgent).toBe("custom-agent");
      // The markdown probe's Accept is the negotiation it tests: always its own.
      if (s.path === "/index.md") expect(s.accept).not.toContain("text/x-custom");
      else expect(s.accept).toBe("text/x-custom");
    }
  });
});
