// repo#1021: `squirrel analyze` runs through the streaming pipeline instead of
// loading the whole crawl as one PageRecord array. Parity: the findings it
// stores and the summary it reports match the resident path (buildSiteContext +
// fetchResourceAssets + runRulesOnStorage) on the same crawl. Memory: the heap
// retained while the page rules run does not grow with the page count.

import {
  calculateHealthScore,
  calculateHealthScoreFromTallies,
} from "@squirrelscan/audit-engine";
import { createEntityMapCollector } from "@squirrelscan/audit-engine/entity-map/collect";
import { parsePage } from "@squirrelscan/parser";
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
import { createTlsProbe } from "@/audit/tls-probe";
import { getDefaultConfig } from "@/config";
import {
  analyzeStoredCrawl,
  configForCrawl,
  createCheckTally,
  createReplacingRuleResultsWriter,
} from "@/controllers/analyze";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const BASE = "https://streaming-1021.example.com";

const real = globalThis.fetch;

beforeAll(() => {
  // Nothing leaves the process: every request is a plain 404.
  globalThis.fetch = Object.assign(
    () => Promise.resolve(new Response("not found", { status: 404 })),
    { preconnect: real.preconnect }
  );
});

afterAll(() => {
  globalThis.fetch = real;
  clearRequestAsync();
});

function html(i: number, filler: number): string {
  // A mix of clean and defective pages so many rules produce findings.
  const title =
    i % 3 === 0 ? "" : `<title>Page number ${i} of the fixture</title>`;
  const desc =
    i % 4 === 0 ? "" : `<meta name="description" content="Description ${i}">`;
  const h1 = i % 5 === 0 ? "" : `<h1>Heading ${i}</h1>`;
  const body = `<p>${"Lorem ipsum dolor sit amet. ".repeat(filler)}</p>`;
  const next = `<a href="/p/${(i + 1) % 1000}">next</a><a href="/missing-${i}">gone</a>`;
  return `<!doctype html><html lang="en"><head>${title}${desc}</head><body>${h1}${body}${next}</body></html>`;
}

