// REPLAY PARITY GATE (#1990): a fully-cached re-audit must produce byte-identical
// output to a fresh one over the same crawl.
//
// The cache asserts that re-running a page's rules would produce exactly what is
// stored, and nothing about a report can prove that on its own — a replay and a
// fresh evaluation are meant to be indistinguishable, so an assertion on the
// findings alone passes just as happily when the cache silently did nothing. Every
// test here therefore pins BOTH sides: the serialized output AND the number of
// pages that actually replayed.
//
// Three runs over one crawl:
//   cold   — no cache at all, the reference.
//   warm-1 — cache supplied and empty: every page runs, every entry is written.
//   warm-2 — same cache, now full: every page replays, nothing parses.
//
// The invalidation cases then change ONE input at a time and require the affected
// pages to run again.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { SQLiteStorage } from "@squirrelscan/crawler";
import type { ContentStoreAdapter } from "@squirrelscan/crawler";
import type { PreFetchedAssets } from "@squirrelscan/audit-engine";

import type { Config } from "../src/adapter";
import { generateReportFromStorage, runStreamingRules } from "../src/adapter";
import type { RuleCacheStore } from "../src/rule-cache";
import { getGoldenBaselineConfig } from "./helpers/golden-baseline";

const run = <A>(e: Effect.Effect<A, never, never>) => Effect.runPromise(e);
const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-rule-cache-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const PAGE_COUNT = 60;

function emptyAssets(): PreFetchedAssets {
  return { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] };
}

/**
 * A content store, because `pages.html_hash` — the exact-bytes identity the key
 * needs — is only written on the content-store path, which is the CLI's. Without
 * one every page reports a null hash and nothing caches, so a test that forgot
 * this would pass by never exercising the feature at all.
 *
 * One store PER DATABASE, shared across connections, because that is what the CLI
 * has: the store outlives any single audit. A per-connection store loses every
 * page body the moment the connection closes, which reads as "no auditable pages"
 * rather than as an error — the exact shape of a vacuously-passing test.
 */
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
    getString(hash) {
      return blobs.get(hash) ?? null;
    },
  };
  contentStores.set(dbPath, store);
  return store;
}

/** An in-memory {@link RuleCacheStore}, with the counters the assertions need. */
function memoryCacheStore() {
  const rows = new Map<string, string>();
  let pendingFresh: Array<[string, string]> = [];
  let pendingCarry: string[] = [];
  const counts = { fresh: 0, carried: 0 };
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
      pendingFresh.push([key, payload]);
    },
    carryForward(key) {
      pendingCarry.push(key);
    },
    async flush() {
      for (const [key, payload] of pendingFresh) rows.set(key, payload);
      counts.fresh += pendingFresh.length;
      counts.carried += pendingCarry.length;
      pendingFresh = [];
      pendingCarry = [];
    },
  };
  return { store, rows, counts };
}

/** Build a crawl DB whose pages carry an exact HTML hash. */
async function buildCrawl(name: string): Promise<{ dbPath: string; crawlId: string }> {
  const dbPath = join(tmpDir, `${name}.sqlite`);
  const model = generateSiteModel({
    seed: `rule-cache-${name}`,
    pageCount: PAGE_COUNT,
    templateCount: 3,
    minPageSizeBytes: 8_000,
    maxPageSizeBytes: 20_000,
    cleanRatio: 0.4,
    issues: {
      longH1: { ratio: 0.1 },
      oversizeTitle: { ratio: 0.1 },
      duplicateTitles: { groupCount: 2, groupSize: 3 },
      brokenLinks: { count: 4 },
    },
  });
  const { storage } = await writeCrawlToStorage(model, dbPath);
  const crawls = await run(storage.listCrawls(1));
  const crawlId = crawls[0]!.id;
  await run(storage.close());
  // Re-write every page through a content-store-backed connection so the real
  // upsert path stamps html_hash, exactly as a CLI audit does.
  await withStorage(dbPath, async (s) => {
    const pages = await run(s.getPages(crawlId));
    for (const page of pages) await run(s.upsertPage(crawlId, page));
  });
  return { dbPath, crawlId };
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

interface RunOutcome {
  serialized: string;
  replayedPages: number;
  freshPages: number;
  storedEntries: number;
  disabledReason?: string;
}

/**
 * One rules pass + report over an existing crawl. The report is serialized with
 * `meta.timestamp` and the cache disclosure removed: the first moves every run and
 * the second is the very thing being measured, so neither can be part of the
 * identity being asserted. Everything else must match to the byte.
 */
async function runOnce(
  dbPath: string,
  crawlId: string,
  opts: { store?: RuleCacheStore; engineVersion?: string; config?: Config } = {},
): Promise<RunOutcome> {
  return withStorage(dbPath, async (storage) => {
    const config = opts.config ?? getGoldenBaselineConfig();
    const results = await run(
      runStreamingRules(storage, crawlId, config, emptyAssets(), undefined, {
        ...(opts.store
          ? { ruleCache: { store: opts.store, engineVersion: opts.engineVersion ?? "test-1" } }
          : {}),
      }),
    );
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
      disabledReason: results.ruleCache.disabledReason,
    };
  });
}

