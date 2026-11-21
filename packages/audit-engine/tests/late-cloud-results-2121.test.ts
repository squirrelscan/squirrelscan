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
import type { CloudResultEnvelope, PluginRegistrySnapshot, Rule, RuleContext } from "@squirrelscan/rules";
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
import { computeRunContextHash, lateBoundRuleCache, type RuleCacheStore, type StreamRuleCache } from "../src/rule-cache";
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
  deadlineSkipped: number;
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
  opts: {
    cache?: RuleCacheStore;
    onPageWritten?: (url: string) => void | Promise<void>;
    settleFirst?: boolean;
    /** Stands in for the prefetch promise the binder is given (e.g. one that rejects). */
    wrapPrefetch?: (prefetch: Promise<CloudPrefetchResult>) => Promise<CloudPrefetchResult | null>;
    /** Sees the binder and its accumulator before the pass starts. */
    onLate?: (late: LateCloudResults, acc: CloudPrefetchAccumulator) => void;
    batchSize?: number;
    deadlineAt?: number;
    plugins?: PluginRegistrySnapshot;
  } = {},
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
            writePage: (url: string) => opts.onPageWritten!(url),
          },
        }
      : {};
    const passOpts = {
      ...ruleCache,
      ...pageSink,
      ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
      ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
    };
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
          passOpts,
        ),
      );
    } else {
      const acc = new CloudPrefetchAccumulator();
      const prefetch = prefetchCloudData({ ...input, accumulator: acc });
      late = new LateCloudResults(acc, opts.wrapPrefetch ? opts.wrapPrefetch(prefetch) : prefetch);
      opts.onLate?.(late, acc);
      if (opts.settleFirst) await late.settle();
      results = await run(
        runStreamingRules(storage, crawlId, config, emptyAssets(), undefined, {
          ...passOpts,
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
      deadlineSkipped: results.pagesNotEvaluated,
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

// ── Fix round (pub#2185 review) ──────────────────────────────────────────────

/** A promise the test rejects on demand. */
function rejectable<T>(): { promise: Promise<T>; reject: (error: Error) => void } {
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_resolve, r) => {
    reject = r;
  });
  return { promise, reject };
}

/** Holds the render batch carrying the crawl's last payload until `release` resolves. */
function holdLastRenderBatch(lastUrl: string, release: Promise<void>): CloudServicesClient {
  return stubCloudClient(async (service, _call, urls) => {
    if (service === "render" && urls.includes(lastUrl)) await release;
  });
}

async function lastPayloadUrl(dbPath: string, crawlId: string): Promise<string> {
  const payloads = await withStorage(dbPath, async (s) => payloadsFor(await run(s.getPages(crawlId))));
  return payloads[payloads.length - 1]!.url;
}

describe("late cloud results: rejection, deadline, cache straddle, plugins (pub#2185)", () => {
  test(
    "a prefetch that rejects mid-run writes nothing to the rule cache, does not throw, and the report is produced",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("rejected", 24);
      const lastUrl = await lastPayloadUrl(dbPath, crawlId);
      const hold = deferred();
      const failure = rejectable<CloudPrefetchResult>();
      const cache = memoryCacheStore();
      let late: LateCloudResults | undefined;
      let rejectedAfterEarlyPage = false;
      const outcome = await runOnce(dbPath, crawlId, "late", holdLastRenderBatch(lastUrl, hold.promise), {
        cache: cache.store,
        batchSize: 4,
        // The binder sees the prefetch reject; the prefetch itself keeps running.
        wrapPrefetch: (prefetch) => Promise.race([prefetch, failure.promise]),
        onLate: (l) => {
          late = l;
        },
        onPageWritten: async () => {
          if (rejectedAfterEarlyPage) return;
          rejectedAfterEarlyPage = true;
          // A page has already run on early envelopes and the real site profile. Now the
          // prefetch rejects, and the later stream batches are keyed after that.
          failure.reject(new Error("prefetch blew up"));
          await late!.settle();
          hold.resolve();
        },
      });
      expect(rejectedAfterEarlyPage).toBe(true);
      expect(late!.failed).toBe(true);
      expect(late!.settled).toBe(true);
      // No key describes this run's inputs, so nothing is stored under one.
      expect(outcome.storedEntries).toBe(0);
      expect(outcome.replayedPages).toBe(0);
      expect(cache.rows.size).toBe(0);
      // The report is still produced.
      expect(outcome.serialized.length).toBeGreaterThan(100);
      expect(outcome.freshPages).toBeGreaterThan(4);
    },
    TIMEOUT,
  );

  test(
    "deadlineAt expiring during a cloudReady wait ends the page pass and leaves no waiter parked",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("deadline", 12);
      const hold = deferred();
      const client = stubCloudClient(async (service) => {
        if (service === "render") await hold.promise;
      });
      // No wall-clock race: Date.now is frozen, so the deadline timer (deadlineAt - now) is
      // armed for DEADLINE_MS from the moment the page parks, however slow the host is. The
      // held batch is released only after the page's waiter has been removed (the deadline
      // won), or after a safety cap if it never is (a regression), so the test passes only
      // by the deadline firing.
      const DEADLINE_MS = 30;
      const SAFETY_CAP_MS = 500;
      const realNow = Date.now;
      const frozen = realNow.call(Date);
      let parkedSeen = false;
      const deadlineAt = frozen + DEADLINE_MS;
      let acc: CloudPrefetchAccumulator | undefined;
      let parkedBeforeDeadline = 0;
      let parkedAfterDeadline = -1;
      let parkedSince = 0;
      let released = false;
      const release = () => {
        released = true;
        hold.resolve();
      };
      // Frozen while the page is parked; once its waiter is gone (the deadline aborted
      // it, or the safety cap released it) the clock reads past the deadline.
      Date.now = () => {
        const waiters = acc?.pendingChangeWaiters ?? 0;
        if (waiters > 0) parkedSeen = true;
        return (parkedSeen && waiters === 0) || released ? deadlineAt + 1 : frozen;
      };
      const sampler = setInterval(() => {
        if (released || !acc) return;
        const waiters = acc.pendingChangeWaiters;
        if (waiters > 0) {
          parkedBeforeDeadline = Math.max(parkedBeforeDeadline, waiters);
          if (parkedSince === 0) parkedSince = realNow.call(Date);
        }
        if (parkedSince === 0) return;
        if (waiters === 0 || realNow.call(Date) - parkedSince > SAFETY_CAP_MS) {
          parkedAfterDeadline = waiters;
          release();
        }
      }, 5);
      try {
        const outcome = await runOnce(dbPath, crawlId, "late", client, {
          deadlineAt,
          onLate: (_late, a) => {
            acc = a;
          },
        });
        // The page was waiting on its cloud results when the deadline came.
        expect(parkedBeforeDeadline).toBe(1);
        expect(parkedAfterDeadline).toBe(0);
        expect(outcome.deadlineSkipped).toBeGreaterThan(0);
        expect(outcome.earlyPages).toBe(0);
      } finally {
        Date.now = realNow;
        clearInterval(sampler);
        hold.resolve();
      }
    },
    TIMEOUT,
  );

  test(
    "rule cache: stream batches straddling settle get null keys, then the serial key, in one pass",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("straddle", 24);
      const lastUrl = await lastPayloadUrl(dbPath, crawlId);
      const cache = memoryCacheStore();
      const cold = await runOnce(dbPath, crawlId, "serial", stubCloudClient(), { cache: cache.store, batchSize: 4 });
      expect(cold.storedEntries).toBeGreaterThan(10);
      const warm = await runOnce(dbPath, crawlId, "serial", stubCloudClient(), { cache: cache.store, batchSize: 4 });
      expect(warm.replayedPages).toBe(cold.storedEntries);
      const serialRows = new Set(cache.rows.keys());

      const hold = deferred();
      let late: LateCloudResults | undefined;
      let settledAt = -1;
      let writes = 0;
      const straddle = await runOnce(dbPath, crawlId, "late", holdLastRenderBatch(lastUrl, hold.promise), {
        cache: cache.store,
        batchSize: 4,
        onLate: (l) => {
          late = l;
        },
        onPageWritten: async () => {
          writes++;
          if (settledAt >= 0) return;
          // Stream batch 0 was keyed with the prefetch still out; settle before batch 1 is keyed.
          expect(late!.settled).toBe(false);
          hold.resolve();
          await late!.settle();
          settledAt = writes;
        },
      });
      expect(settledAt).toBe(1);
      // Batch 0 ran fresh (null keys: no read, no write); the batches after it were keyed with
      // the serial key and replayed its entries (a page whose template representative ran fresh
      // in batch 0 runs fresh too, #296), and no new key was written.
      expect(straddle.freshPages).toBeGreaterThanOrEqual(4);
      expect(straddle.freshPages).toBeLessThan(cold.freshPages);
      expect(straddle.replayedPages).toBeGreaterThan(0);
      expect(straddle.replayedPages + straddle.freshPages).toBe(cold.freshPages);
      // Every page after batch 0 stored (or carried forward) under the serial key; only the
      // four null-keyed pages of batch 0 stored nothing.
      expect(straddle.storedEntries).toBe(cold.storedEntries - 4);
      expect(straddle.serialized).toBe(cold.serialized);
      expect(new Set(cache.rows.keys())).toEqual(serialRows);
    },
    TIMEOUT,
  );

  test("lateBoundRuleCache: one key loop straddling settle gives null keys, then the bound cache's keys", async () => {
    let ready = false;
    let binds = 0;
    const loaded: string[][] = [];
    const inner = {
      keyFor: async (page: { url: string }) => `k:${page.url}`,
      load: async (keys: string[]) => {
        loaded.push(keys);
        return new Map();
      },
      putFresh() {},
      carryForward() {},
    } as unknown as StreamRuleCache;
    const cache = lateBoundRuleCache(
      () => ready,
      async () => {
        binds++;
        return inner;
      },
    );
    const page = (url: string) => ({ url }) as unknown as Parameters<StreamRuleCache["keyFor"]>[0];
    const keys: Array<string | null> = [];
    for (const url of ["a", "b", "c", "d"]) {
      if (url === "c") ready = true; // the prefetch settles between b and c
      keys.push(await cache.keyFor(page(url), undefined));
    }
    expect(keys).toEqual([null, null, "k:c", "k:d"]);
    expect(binds).toBe(1);
    await cache.load(["k:c", "k:d"]);
    expect(loaded).toEqual([["k:c", "k:d"]]);
  });

  test(
    "a plugin rule pack waits for the prefetch to settle before any page rule runs",
    async () => {
      const { dbPath, crawlId } = await buildCrawl("plugin", 12);
      const lastUrl = await lastPayloadUrl(dbPath, crawlId);
      const hold = deferred();
      const release = setTimeout(() => hold.resolve(), 300);
      let late: LateCloudResults | undefined;
      const settledWhenRun: boolean[] = [];
      const probe: Rule = {
        meta: {
          id: "acme/cloud-probe",
          name: "acme/cloud-probe",
          description: "plugin rule",
          category: "content",
          scope: "page",
          severity: "warning",
          weight: 1,
          verdictScope: "page",
        } as Rule["meta"],
        run: (_ctx: RuleContext) => {
          settledWhenRun.push(late!.settled);
          return { checks: [{ name: "probe", status: "pass", message: "ok" }] };
        },
      };
      try {
        await runOnce(dbPath, crawlId, "late", holdLastRenderBatch(lastUrl, hold.promise), {
          plugins: { rules: [probe], listeners: new Map() },
          onLate: (l) => {
            late = l;
          },
        });
      } finally {
        clearTimeout(release);
        hold.resolve();
      }
      expect(settledWhenRun.length).toBeGreaterThan(0);
      expect(settledWhenRun.every(Boolean)).toBe(true);
      expect(late!.earlyPages).toBe(0);
    },
    TIMEOUT,
  );
});

