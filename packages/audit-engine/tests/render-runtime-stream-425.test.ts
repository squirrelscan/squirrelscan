// pub#425: `streamPageRules` hands each page its render runtime as `PageData.renderRuntime`, and a page
// that has one never goes through the rule cache: the cache key does not hash that in-memory crawl data,
// so a replay could serve verdicts from a different render.

import type { Config } from "@squirrelscan/config";
import type { RenderRuntimeDiagnostics } from "@squirrelscan/core-contracts";
import type { PageData } from "@squirrelscan/rules";

import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner } from "@squirrelscan/rules";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { StreamRuleCache } from "../src/rule-cache";

import { streamPageRules } from "../src/streaming";
import { getGoldenBaselineConfig } from "./helpers/golden-baseline";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const html = (title: string, body = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

describe("render runtime in the streamed page pass (pub#425)", () => {
  test("the page with runtime gets it on PageData and skips the cache; the other page is keyed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        const ok = (body: string) =>
          new Response(body, { headers: { "content-type": "text/html" } });
        if (pathname === "/")
          return ok(html("Home", `<a href="/book">Book</a>`));
        if (pathname === "/book") return ok(html("Book"));
        return new Response("nf", { status: 404 });
      },
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;
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
      })
    );
    const storage = crawler.storage as SQLiteStorage;
    const crawlId = await Effect.runPromise(
      crawler.start(`${origin}/`, `${origin}/`)
    );

    const runtime: RenderRuntimeDiagnostics = { cspViolations: [] };
    const renderRuntime = new Map([[`${origin}/book`, runtime]]);

    const keyed: string[] = [];
    const cache: StreamRuleCache = {
      keyFor: async (page) => {
        keyed.push(page.normalizedUrl);
        return `key:${page.normalizedUrl}`;
      },
      load: async () => new Map(),
      putFresh: () => {},
      carryForward: () => {},
    };
    const runner = createRunner(getGoldenBaselineConfig() as unknown as Config);
    const seen = new Map<string, PageData["renderRuntime"]>();
    const realRun = runner.runPageRules.bind(runner);
    runner.runPageRules = (page, ...rest) => {
      seen.set(page.url, page.renderRuntime);
      return realRun(page, ...rest);
    };
    const siteData = {
      baseUrl: origin,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
    } as unknown as Parameters<typeof streamPageRules>[3];
    await Effect.runPromise(
      streamPageRules(storage, crawlId, runner, siteData, {
        batchSize: 20,
        collectors: [],
        ruleCache: cache,
        renderRuntime,
      }) as Effect.Effect<unknown, never, never>
    );

    expect(seen.get(`${origin}/book`)).toBe(runtime);
    expect(seen.has(`${origin}/`)).toBe(true);
    expect(seen.get(`${origin}/`)).toBeUndefined();
    expect(keyed).toContain(`${origin}/`);
    expect(keyed).not.toContain(`${origin}/book`);
  }, 60_000);
});