/** Byte equality, but reported as the first differing span. */
function expectSameSerialization(actual: string, expected: string): void {
  if (actual === expected) return;
  const limit = Math.min(actual.length, expected.length);
  let i = 0;
  while (i < limit && actual[i] === expected[i]) i++;
  throw new Error(
    `replayed report diverges at byte ${i} of ${expected.length} (actual length ${actual.length})\n` +
      `  expected: ...${expected.slice(Math.max(0, i - 120), i + 120)}\n` +
      `  actual:   ...${actual.slice(Math.max(0, i - 120), i + 120)}`,
  );
}

describe("per-page rule-result cache — replay parity", () => {
  test("a fully-replayed re-audit is byte-identical to a fresh one", async () => {
    const { dbPath, crawlId } = await buildCrawl("parity");
    const cache = memoryCacheStore();

    const cold = await runOnce(dbPath, crawlId);
    expect(cold.replayedPages).toBe(0);
    expect(cold.storedEntries).toBe(0);

    const warm1 = await runOnce(dbPath, crawlId, { store: cache.store });
    // First warm run: nothing to replay, everything stored.
    expect(warm1.replayedPages).toBe(0);
    // Not merely > 0: the fixture must really be feeding the loop, or every
    // assertion below is vacuous.
    expect(warm1.freshPages).toBeGreaterThan(PAGE_COUNT / 2);
    expect(warm1.storedEntries).toBe(warm1.freshPages);
    expect(cache.rows.size).toBe(warm1.freshPages);

    const warm2 = await runOnce(dbPath, crawlId, { store: cache.store });
    // The claim: every page replayed, and NOTHING ran.
    expect(warm2.replayedPages).toBe(warm1.freshPages);
    expect(warm2.freshPages).toBe(0);
    // And every one of them was carried forward, so retiring the crawl that
    // produced them cannot make the next audit cold.
    expect(cache.counts.carried).toBe(warm2.replayedPages);

    // The gate. Reported with the first divergence rather than two 3 MB strings,
    // so a failure says WHERE the replay diverged.
    expectSameSerialization(warm2.serialized, cold.serialized);
    expectSameSerialization(warm1.serialized, cold.serialized);
  }, 120_000);

  test("a changed page runs again, and only that page", async () => {
    const { dbPath, crawlId } = await buildCrawl("invalidate-content");
    const cache = memoryCacheStore();
    const first = await runOnce(dbPath, crawlId, { store: cache.store });

    // Whitespace-only edit. It is deliberately the change `content_hash` is
    // designed NOT to notice — the normalized hash is identical either way — so a
    // key built on that field would replay stale verdicts here.
    const changedUrl = await withStorage(dbPath, async (storage) => {
      const pages = await run(storage.getPages(crawlId, { limit: 1, offset: 0 }));
      const page = pages[0]!;
      const edited = { ...page, html: page.html!.replace("<body", "<body\n  ") };
      await run(storage.upsertPage(crawlId, edited));
      return page.normalizedUrl;
    });
    expect(changedUrl).toBeTruthy();

    const second = await runOnce(dbPath, crawlId, { store: cache.store });
    expect(second.freshPages).toBe(1);
    expect(second.replayedPages).toBe(first.freshPages - 1);
  }, 120_000);

  // Codex's counterexample, and the reason a replayed page records into the
  // template fan-out (#1951) instead of abstaining from it.
  //
  // With abstention, WHICH page runs a template-scoped rule depends on what
  // happens to be cached: on the audit after a change, the changed page is the
  // only fresh one, so it becomes the cluster's representative and keeps its own
  // verdict — where a fresh audit would have the FIRST page record and fan its
  // verdict onto the changed one. The next fully-replayed audit then disagrees
  // with a fresh audit of identical content, and the disagreement is persisted.
  test("a fully-replayed audit matches a fresh one across a template cluster", async () => {
    const { dbPath, crawlId } = await buildCrawl("fanout-composition");
    const cache = memoryCacheStore();

    // Populate: no synthetic page carries a viewport meta, so `mobile/viewport`
    // (verdictScope: "template") fails uniformly across every cluster.
    await runOnce(dbPath, crawlId, { store: cache.store });

    // Give ONE page a viewport, and not the first one in crawl order — the
    // divergence needs a page that a fresh audit would never elect. The meta is
    // none of the five things the chrome fingerprint reads, so the page stays in
    // its cluster, which is what makes this a fan-out question at all.
    await withStorage(dbPath, async (storage) => {
      const pages = await run(storage.getPages(crawlId));
      // The LAST auditable page: with three templates over sixty pages every
      // cluster has many members, so this one is never the first of its own.
      const auditable = pages.filter((p) => p.html && p.status === 200);
      expect(auditable.length).toBeGreaterThan(10);
      const target = auditable[auditable.length - 1]!;
      await run(
        storage.upsertPage(crawlId, {
          ...target,
          html: target.html!.replace(
            "<head>",
            '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">',
          ),
        }),
      );
    });

    // The audit right after the change: one fresh page, the rest replayed.
    const afterChange = await runOnce(dbPath, crawlId, { store: cache.store });
    expect(afterChange.freshPages).toBe(1);
    expect(afterChange.replayedPages).toBeGreaterThan(0);

    // Now nothing has changed, so everything replays...
    const fullyReplayed = await runOnce(dbPath, crawlId, { store: cache.store });
    expect(fullyReplayed.freshPages).toBe(0);
    // ...and it must say what a fresh audit of this same content says.
    const fresh = await runOnce(dbPath, crawlId);
    expectSameSerialization(fullyReplayed.serialized, fresh.serialized);
  }, 180_000);

  test("turning off applicability gating invalidates every entry", async () => {
    const { dbPath, crawlId } = await buildCrawl("invalidate-applicability");
    const cache = memoryCacheStore();
    const base = getGoldenBaselineConfig();
    const first = await runOnce(dbPath, crawlId, { store: cache.store, config: base });

    // `ignore_applicability` changes a gated rule's output from a `skipped` check
    // to its real verdict without touching the rule list or any rule's options,
    // so nothing else in the key moves with it.
    const forced = {
      ...base,
      rules: { ...base.rules, ignore_applicability: true },
    } as unknown as Config;
    const second = await runOnce(dbPath, crawlId, { store: cache.store, config: forced });
    expect(second.replayedPages).toBe(0);
    expect(second.freshPages).toBe(first.freshPages);
  }, 120_000);

  test("a new engine version invalidates every entry", async () => {
    const { dbPath, crawlId } = await buildCrawl("invalidate-version");
    const cache = memoryCacheStore();
    const first = await runOnce(dbPath, crawlId, { store: cache.store, engineVersion: "0.0.91" });
    const upgraded = await runOnce(dbPath, crawlId, { store: cache.store, engineVersion: "0.0.92" });
    expect(upgraded.replayedPages).toBe(0);
    expect(upgraded.freshPages).toBe(first.freshPages);
  }, 120_000);

  test("a changed rule selection invalidates every entry", async () => {
    const { dbPath, crawlId } = await buildCrawl("invalidate-rules");
    const cache = memoryCacheStore();
    const base = getGoldenBaselineConfig();
    const first = await runOnce(dbPath, crawlId, { store: cache.store, config: base });

    // Turn one page rule off. Every page's key moves, because the rule id list is
    // part of the run context — a rule that stops running changes the flat check
    // list of every page, not just the ones it failed on.
    const fewer = {
      ...base,
      rules: { ...base.rules, disable: [...base.rules.disable, "core/meta-title"] },
    } as Config;
    const second = await runOnce(dbPath, crawlId, { store: cache.store, config: fewer });
    expect(second.replayedPages).toBe(0);
    expect(second.freshPages).toBe(first.freshPages);
  }, 120_000);

  test("changing a rule's options invalidates every entry", async () => {
    const { dbPath, crawlId } = await buildCrawl("invalidate-options");
    const cache = memoryCacheStore();
    const base = getGoldenBaselineConfig();
    const first = await runOnce(dbPath, crawlId, { store: cache.store, config: base });

    const retuned = {
      ...base,
      rule_options: { ...(base.rule_options ?? {}), "core/meta-title": { max_length: 12 } },
    } as Config;
    const second = await runOnce(dbPath, crawlId, { store: cache.store, config: retuned });
    expect(second.replayedPages).toBe(0);
    expect(second.freshPages).toBe(first.freshPages);
  }, 120_000);
});