function record(i: number, filler: number): PageRecord {
  const url = i === 0 ? `${BASE}/` : `${BASE}/p/${i}`;
  const body = html(i, filler);
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: i === 0 ? 0 : 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: body.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${i}`,
    html: body,
    // As the crawler stores it: the link graph reads the parse, not the html.
    parsedData: (() => {
      const { document: _doc, ...serializable } = parsePage(body, url);
      return JSON.stringify(serializable);
    })(),
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

async function fixture(pages: number, filler: number) {
  const storage = new SQLiteStorage(":memory:");
  const crawl = await Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {} as never,
      } as never);
      for (let i = 0; i < pages; i++) {
        yield* storage.upsertPage(crawlId, record(i, filler));
      }
      return (yield* storage.getCrawl(crawlId))! as CrawlMetadata;
    })
  );
  return { storage, crawl };
}

type Row = Record<string, unknown>;

async function storedRows(storage: SQLiteStorage, crawlId: string) {
  const rows = await Effect.runPromise(storage.getRuleResults(crawlId));
  return (rows as unknown as Row[])
    .map((row) => JSON.stringify(row, Object.keys(row).sort()))
    .sort();
}

describe("squirrel analyze streams the crawl (repo#1021)", () => {
  test("stores the same findings and reports the same summary as the resident path", async () => {
    const config = getDefaultConfig();
    const { storage, crawl } = await fixture(40, 5);
    try {
      // Resident path: the whole crawl as one array.
      const resident = await Effect.runPromise(
        Effect.gen(function* () {
          const crawlConfig = configForCrawl(config, crawl);
          const pages = yield* storage.getPages(crawl.id);
          const siteContext = yield* buildSiteContext(pages);
          const assets = yield* fetchResourceAssets(
            storage,
            crawl.id,
            siteContext,
            crawlConfig
          );
          clearRequestAsync();
          const collector = createEntityMapCollector();
          collector.absorb(siteContext);
          return yield* runRulesOnStorage(
            storage,
            crawl.id,
            siteContext,
            crawlConfig,
            assets,
            {
              entityMap: collector.build(entityMapSite(crawl)),
              tlsProbe: createTlsProbe({
                siteUrl: crawl.baseUrl,
                proxyResolvesNames: false,
              }),
            }
          );
        })
      );
      const residentChecks = [
        ...Array.from(resident.pageResults.values()).flat(),
        ...resident.siteResults,
      ].filter((c) => c.status !== "skipped" && c.status !== "info");
      const residentWriter = createReplacingRuleResultsWriter(
        storage,
        crawl.id
      );
      for (const [url, rules] of resident.pageRuleResults) {
        residentWriter.writePage(url, [...rules]);
      }
      await residentWriter.writeSite(resident.siteRuleResults as never);
      const residentRows = await storedRows(storage, crawl.id);
      expect(residentRows.length).toBeGreaterThan(40);

      // Streaming path, small batches so several batches run.
      const writer = createReplacingRuleResultsWriter(storage, crawl.id);
      const streamedChecks: unknown[][] = [];
      const streamed = await Effect.runPromise(
        analyzeStoredCrawl(storage, crawl, config, {
          batchSize: 7,
          pageSink: {
            writePage: (url, entries) => {
              for (const [, checks] of entries) streamedChecks.push(checks);
              writer.writePage(url, entries);
            },
            flush: () => writer.flush(),
          },
        })
      );
      for (const checks of streamed.ruleResults.siteRuleResults.values()) {
        streamedChecks.push(checks);
      }
      await writer.writeSite(streamed.ruleResults.siteRuleResults as never);
      const streamedRows = await storedRows(storage, crawl.id);

      expect(streamedRows).toEqual(residentRows);
      expect(streamed.ruleResults.tallies.size).toBeGreaterThan(0);
      const residentTally = createCheckTally();
      residentTally.add(residentChecks);
      const streamedTally = createCheckTally();
      for (const checks of streamedChecks) streamedTally.add(checks);
      // Skipped and info checks are not scorable, so they are left out of both.
      expect(streamedTally.totals().passed).toBe(residentTally.totals().passed);
      expect(streamedTally.totals().warnings).toBe(
        residentTally.totals().warnings
      );
      expect(streamedTally.totals().failed).toBe(residentTally.totals().failed);
      expect(streamed.ruleResults.tallies.size).toBe(
        resident.ruleResultsMap.size
      );
      // The health score, from the folded tallies vs the resident results.
      expect(
        calculateHealthScoreFromTallies(
          streamed.ruleResults.tallies,
          streamed.ruleResults.ruleResultsMap
        ).overall
      ).toBe(
        calculateHealthScore({ results: resident.ruleResultsMap }).overall
      );
      expect(streamed.pageStatuses).toHaveLength(40);
    } finally {
      await Effect.runPromise(storage.close());
    }
  }, 60_000);

  test("heap retained while the page rules run does not grow with the page count", async () => {
    const config = getDefaultConfig();
    config.rules.enable = [
      "core/meta-title",
      "core/meta-description",
      "core/h1",
    ];

    async function peakRetained(pages: number): Promise<number> {
      const { storage, crawl } = await fixture(pages, 400);
      try {
        Bun.gc(true);
        const baseline = process.memoryUsage().heapUsed;
        let peak = 0;
        let writes = 0;
        const writer = createReplacingRuleResultsWriter(storage, crawl.id);
        await Effect.runPromise(
          analyzeStoredCrawl(storage, crawl, config, {
            batchSize: 25,
            pageSink: {
              writePage(url, entries) {
                writer.writePage(url, entries);
                if (++writes % 25 === 0) {
                  // Retained, not transient: collect before reading.
                  Bun.gc(true);
                  peak = Math.max(peak, process.memoryUsage().heapUsed);
                }
              },
              flush: () => writer.flush(),
            },
          })
        );
        return Math.max(0, peak - baseline);
      } finally {
        await Effect.runPromise(storage.close());
      }
    }

    const small = await peakRetained(200);
    const large = await peakRetained(1000);
    // 5x the pages. Materializing the crawl would add ~800 pages of html and
    // DOM (tens of MB); the streaming pass stays within noise of the small run.
    expect(large - small).toBeLessThan(10 * 1024 * 1024);
  }, 120_000);
});
