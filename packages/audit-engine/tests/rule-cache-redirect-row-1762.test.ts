// #1762: a redirect row is not a page, so the rule cache never keys it. `streamPageRules` skips it before
// `keyFor` builds a key from its empty record, which must never be looked up as if it were a cached page.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner } from "@squirrelscan/rules";

import type { StreamRuleCache } from "../src/rule-cache";
import { streamPageRules } from "../src/streaming";
import { getGoldenBaselineConfig } from "./helpers/golden-baseline";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const html = (title: string, body = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${words(40)}</p>${body}</main></body></html>`;

describe("the rule cache never keys a redirect row (#1762)", () => {
  test("keyFor sees the content pages and not a redirecting URL, marker or legacy row", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        const ok = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
        if (pathname === "/") return ok(html("Home", `<a href="/old">Old</a>`));
        if (pathname === "/old") return new Response(null, { status: 301, headers: { location: "/new" } });
        if (pathname === "/new") return ok(html("New"));
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
      }),
    );
    const storage = crawler.storage as SQLiteStorage;
    const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
    const pages = await Effect.runPromise(storage.getPages(crawlId));
    // The crawl really holds a redirect row, or the assertion below proves nothing.
    expect(pages.find((p) => p.normalizedUrl === `${origin}/old`)?.status).toBeGreaterThanOrEqual(300);
    // An older crawl's row: the destination's markup filed under the redirecting URL (2xx, auditable shape).
    // It is in the page universe, so only the redirect guard keeps it out of the cache.
    const dest = pages.find((p) => p.normalizedUrl === `${origin}/new`)!;
    await Effect.runPromise(
      storage.upsertPage(crawlId, {
        ...dest,
        url: `${origin}/legacy`,
        normalizedUrl: `${origin}/legacy`,
        finalUrl: `${origin}/new`,
        redirectChain: {
          sourceUrl: `${origin}/legacy`,
          finalUrl: `${origin}/new`,
          hops: [
            { url: `${origin}/legacy`, statusCode: 301, type: "http" },
            { url: `${origin}/new`, statusCode: 200, type: "http" },
          ],
          chainLength: 1,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
      }),
    );

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
    const siteData = { baseUrl: origin, pages: [], robotsTxt: null, sitemaps: null } as unknown as Parameters<
      typeof streamPageRules
    >[3];
    await Effect.runPromise(
      streamPageRules(storage, crawlId, runner, siteData, { batchSize: 20, collectors: [], ruleCache: cache }) as Effect.Effect<
        unknown,
        never,
        never
      >,
    );
    expect(keyed).toContain(`${origin}/`);
    expect(keyed).toContain(`${origin}/new`);
    expect(keyed).not.toContain(`${origin}/old`);
    expect(keyed).not.toContain(`${origin}/legacy`);
  }, 60_000);
});
