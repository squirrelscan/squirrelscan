// pub#821: say why a link is unverifiable. The local checker knows a wall or
// challenge (`blocked`) from running out of time (`unreachable`); the cloud
// link checker also sends `awaiting-confirmation` for a first 404. The reason
// rides on the check result into the stored link row, so a re-rendered report
// and `squirrel analyze` keep it.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, runStreamingRules } from "../src/adapter";
import { checkExternalLinks, type ExternalCheckResult } from "../src/external-checker";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/wall") {
        return new Response("Forbidden", { status: 403, headers: { server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-SYD" } });
      }
      if (path === "/stall") {
        await Bun.sleep(3_000);
        return new Response("late");
      }
      return new Response("gone", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function check(
  urls: string[],
  extra: { timeoutMs?: number; bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>> } = {},
): Promise<Map<string, ExternalCheckResult>> {
  return Effect.runPromise(
    checkExternalLinks(urls, null, {
      concurrency: 4,
      timeoutMs: extra.timeoutMs ?? 2_000,
      userAgent: "squirrel-test",
      egress: { allowPrivateNetwork: true },
      ...(extra.bulkChecker ? { bulkChecker: extra.bulkChecker } : {}),
    }),
  ).then((results) => new Map(results.map((r) => [r.href, r])));
}

describe("why a link is unverifiable (pub#821)", () => {
  test("the local checker calls a wall blocked and a stall unreachable; a 404 has no reason", async () => {
    const base = serve();
    const results = await check([`${base}/wall`, `${base}/stall`, `${base}/gone`], { timeoutMs: 500 });
    expect(results.get(`${base}/wall`)).toMatchObject({ wafBlocked: true, wafProvider: "cloudflare", unverifiedReason: "blocked" });
    expect(results.get(`${base}/stall`)).toMatchObject({ wafBlocked: true, unverifiedReason: "unreachable" });
    expect(results.get(`${base}/gone`)?.status).toBe(404);
    expect(results.get(`${base}/gone`)?.unverifiedReason).toBeUndefined();
  });

  test("the cloud's reason passes through the bulk checker untouched", async () => {
    const url = "https://pending.example.com/page";
    const results = await check([url], {
      bulkChecker: async () =>
        new Map([
          [
            url,
            {
              href: url,
              status: null,
              error: null,
              redirectTarget: null,
              fromCache: false,
              wafBlocked: true,
              wafProvider: "unknown",
              unverifiedReason: "awaiting-confirmation",
            } satisfies ExternalCheckResult,
          ],
        ]),
    });
    expect(results.get(url)).toMatchObject({ wafBlocked: true, unverifiedReason: "awaiting-confirmation" });
  });

  test("the stored link row keeps the reason, and drops a value it does not know", async () => {
    const storage = new SQLiteStorage(":memory:");
    await Effect.runPromise(storage.init());
    try {
      const crawlId = await Effect.runPromise(
        storage.createCrawl({
          baseUrl: "https://site.example.com",
          seedUrl: "https://site.example.com/",
          originalUrl: "https://site.example.com/",
          startedAt: Date.now(),
          status: "completed",
          config: {} as never,
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
        } as never),
      );
      const row = (href: string, unverifiedReason?: string) =>
        Effect.runPromise(
          storage.upsertLink(crawlId, {
            href,
            isInternal: false,
            checkedAt: Date.now(),
            wafBlocked: true,
            wafProvider: "unknown",
            ...(unverifiedReason ? { unverifiedReason: unverifiedReason as never } : {}),
          }),
        );
      await row("https://pending.example.com/", "awaiting-confirmation");
      await row("https://stalls.example.com/", "unreachable");
      await row("https://future.example.com/", "rate-wobble");
      await row("https://older.example.com/");
      const links = await Effect.runPromise(storage.getLinks(crawlId));
      const reason = (href: string) => links.find((l) => l.href === href)?.unverifiedReason;
      expect(reason("https://pending.example.com/")).toBe("awaiting-confirmation");
      expect(reason("https://stalls.example.com/")).toBe("unreachable");
      expect(reason("https://future.example.com/")).toBeUndefined();
      expect(reason("https://older.example.com/")).toBeUndefined();
    } finally {
      await Effect.runPromise(storage.close().pipe(Effect.orDie));
    }
  });
});

/** A localhost site linking a walled third party (127.0.0.1) and a public link the cloud answers. */
function serveSite(): { home: string; walled: string } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const third = `http://127.0.0.1:${url.port}`;
      if (url.pathname === "/") {
        return new Response(
          `<!doctype html><html><head><title>Fixture</title></head><body><a href="${third}/wall">Partner</a> <a href="${PENDING}">Supplier</a></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("Forbidden", { status: 403, headers: { server: "cloudflare", "cf-ray": "8a1b2c3d4e5f-SYD" } });
    },
  });
  servers.push(server);
  return { home: `http://localhost:${server.port}/`, walled: `http://127.0.0.1:${server.port}/wall` };
}

const PENDING = "https://pending.example.com/page";

for (const engine of ["v1", "v2"] as const) {
  describe(`an audit carries the reason to the report (pub#821, ${engine})`, () => {
    test("the cloud's awaiting-confirmation answer is labelled; a local wall keeps its label", async () => {
      const { home, walled } = serveSite();
      const crawler = await Effect.runPromise(
        createCrawler({
          config: {
            maxPages: 1,
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
      const storage = crawler.storage;
      const config = {
        rule_options: {},
        rules: { enable: ["links/broken-external-links"] },
        crawler: { max_pages: 1, exclude: [] },
        external_links: { enabled: true, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
        internal_links: { enabled: false },
      } as unknown as Config;
      const crawlId = await Effect.runPromise(crawler.start(home, home));
      const pre = await Effect.runPromise(
        runStreamingPreRules(storage, crawlId, config, {
          externalLinks: {
            config: config.external_links,
            linkCache: null,
            bulkChecker: async (urls) =>
              new Map(
                urls
                  .filter((u) => u === PENDING)
                  .map((u) => [
                    u,
                    {
                      href: u,
                      status: null,
                      error: null,
                      redirectTarget: null,
                      fromCache: false,
                      wafBlocked: true,
                      wafProvider: "unknown",
                      unverifiedReason: "awaiting-confirmation",
                    } satisfies ExternalCheckResult,
                  ]),
              ),
          },
        }),
      );
      const ran = await Effect.runPromise(
        Effect.gen(function* () {
          if (engine === "v1") {
            const stored = yield* storage.getPages(crawlId);
            const siteContext = yield* buildSiteContext(stored);
            return yield* runRulesOnStorage(storage, crawlId, siteContext, config, pre.assets);
          }
          return yield* runStreamingRules(storage, crawlId, config, pre.assets);
        }) as Effect.Effect<{ siteRuleResults: Map<string, CheckResult[]> }, never, never>,
      );
      const row = (ran.siteRuleResults.get("links/broken-external-links") ?? []).find(
        (c) => c.name === "waf-blocked-external-links",
      );
      expect(row?.items?.map((i) => i.label).sort()).toEqual(
        [`${PENDING} (unverified: awaiting confirmation)`, `${walled} (unverified: cloudflare)`].sort(),
      );
      expect(row?.items?.find((i) => i.id === walled)?.meta).toMatchObject({ unverifiedReason: "blocked" });
    });
  });
}
