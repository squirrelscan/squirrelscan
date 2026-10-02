// Child-process probe for page-rule-residency-2343.test.ts (squirrelscan/repo#2343).
//
// Measures what ONE `streamPageRules` pass still holds once it has returned, in
// a fresh process, and prints it as one JSON line:
//
//   bun tests/helpers/residency-probe.ts <crawl.db> <retain: 1|0>
//
// Why a child process. In CI this package runs as one `bun test` process of ~70
// files, and JSC scans the native stack conservatively: a stale slot can keep a
// FINISHED pass reachable, generator frame and all. The bounded arm then read
// 16 MB on a CI runner and 21.9 MB locally after four other engine test files,
// against 0.03 MB alone. A heap snapshot of the bad case showed the batch held
// by a closure with no heap retainers (a native root) over the finished
// generator. Worse, the pin is released a pass or two later, so a repeated
// measurement in the same process reads NEGATIVE by the same amount, which can
// hide a real leak as easily as it fakes one (a min-of-3 in-process version
// passed with the `ruleResultsMap` merge put back). A fresh process has no other
// file's stack history to inherit.

import { heapStats } from "bun:jsc";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { PageData, RuleMeta, RuleRunner, SiteData } from "@squirrelscan/rules";

import { streamPageRules, type PageResultSink } from "../../src/streaming";

/** How much of each page a finding quotes — the fraction a real rule's items are. */
const QUOTE_FRACTION = 0.25;

export interface Residency {
  /** Heap still held once the pass has returned, over the whole crawl. */
  totalBytes: number;
  pagesScored: number;
  /** Checks the sink received — 0 would make every assertion vacuous. */
  checksSunk: number;
  retainedPageMaps: number;
  ruleIdsTallied: number;
}

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

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
 * A rule whose finding QUOTES the page, which is the behaviour that makes real
 * findings scale with page bytes. `RuleRunner` is a class and the loop only
 * calls these two members, so a structural stand-in is cast rather than
 * subclassed (subclassing would drag in the whole registry).
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
 * Live JS heap after a forced collection. `process.memoryUsage().heapUsed` lags
 * string memory on Bun (20 MB of retained strings read 0.2 MB, then 20.5 MB a
 * sample later); `heapStats().heapSize` tracks it. Two collections: the first
 * drops the pass's garbage, the second settles what finalizing it freed.
 */
function liveHeapBytes(): number {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
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

  const before = liveHeapBytes();
  const result = await run(
    streamPageRules(storage, crawlId, quotingRunner(), siteData(), {
      batchSize: 10,
      retainPageResults: retain,
      pageSink: sink,
      // Off: the fan-out reads the real registry, and copying one page's verdict
      // onto its cluster would decouple what is retained from the pages that
      // produced it.
      templateFanout: false,
    }),
  );
  const after = liveHeapBytes();

  // Read `result` only AFTER the sample, so what is measured is a live object.
  const out: Residency = {
    totalBytes: after - before,
    pagesScored: result.pageUrls.length,
    checksSunk,
    retainedPageMaps: result.pageResults.size + result.pageRuleResults.size,
    ruleIdsTallied: result.tallies.size,
  };
  await run(storage.close());
  return out;
}

if (import.meta.main) {
  const [dbPath, retainArg] = process.argv.slice(2);
  if (!dbPath || (retainArg !== "1" && retainArg !== "0")) {
    console.error("usage: residency-probe.ts <crawl.db> <retain: 1|0>");
    process.exit(2);
  }
  // Warm-up, discarded: the first pass in a process pays module-load and JIT
  // garbage that the next forced collection reclaims, so its delta is skewed.
  await measure(dbPath, true);
  console.log(JSON.stringify(await measure(dbPath, retainArg === "1")));
}
