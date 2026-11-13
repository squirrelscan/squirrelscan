// `scanScope.respectRobots` and `robotsBlockedPages` on engine-assembled reports (#1782), from a real crawl of
// a loopback site whose robots.txt disallows /private/. Both builders (v1 and the streaming v2) are driven.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler } from "@squirrelscan/crawler";

import { buildV2Report } from "../src/report-stream";
import { generateReportFromStorage, runStreamingRules, type PreFetchedAssets } from "../src/adapter";

const CONFIG = { rule_options: {}, rules: { enable: [] } } as unknown as Config;
const ASSETS: PreFetchedAssets = { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] };
const HTML = { "content-type": "text/html" };

const page = (title: string, links: string[]) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} page title for testing</title></head><body><main><h1>${title}</h1><p>${"Some real content. ".repeat(30)}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</main></body></html>`;

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /private/\n", { headers: { "content-type": "text/plain" } });
      if (path === "/") return new Response(page("Home", ["/about", "/private/a", "/private/b"]), { headers: HTML });
      return new Response(page(path, []), { headers: HTML });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function crawlAndReport(respectRobots: boolean) {
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
        respectRobots,
        incremental: false,
        useCacheControl: false,
      },
    }),
  );
  const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
  const storage = crawler.storage;
  const pages = await Effect.runPromise(storage.getPages(crawlId));
  const result = await Effect.runPromise(
    runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 8 }) as Effect.Effect<never, never, never>,
  );
  const scanScope = { origin: "cloud" as const, pagesCrawled: pages.length, capped: false, respectRobots };
  const v1 = await Effect.runPromise(generateReportFromStorage(storage, crawlId, result, { scanScope }));
  const v2 = await Effect.runPromise(buildV2Report(storage, crawlId, result as never, { scanScope }));
  const bare = await Effect.runPromise(generateReportFromStorage(storage, crawlId, result));
  return { pages: pages.map((p) => new URL(p.url).pathname).sort(), v1, v2, bare };
}

describe("engine reports carry robots scope (#1782)", () => {
  test("honoured: the two /private/ pages robots.txt disallows are counted and were not audited", async () => {
    const { pages, v1, v2 } = await crawlAndReport(true);
    expect(pages).toEqual(["/", "/about"]);
    for (const r of [v1, v2]) {
      expect(r.scanScope?.respectRobots).toBe(true);
      expect(r.scanScope?.robotsBlockedPages).toBe(2);
      expect(r.scanScope?.origin).toBe("cloud");
    }
  }, 60_000);

  test("not honoured: respectRobots is false, the /private/ pages were audited, nothing counted", async () => {
    const { pages, v1, v2 } = await crawlAndReport(false);
    expect(pages).toEqual(["/", "/about", "/private/a", "/private/b"]);
    for (const r of [v1, v2]) {
      expect(r.scanScope?.respectRobots).toBe(false);
      expect(r.scanScope?.robotsBlockedPages).toBe(0);
    }
  }, 60_000);

  test("a caller that passes no scope gets no scanScope, as before", async () => {
    const { bare } = await crawlAndReport(true);
    expect(bare.scanScope).toBeUndefined();
  }, 60_000);
});
