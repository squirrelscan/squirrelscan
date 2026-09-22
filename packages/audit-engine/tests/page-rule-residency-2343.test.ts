// PER-PAGE HEAP RESIDENCY (squirrelscan/repo#2343).
//
// `streamPageRules` bounded the DOMs to one batch (#1021) but kept every page's
// CHECKS for the whole run, and a check's message/value/items are content cut out
// of the page it was found on. So the pass's heap scaled with pages × page BYTES,
// not with pages: measured ~161 KB/page at 45 KB pages and ~710 KB/page at 1.28 MB
// pages, which is what killed a 4,000-page crawl of a 1.8 MB/page site before it
// ever reached the report.
//
// THE INVARIANT THIS PINS: with a sink taking the checks (`retainPageResults:
// false`), what the loop retains per page must not grow when the pages do. The
// same measurement in RETAINING mode is the positive control — without it a test
// that cannot see page size at all would pass for the wrong reason, which is the
// failure mode a residency assertion is most prone to.
//
// The rule here is synthetic ON PURPOSE. Real page rules are covered by the
// golden diffs; what this needs is a rule whose finding QUOTES the page, which is
// the behaviour that makes real findings scale with page bytes — the synthetic
// site pads pages with prose, so most shipped rules would emit a constant-size
// check over a bigger page and the independent variable would vanish.

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heapStats } from "bun:jsc";
import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import type { PageData, RuleMeta, RuleRunner, SiteData } from "@squirrelscan/rules";

import { streamPageRules, type PageResultSink } from "../src/streaming";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const PAGE_COUNT = 40;
const SMALL_BYTES = 32 * 1024;
const LARGE_BYTES = 384 * 1024;
/** How much of each page a finding quotes — the fraction a real rule's items are. */
const QUOTE_FRACTION = 0.25;
const MB = 1024 * 1024;
/** Band for the bounded arm's whole-crawl delta — 7x the widest sample seen. */
const NOISE_BYTES = 1.5 * MB;

const META: RuleMeta = {
  id: "synthetic/quotes-the-page",
  name: "Quotes the page",
  description: "Emits a finding whose payload is cut from the page, as real rules do.",
  category: "core",
  scope: "page",
  severity: "warning",
  weight: 1,
};

/**
 * Page rules read only non-`pages` site fields, so a minimal SiteData suffices
 * (same shape the flatness + golden tests use).
 */
function siteData(): SiteData {
  return { baseUrl: "http://synthetic.test", pages: [], robotsTxt: null, sitemaps: null };
}

/**
 * `RuleRunner` is a class, and the loop only ever calls these two members, so a
 * structural stand-in is cast rather than subclassed — subclassing would drag in
 * the whole registry and the rule set is exactly what this test is replacing.
 */
function quotingRunner(): RuleRunner {
  return {
    async runPageRules(page: PageData) {
      const quote = page.html.slice(0, Math.floor(page.html.length * QUOTE_FRACTION));
      const check: CheckResult = {
        name: META.name,
        status: "warn",
        message: `Found ${quote.length} bytes worth quoting`,
        value: quote,
        items: [{ id: `${page.url}#quote`, label: quote.slice(0, quote.length >> 1) }],
      };
      return {
        checks: [check],
        ruleResults: new Map([[META.id, { meta: META, checks: [check] }]]),
      };
    },
    getRuleMeta: () => META,
  } as unknown as RuleRunner;
}

/**
 * Live JS heap after a forced collection.
 *
 * `process.memoryUsage().heapUsed` is NOT usable for this on Bun: retaining
 * 20 MB of distinct strings moves it from 0.2 MB to 0.2 MB and then, one sample
 * later, to 20.5 MB — it lags the allocation it is supposed to report, and the
 * first draft of this test read a per-page delta of exactly 0 because of it.
 * `heapStats().heapSize` tracked the same 20 MB to within 0.3 MB at every
 * sample. Two collections: the first drops the pass's garbage, the second
 * settles what finalizing that garbage freed.
 */
function liveHeapBytes(): number {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
}

interface Residency {
  /** Heap still held once the pass has returned, over the whole crawl. */
  totalBytes: number;
  /** The same, per page scored. */
  perPageBytes: number;
  pagesScored: number;
  /** Checks the sink received — 0 would make every assertion below vacuous. */
  checksSunk: number;
  retainedPageMaps: number;
  ruleIdsTallied: number;
}

const tmpDbs: string[] = [];
afterAll(() => {
  for (const p of tmpDbs) rmSync(p, { force: true });
});

/**
 * Write the crawl to a temp FILE, then hand back only its path.
 *
 * `:memory:` plus "build the model in another function" was not enough: under
 * `bun test` the 15 MB SiteModel was still reachable when the sample window
 * opened and was collected DURING the pass, so every arm read a delta of -3 to
 * -58 MB and the positive control asserted `> a negative number`. Going through
 * a file means the measured process opens a store whose fixture was built in a
 * frame that has fully returned, and nothing JS-side can still be holding the
 * pages.
 */
