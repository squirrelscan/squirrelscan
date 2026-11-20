// pub#2121: rules start on pages whose cloud prefetch has finished, while later
// page batches are still rendering. Covers the accumulator's per-page readiness,
// the batch order of the final store, abandon() skips surviving a late batch,
// the page pass actually starting early, and the rule cache keeping the serial
// path's key and hits.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import type { PreFetchedAssets } from "@squirrelscan/audit-engine";
import type { CloudPagePayload } from "@squirrelscan/core-contracts";
import type { CloudResultEnvelope } from "@squirrelscan/rules";
import { SQLiteStorage, type ContentStoreAdapter } from "@squirrelscan/crawler";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import { generateReportFromStorage, runStreamingRules } from "../src/adapter";
import {
  CloudPrefetchAccumulator,
  prefetchCloudData,
  prefetchCloudDataWithDeadline,
  type CloudPrefetchInput,
  type CloudPrefetchResult,
} from "../src/cloud-prefetch";
import { LateCloudResults } from "../src/late-cloud-results";
import { computeRunContextHash, type RuleCacheStore } from "../src/rule-cache";
import { getGoldenBaselineConfig } from "./helpers/golden-baseline";
import {
  deferred,
  lateCloudConfig,
  payloadsFor,
  prefetchInputFor,
  stubCloudClient,
} from "./helpers/late-cloud-fixture";

const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);
const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-late-cloud-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const TIMEOUT = 30_000;

// ── Prefetch-level fixtures: render only, one page per batch ─────────────────

const renderConfig = {
  enabled: true,
  max_credits_per_audit: 0,
  confirm_threshold: 1_000_000,
  batch_size: 1,
} as unknown as CloudConfig;

const pages: CloudPagePayload[] = Array.from({ length: 4 }, (_, i) => ({
  url: `https://example.com/p${i}`,
  textExcerpt: `page ${i}`,
}));

const RENDER_RULES: CloudPrefetchInput["rules"] = [
  { id: "ax/content-without-js", cloud: { service: "render", unit: "page", creditFeature: "render" } },
];

function renderInput(client: CloudServicesClient): Omit<CloudPrefetchInput, "accumulator"> {
  return {
    client,
    config: renderConfig,
    rules: RENDER_RULES,
    pages,
    siteUrl: "https://example.com",
    auditId: "audit-2121",
  };
}