describe("waiters wake on every early exit of the prefetch (pub#2185)", () => {
  /** Park a raw `changed()` waiter and a binder page waiter, then check both wake. */
  async function expectWaitersWake(
    acc: CloudPrefetchAccumulator,
    done: Promise<CloudPrefetchResult>,
    release: () => void,
  ): Promise<LateCloudResults> {
    const late = new LateCloudResults(acc, done);
    let rawWoke = false;
    const raw = acc.changed().then(() => {
      rawWoke = true;
    });
    const page = late.pageReady(pages[0]!.url);
    expect(page).not.toBeNull();
    expect(acc.pendingChangeWaiters).toBeGreaterThanOrEqual(2);
    expect(rawWoke).toBe(false);
    // The accumulator itself wakes its readers when it settles, before the awaited
    // prefetch resolves, not only the binder's drain after it.
    let rawWokeByResolve = false;
    const resolved = done.then(() => {
      rawWokeByResolve = rawWoke;
    });
    release();
    await raw;
    await page;
    await resolved;
    expect(rawWoke).toBe(true);
    expect(rawWokeByResolve).toBe(true);
    expect(acc.pendingChangeWaiters).toBe(0);
    return late;
  }

  test("Stage-0 failure wakes the waiters and decides the site profile as absent", async () => {
    const hold = deferred();
    const base = stubCloudClient();
    const client = {
      ...base,
      siteMetadata: async () => {
        await hold.promise;
        throw new Error("metadata down");
      },
    } as unknown as CloudServicesClient;
    const acc = new CloudPrefetchAccumulator();
    const renderHold = deferred();
    const input: Omit<CloudPrefetchInput, "accumulator"> = {
      ...renderInput(client),
      client: {
        ...client,
        render: async (req: { urls: string[] }) => {
          await renderHold.promise;
          return base.render(req as never);
        },
      } as unknown as CloudServicesClient,
      rules: [
        { id: "ai/site-metadata", cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" } },
        ...RENDER_RULES,
      ],
      metadataPages: [{ url: "https://example.com/", title: "Home" }],
    };
    const done = prefetchCloudData({ ...input, accumulator: acc });
    await until(() => acc.planned !== null && acc.preflight !== null, "preflight");
    const late = new LateCloudResults(acc, done);
    const meta = late.siteMetadata();
    let rawWoke = false;
    const raw = acc.changed().then(() => {
      rawWoke = true;
    });
    expect(acc.pendingChangeWaiters).toBeGreaterThanOrEqual(2);
    hold.resolve();
    await raw;
    expect(rawWoke).toBe(true);
    // Decided before any render batch returns: the profile is absent, as the result will say.
    expect(await meta).toBeUndefined();
    expect(acc.siteMetadataDecided).toBe(true);
    expect(late.settled).toBe(false);
    renderHold.resolve();
    const result = await done;
    expect(result.siteMetadata).toBeNull();
    expect(acc.pendingChangeWaiters).toBe(0);
  }, TIMEOUT);

  test("skipAll (preflight failure) wakes the waiters", async () => {
    const hold = deferred();
    const client = {
      ...stubCloudClient(),
      getBalance: async () => {
        await hold.promise;
        throw new Error("network down");
      },
    } as unknown as CloudServicesClient;
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudData({ ...renderInput(client), accumulator: acc });
    const late = await expectWaitersWake(acc, done, () => hold.resolve());
    const result = await done;
    expect(result.store.get("render")?.get(pages[0]!.url)?.status).toBe("skipped");
    expect(late.store.get("render")?.get(pages[0]!.url)).toEqual(result.store.get("render")?.get(pages[0]!.url));
  }, TIMEOUT);

  test("skipAll (cloud disabled) wakes the waiters", async () => {
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudData({
      ...renderInput(stubCloudClient()),
      config: { ...renderConfig, enabled: false },
      accumulator: acc,
    });
    await expectWaitersWake(acc, done, () => {});
    expect((await done).store.get("render")?.get(pages[0]!.url)?.status).toBe("skipped");
  }, TIMEOUT);

  test("emptyResult (no cloud rules) wakes the waiters", async () => {
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudData({ ...renderInput(stubCloudClient()), rules: [], accumulator: acc });
    await expectWaitersWake(acc, done, () => {});
    expect((await done).store.size).toBe(0);
  }, TIMEOUT);
});

describe("a url listed in two batches (pub#2185)", () => {
  test("is final only once both batches returned, and carries the later batch's envelope", async () => {
    const dup = pages[0]!.url;
    const dupPages = [pages[0]!, pages[1]!, { ...pages[0]!, textExcerpt: "again" }];
    const hold = deferred();
    const jobs = new Map<string, string[]>();
    let calls = 0;
    const client = {
      ...stubCloudClient(),
      render: async (req: { urls: string[] }) => {
        const call = calls++;
        if (call === 2) await hold.promise;
        const jobId = `job-${call}`;
        jobs.set(jobId, req.urls);
        return { jobId, status: "queued" };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done",
        results: (jobs.get(jobId) ?? []).map((url) => ({
          url,
          status: 200,
          html: `<html><body><p>${jobId}</p></body></html>`,
        })),
      }),
    } as unknown as CloudServicesClient;
    const acc = new CloudPrefetchAccumulator();
    const done = prefetchCloudData({ ...renderInput(client), pages: dupPages, accumulator: acc });
    const late = new LateCloudResults(acc, done);

    await until(() => acc.inFlight?.outcomes[0] !== undefined && acc.inFlight?.outcomes[1] !== undefined, "batches 0, 1");
    expect(acc.inFlight?.batchesOf.get(dup)).toEqual([0, 2]);
    // Batch 0 returned, but the url's second batch has not: not final.
    expect(acc.pageEnvelopes(dup)).toBeNull();
    const wait = late.pageReady(dup);
    expect(wait).not.toBeNull();
    expect(late.pageReady(pages[1]!.url)).toBeNull();

    hold.resolve();
    await wait;
    const fromView = late.store.get("render")?.get(dup);
    const result = await done;
    // The later batch wins, in the view as in the batch-order merge.
    expect(JSON.stringify(fromView)).toContain("job-2");
    expect(fromView).toEqual(result.store.get("render")!.get(dup)!);
    expect(late.store.get("render")?.get(dup)).toEqual(result.store.get("render")!.get(dup)!);
  }, TIMEOUT);
});