async function writeFixture(pageSizeBytes: number): Promise<string> {
  const path = join(tmpdir(), `squirrel-2343-${randomUUID()}.db`);
  tmpDbs.push(path);
  const { storage } = await writeCrawlToStorage(
    generateSiteModel({
      seed: 11,
      pageCount: PAGE_COUNT,
      templateCount: 2,
      minPageSizeBytes: pageSizeBytes,
      maxPageSizeBytes: pageSizeBytes,
    }),
    path,
  );
  await run(storage.close());
  return path;
}

async function measure(dbPath: string, retain: boolean): Promise<Residency> {
  const storage = new SQLiteStorage(dbPath);
  await run(storage.init());
  const crawlId = (await run(storage.listCrawls(1)))[0]!.id;

  // The sink counts and drops, which is the contract every real sink honours
  // (the CLI's writes its batch to SQLite and clears).
  let checksSunk = 0;
  const sink: PageResultSink = {
    writePage(_pageUrl, entries) {
      for (const [, checks] of entries) checksSunk += checks.length;
    },
  };

  Bun.gc(true);
  const before = liveHeapBytes();

  const result = await run(
    streamPageRules(storage, crawlId, quotingRunner(), siteData(), {
      batchSize: 10,
      retainPageResults: retain,
      pageSink: sink,
      // Off: the fan-out reads the real registry to find template-scoped rules,
      // and copying one page's verdict onto its cluster would decouple what is
      // retained from the pages that produced it — the opposite of what this
      // measures.
      templateFanout: false,
    }),
  );

  const after = liveHeapBytes();

  // Read `result` only AFTER the sample, so what is measured is a live object.
  const pagesScored = result.pageUrls.length;
  const out: Residency = {
    totalBytes: after - before,
    perPageBytes: (after - before) / Math.max(1, pagesScored),
    pagesScored,
    checksSunk,
    retainedPageMaps: result.pageResults.size + result.pageRuleResults.size,
    ruleIdsTallied: result.tallies.size,
  };
  if (process.env.RESIDENCY_DEBUG)
    console.log(
      `db=${dbPath.slice(-12)} retain=${retain} before=${(before / MB).toFixed(2)} after=${(after / MB).toFixed(2)} delta=${(out.totalBytes / MB).toFixed(2)}MB pages=${pagesScored}`,
    );
  await run(storage.close());
  return out;
}

describe("streamPageRules — per-page residency is independent of page size (#2343)", () => {
  test(
    "bounded mode holds the same heap at 32 KB and 384 KB pages",
    async () => {
      // Warm-up, discarded. The FIRST pass in a process pays module-load + JIT
      // garbage that the next forced collection reclaims, so its `before` sample
      // is high and its delta comes out NEGATIVE — which, unnoticed, would have
      // made the positive control below assert `> a negative number` and pass on
      // anything.
      const smallDb = await writeFixture(SMALL_BYTES);
      const largeDb = await writeFixture(LARGE_BYTES);
      await measure(smallDb, true);

      const smallRetained = await measure(smallDb, true);
      const largeRetained = await measure(largeDb, true);
      const smallBounded = await measure(smallDb, false);
      const largeBounded = await measure(largeDb, false);

      // Non-vacuous: the pass really scored every page and the sink really got
      // its checks, in both modes.
      for (const r of [smallRetained, largeRetained, smallBounded, largeBounded]) {
        expect(r.pagesScored).toBe(PAGE_COUNT);
        expect(r.checksSunk).toBe(PAGE_COUNT);
        expect(r.ruleIdsTallied).toBe(1);
      }
      // Bounded mode keeps no per-page map; retaining mode keeps two per page.
      expect(smallBounded.retainedPageMaps).toBe(0);
      expect(largeBounded.retainedPageMaps).toBe(0);
      expect(largeRetained.retainedPageMaps).toBe(PAGE_COUNT * 2);

      // POSITIVE CONTROL. 12x the page bytes has to show up as materially more
      // retained heap when the maps are kept, or the instrument is blind and the
      // real assertion below proves nothing. Measured: 1.01 MB at 32 KB pages vs
      // 11.04 MB at 384 KB — 25 KB/page vs 276 KB/page, the defect this fixes.
      expect(largeRetained.totalBytes).toBeGreaterThan(6 * MB);
      expect(largeRetained.totalBytes - smallRetained.totalBytes).toBeGreaterThan(4 * MB);

      // THE INVARIANT. With the checks sunk, growing the pages 12x must not grow
      // what the pass holds: measured 0.05 MB at 32 KB and 0.03 MB at 384 KB,
      // against 1.01 MB / 11.04 MB retaining. NOISE_BYTES is a band 7x wider
      // than any sample observed, and the term being guarded against is ten
      // megabytes, so the slack costs no sensitivity — re-introducing ONLY the
      // `ruleResultsMap` merge (leaving both per-page maps empty) puts
      // largeBounded back at 10.96 MB and fails here.
      expect(largeBounded.totalBytes - smallBounded.totalBytes).toBeLessThan(NOISE_BYTES);
      expect(largeBounded.totalBytes).toBeLessThan(NOISE_BYTES);

      // ...and at the SAME page size, bounded holds a small fraction of what
      // retaining does, which is the point of the whole exercise.
      expect(largeBounded.totalBytes).toBeLessThan(largeRetained.totalBytes * 0.25);
    },
    180_000,
  );
});