/** Render client whose batch 0 (page p0) is held until `slow0` resolves; the rest return at once. */
function slowFirstBatchClient(slow0: Promise<void>): CloudServicesClient {
  return stubCloudClient(async (service, call) => {
    if (service === "render" && call === 0) await slow0;
  });
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Wait (bounded) for a condition the prefetch reaches asynchronously. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("CloudPrefetchAccumulator.pageEnvelopes (pub#2121)", () => {
  test("a page is final only once its own batch returned; later batches do not hold it", async () => {
    const slow0 = deferred();
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudData({ ...renderInput(slowFirstBatchClient(slow0.promise)), accumulator: acc });

    await until(() => acc.pageEnvelopes(pages[1]!.url) !== null, "p1 final");
    // p0's batch is still rendering: not final, while every other page is.
    expect(acc.pageEnvelopes(pages[0]!.url)).toBeNull();
    for (const p of pages.slice(1)) {
      expect(acc.pageEnvelopes(p.url)?.map(([service, env]) => [service, env.status])).toEqual([
        ["render", "ok"],
      ]);
    }
    // A url no payload carries is never keyed by a page-unit service: final at once.
    expect(acc.pageEnvelopes("https://example.com/not-a-payload")).toEqual([]);
    // Nothing was written to the store before the service merged.
    expect(acc.store.get("render")?.size ?? 0).toBe(0);

    slow0.resolve();
    const result = await done;
    expect(acc.pageEnvelopes(pages[0]!.url)).toEqual([["render", result.store.get("render")!.get(pages[0]!.url)!]]);
  }, TIMEOUT);

  test("AC2: with batch 0 slow, the awaited store is in batch order, and so is the late view once settled", async () => {
    const slow0 = deferred();
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudData({ ...renderInput(slowFirstBatchClient(slow0.promise)), accumulator: acc });
    const late = new LateCloudResults(acc, done);

    // Pages 1..3 finish first and are let into the view in that order.
    for (const p of pages.slice(1)) {
      await until(() => acc.pageEnvelopes(p.url) !== null, `${p.url} final`);
      expect(late.pageReady(p.url)).toBeNull();
    }
    expect([...(late.store.get("render")?.keys() ?? [])]).toEqual(pages.slice(1).map((p) => p.url));
    expect(late.pageReady(pages[0]!.url)).not.toBeNull();

    slow0.resolve();
    const result = await done;
    await late.settle();
    const batchOrder = pages.map((p) => p.url);
    // The awaited prefetch result starts with page 0's key: batch order, not completion order.
    expect([...result.store.get("render")!.keys()]).toEqual(batchOrder);
    // The store the rules read is rebuilt in the same order (js-errors iterates it).
    expect([...late.store.get("render")!.keys()]).toEqual(batchOrder);
    expect(late.store.get("render")).toEqual(result.store.get("render"));
    // All four were let in while the prefetch ran: p0's waiter woke when its batch landed,
    // before the service merged.
    expect(late.earlyPages).toBe(4);
  }, TIMEOUT);

  test("AC3: a batch that lands after abandon() does not overwrite the abandon's skips", async () => {
    const slow0 = deferred();
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudDataWithDeadline(renderInput(slowFirstBatchClient(slow0.promise)), 100, acc);
    const late = new LateCloudResults(acc, done);

    const abandoned = await done;
    expect(abandoned.abandoned).toBe(true);
    const skip: CloudResultEnvelope = { status: "skipped", skipReason: "prefetch-out-of-time" };
    expect(abandoned.store.get("render")?.get(pages[0]!.url)).toEqual(skip);

    // Now the slow batch lands, after the abandon.
    slow0.resolve();
    await until(() => acc.inFlight?.outcomes[0] !== undefined || acc.inFlight === null, "late batch");
    await flush();

    expect(abandoned.store.get("render")?.get(pages[0]!.url)).toEqual(skip);
    expect(acc.pageEnvelopes(pages[0]!.url)).toEqual([["render", skip]]);
    expect(late.pageReady(pages[0]!.url)).toBeNull();
    expect(late.store.get("render")?.get(pages[0]!.url)).toEqual(skip);
    // The batches that returned before the deadline are kept, as before.
    expect(late.store.get("render")?.get(pages[1]!.url)?.status).toBe("ok");
  }, TIMEOUT);

  test("the site profile is known as soon as Stage 0 decides, before the page batches return", async () => {
    const hold = deferred();
    const acc = new CloudPrefetchAccumulator();
    const input: Omit<CloudPrefetchInput, "accumulator"> = {
      ...renderInput(
        stubCloudClient(async (service) => {
          if (service === "render") await hold.promise;
        }),
      ),
      rules: [
        { id: "ai/site-metadata", cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" } },
        ...RENDER_RULES,
      ],
      metadataPages: [{ url: "https://example.com/", title: "Home" }],
    };
    const done = prefetchCloudData({ ...input, accumulator: acc });
    const late = new LateCloudResults(acc, done);
    const meta = await late.siteMetadata();
    expect(late.settled).toBe(false);
    hold.resolve();
    const result = await done;
    expect(meta).toEqual(result.siteMetadata ?? undefined);
    expect(meta?.siteType).toBe("blog");
  }, TIMEOUT);
});

// ── Engine-level: a stored crawl through runStreamingRules ───────────────────

function emptyAssets(): PreFetchedAssets {
  return { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] };
}

const contentStores = new Map<string, ContentStoreAdapter>();
function contentStoreFor(dbPath: string): ContentStoreAdapter {
  const existing = contentStores.get(dbPath);
  if (existing) return existing;
  const blobs = new Map<string, string>();
  const store: ContentStoreAdapter = {
    put(content) {
      const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      blobs.set(hash, content);
      return hash;
    },
    getString: (hash) => blobs.get(hash) ?? null,
  };
  contentStores.set(dbPath, store);
  return store;
}

async function withStorage<T>(dbPath: string, fn: (s: SQLiteStorage) => Promise<T>): Promise<T> {
  const storage = new SQLiteStorage(dbPath, contentStoreFor(dbPath));
  try {
    await run(storage.init());
    return await fn(storage);
  } finally {
    await run(storage.close());
  }
}

/** A crawl DB whose pages carry an exact HTML hash (so the rule cache can key them). */
async function buildCrawl(name: string, pageCount: number): Promise<{ dbPath: string; crawlId: string }> {
  const dbPath = join(tmpDir, `${name}.sqlite`);
  const model = generateSiteModel({ seed: `late-cloud-${name}`, pageCount, templateCount: 3 });
  const { storage } = await writeCrawlToStorage(model, dbPath);
  const crawlId = (await run(storage.listCrawls(1)))[0]!.id;
  await run(storage.close());
  await withStorage(dbPath, async (s) => {
    for (const page of await run(s.getPages(crawlId))) await run(s.upsertPage(crawlId, page));
  });
  return { dbPath, crawlId };
}

const SITE = "http://synthetic.example.com";
const config = lateCloudConfig(getGoldenBaselineConfig());

/** A memory rule-cache store with counters. */
function memoryCacheStore() {
  const rows = new Map<string, string>();
  let pending: Array<[string, string]> = [];
  const store: RuleCacheStore = {
    async load(keys) {
      const out = new Map<string, string>();
      for (const key of keys) {
        const value = rows.get(key);
        if (value !== undefined) out.set(key, value);
      }
      return out;
    },
    putFresh(key, _url, payload) {
      pending.push([key, payload]);
    },
    carryForward() {},
    async flush() {
      for (const [key, payload] of pending) rows.set(key, payload);
      pending = [];
    },
  };
  return { store, rows };
}

interface Outcome {
  serialized: string;
  replayedPages: number;
  freshPages: number;
  storedEntries: number;
  earlyPages: number;
}

/**
 * One rules pass + report. `mode: "serial"` awaits the prefetch and passes its store in
 * `scope` (today's path); `"late"` starts the rules with the prefetch still running.
 */
async function runOnce(
  dbPath: string,
  crawlId: string,
  mode: "serial" | "late",
  client: CloudServicesClient,
  opts: { cache?: RuleCacheStore; onPageWritten?: (url: string) => void; settleFirst?: boolean } = {},
): Promise<Outcome> {
  return withStorage(dbPath, async (storage) => {
    const payloads = payloadsFor(await run(storage.getPages(crawlId)));
    const input = prefetchInputFor(client, config, payloads, SITE, 4);
    const ruleCache = opts.cache
      ? { ruleCache: { store: opts.cache, engineVersion: "test-1", rulesVersion: "rules-1" } }
      : {};
    const pageSink = opts.onPageWritten
      ? {
          pageSink: {
            writePage: (url: string) => {
              opts.onPageWritten!(url);
            },
          },
        }
      : {};
    let results;
    let late: LateCloudResults | undefined;
    if (mode === "serial") {
      const prefetch = await prefetchCloudData(input);
      results = await run(
        runStreamingRules(
          storage,
          crawlId,
          config,
          emptyAssets(),
          { cloudResults: prefetch.store, siteMetadata: prefetch.siteMetadata ?? undefined },
          { ...ruleCache, ...pageSink },
        ),
      );
    } else {
      const acc = new CloudPrefetchAccumulator();
      late = new LateCloudResults(acc, prefetchCloudData({ ...input, accumulator: acc }));
      if (opts.settleFirst) await late.settle();
      results = await run(
        runStreamingRules(storage, crawlId, config, emptyAssets(), undefined, {
          ...ruleCache,
          ...pageSink,
          lateCloudResults: late,
        }),
      );
    }
    const report = await run(generateReportFromStorage(storage, crawlId, results));
    const stripped = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    delete stripped.timestamp;
    const meta = stripped.meta as Record<string, unknown> | undefined;
    if (meta) delete meta.timestamp;
    delete stripped.rulesCache;
    return {
      serialized: JSON.stringify(stripped),
      replayedPages: results.ruleCache.replayedPages,
      freshPages: results.ruleCache.freshPages,
      storedEntries: results.ruleCache.storedEntries,
      earlyPages: late?.earlyPages ?? 0,
    };
  });
}

describe("runStreamingRules with late cloud results (pub#2121)", () => {
  test(
    "AC1: page rules run on pages whose prefetch finished while a later render batch is still out",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("early-start", 24);
      const payloads = await withStorage(dbPath, async (s) => payloadsFor(await run(s.getPages(crawlId))));
      const lastUrl = payloads[payloads.length - 1]!.url;
      const lastBatch = deferred();
      let released = false;
      const written: string[] = [];
      let writtenBeforeRelease = -1;
      // Hold the render batch carrying the last payload until a page's rules have run.
      const held = stubCloudClient(async (service, _call, urls) => {
        if (service === "render" && urls.includes(lastUrl)) await lastBatch.promise;
      });
      // Backstop so a regression fails the assertion below instead of hanging the test.
      let backstopFired = false;
      const backstop = setTimeout(() => {
        backstopFired = true;
        lastBatch.resolve();
      }, 5_000);
      const outcome = await runOnce(dbPath, crawlId, "late", held, {
        onPageWritten: (url) => {
          written.push(url);
          if (!released) {
            released = true;
            writtenBeforeRelease = written.length;
            // This page's rules ran while the last render batch was still held.
            lastBatch.resolve();
          }
        },
      });
      clearTimeout(backstop);
      expect(backstopFired).toBe(false);
      expect(writtenBeforeRelease).toBe(1);
      expect(outcome.earlyPages).toBeGreaterThan(0);
      expect(written.length).toBeGreaterThan(1);
    },
    TIMEOUT,
  );

  test(
    "AC4 (small fixture): the late report is byte-identical to the serial one",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("parity", 30);
      const slow = (service: string, call: number) =>
        service === "render" ? new Promise<void>((r) => setTimeout(r, call === 0 ? 60 : 5)) : undefined;
      const serial = await runOnce(dbPath, crawlId, "serial", stubCloudClient(slow));
      const late = await runOnce(dbPath, crawlId, "late", stubCloudClient(slow));
      expect(late.earlyPages).toBeGreaterThan(0);
      expect(late.serialized).toBe(serial.serialized);
      // Not vacuous: the cloud rules read real stubbed results on both paths.
      expect(serial.serialized).toContain("console.error message(s) from first-party code");
      expect(serial.serialized).toContain("Authority signals:");
    },
    TIMEOUT,
  );

  test(
    "rule cache: the serial key and hits are unchanged; late pages after settle hit them, early ones neither read nor write",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("cache", 24);
      const client = () => stubCloudClient();

      // Serial key: what computeRunContextHash gives the serial inputs, before and after this change
      // alike (the serial branch hashes `scope` exactly as it did).
      const cache = memoryCacheStore();
      const cold = await runOnce(dbPath, crawlId, "serial", client(), { cache: cache.store });
      expect(cold.replayedPages).toBe(0);
      expect(cold.storedEntries).toBeGreaterThan(10);
      const warm = await runOnce(dbPath, crawlId, "serial", client(), { cache: cache.store });
      expect(warm.replayedPages).toBe(cold.storedEntries);
      expect(warm.serialized).toBe(cold.serialized);
      const serialRows = new Set(cache.rows.keys());

      // A late run whose prefetch settles before the first page batch is keyed: every page
      // uses the serial key, so it replays the serial run's entries and writes no new key.
      const settledFirst = await runOnce(dbPath, crawlId, "late", client(), {
        cache: cache.store,
        settleFirst: true,
      });
      expect(settledFirst.replayedPages).toBe(cold.storedEntries);
      expect(settledFirst.serialized).toBe(cold.serialized);
      expect(new Set(cache.rows.keys())).toEqual(serialRows);

      // A late run whose prefetch is still out when the pages are keyed: no page reads or
      // writes the cache (fresh, nothing stored), and the report is still identical.
      const hold = deferred();
      const slowClient = stubCloudClient(async (service, call) => {
        if (service === "render" && call === 0) {
          await hold.promise;
        }
      });
      setTimeout(() => hold.resolve(), 200);
      const early = await runOnce(dbPath, crawlId, "late", slowClient, { cache: cache.store });
      expect(early.replayedPages).toBe(0);
      expect(early.storedEntries).toBe(0);
      expect(early.serialized).toBe(cold.serialized);
      expect(new Set(cache.rows.keys())).toEqual(serialRows);
    },
    TIMEOUT,
  );

  test("the run-context hash of the settled late store equals the serial store's", async () => {
    const acc = new CloudPrefetchAccumulator();
    const slow0 = deferred();
    const input = renderInput(slowFirstBatchClient(slow0.promise));
    const late = new LateCloudResults(acc, prefetchCloudData({ ...input, accumulator: acc }));
    await until(() => acc.pageEnvelopes(pages[3]!.url) !== null, "p3 final");
    expect(late.pageReady(pages[3]!.url)).toBeNull();
    slow0.resolve();
    const lateResult = (await late.settle()) as CloudPrefetchResult;
    const serial = await prefetchCloudData(renderInput(stubCloudClient()));
    const base = {
      engineVersion: "e",
      rulesVersion: "r",
      pageRules: [],
      siteData: { baseUrl: SITE, pages: [], robotsTxt: null, sitemaps: null },
      ignoreApplicability: false,
      utcYear: 2026,
      utcMonth: 10,
      timeZone: "UTC",
    };
    const serialKey = await computeRunContextHash({ ...base, siteMetadata: undefined, cloudResults: serial.store });
    const lateKey = await computeRunContextHash({ ...base, siteMetadata: undefined, cloudResults: late.store });
    expect(lateResult.store).toEqual(serial.store);
    expect(lateKey).toEqual(serialKey);
  }, TIMEOUT);
});
