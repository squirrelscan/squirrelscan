// #1021: `squirrel analyze` streams the crawl in page batches instead of
// materializing it. Parity: the streamed run yields the same checks as the
// resident path (buildSiteContext + runRulesOnStorage) over the same crawl, and
// the rules phase keeps no page-count-scaled heap.

import { createEntityMapCollector } from "@squirrelscan/audit-engine/entity-map/collect";
import { clearRequestAsync } from "@squirrelscan/rules";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlMetadata, PageRecord } from "@/crawler/storage/types";

import {
  buildSiteContext,
  fetchResourceAssets,
  runRulesOnStorage,
} from "@/audit/adapter";
import { entityMapSite } from "@/audit/entity-map";
import { getDefaultConfig, type Config } from "@/config";
import { analyzeStoredCrawl, configForCrawl } from "@/controllers/analyze";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const BASE = "https://parity.example.com";
const real = globalThis.fetch;

beforeAll(() => {
  // Offline: every probe answers a bare 200.
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      ),
    { preconnect: real.preconnect }
  );
});
afterAll(() => {
  globalThis.fetch = real;
  clearRequestAsync();
});

function page(i: number, count: number): PageRecord {
  const url = i === 0 ? `${BASE}/` : `${BASE}/p${i}`;
  // Every third page lacks a title and the h1, so findings differ per page.
  const head = i % 3 === 0 ? "" : `<title>Page ${i} of the parity site</title>`;
  const body = i % 3 === 0 ? "" : `<h1>Page ${i}</h1>`;
  const next = `${BASE}/p${(i + 1) % count}`;
  const html = `<!doctype html><html lang="en"><head>${head}<meta name="description" content="Page ${i}"></head><body>${body}<p>${"filler ".repeat(40)}</p><a href="${next}">next</a></body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${url}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

async function fixture(count: number) {
  const storage = new SQLiteStorage(":memory:");
  const config: Config = {
    ...getDefaultConfig(),
  };
  config.rules = {
    ...config.rules,
    enable: ["core/meta-title", "core/h1", "core/meta-description"],
    disable: [],
  } as Config["rules"];
  const crawl = await Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const id = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {} as never,
      } as never);
      for (let i = 0; i < count; i++) {
        yield* storage.upsertPage(id, page(i, count));
      }
      return (yield* storage.getCrawl(id))! as CrawlMetadata;
    })
  );
  return { storage, crawl, config };
}

const canon = (m: Map<string, Map<string, unknown[]>>) =>
  JSON.stringify(
    [...m]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([url, rules]) => [
        url,
        [...rules].sort(([a], [b]) => a.localeCompare(b)),
      ])
  );

describe("analyze streams the crawl (#1021)", () => {
  test("streamed findings equal the resident path's on a fixture crawl", async () => {
    const { storage, crawl, config } = await fixture(40);
    try {
      const crawlConfig = configForCrawl(config, crawl);
      const resident = await Effect.runPromise(
        Effect.gen(function* () {
          const siteContext = yield* buildSiteContext(
            yield* storage.getPages(crawl.id)
          );
          const assets = yield* fetchResourceAssets(
            storage,
            crawl.id,
            siteContext,
            crawlConfig
          );
          const collector = createEntityMapCollector();
          collector.absorb(siteContext);
          return yield* runRulesOnStorage(
            storage,
            crawl.id,
            siteContext,
            crawlConfig,
            assets,
            { entityMap: collector.build(entityMapSite(crawl)) }
          );
        })
      );
      const streamed = await Effect.runPromise(
        analyzeStoredCrawl(storage, crawl, config)
      );

      const a = streamed.ruleResults;
      expect(a.pageRuleResults.size).toBeGreaterThan(0);
      expect(canon(a.pageRuleResults as never)).toBe(
        canon(resident.pageRuleResults as never)
      );
      expect(JSON.stringify([...a.siteRuleResults].sort())).toBe(
        JSON.stringify([...resident.siteRuleResults].sort())
      );
    } finally {
      await Effect.runPromise(storage.close());
    }
  }, 30_000);

  test("rules-phase retained heap stays flat as the crawl grows", async () => {
    const heapAfter = async (count: number) => {
      const { storage, crawl, config } = await fixture(count);
      try {
        let rows = 0;
        const sink = {
          writePage: (_url: string, entries: ReadonlyArray<unknown>) => {
            rows += entries.length;
          },
        };
        await Effect.runPromise(
          analyzeStoredCrawl(storage, crawl, config, {
            pageSink: sink as never,
            retainPageResults: false,
          })
        );
        expect(rows).toBeGreaterThan(0);
        Bun.gc(true);
        return process.memoryUsage().heapUsed;
      } finally {
        await Effect.runPromise(storage.close());
      }
    };
    await heapAfter(50); // warm-up: module and JIT allocations
    const small = await heapAfter(200);
    const large = await heapAfter(1000);
    // 5x the pages: a resident run holds ~1MB of DOM per page (hundreds of MB
    // here); the streamed one holds only the batch.
    expect(large - small).toBeLessThan(40 * 1024 * 1024);
  }, 120_000);
});
