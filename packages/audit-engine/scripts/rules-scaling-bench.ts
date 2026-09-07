// How the rules phases scale with page count (#1910).
//
// #1910 reports site rules going from 4s at 400 pages to 687s at 5,000 — about
// n^2 — with page rules at n^1.6 and even `parsePageRecord` per page rising from
// 5.5 to 40 ms, which is the strangest of the three, because parsing one page
// should not depend on how many other pages exist. This is the benchmark that
// re-measures those numbers under conditions where they can be believed.
//
// THREE THINGS THE ORIGINAL MEASUREMENT COULD NOT CONTROL, and this does:
//
//   - CONTENTION. #1910's own caveat says its 2,500 row was 589s wall against
//     360s CPU and its 5,000 row 2,236s against 1,023s, on a 16 GB box doing
//     150 MB/s of swap with a load average of 13. Wall time under those
//     conditions is mostly waiting. Run this on a quiet machine and read the
//     per-page columns, which is where a superlinear term shows up as a rising
//     number rather than as a big one.
//   - THE CONTENT STORE. #1908's full-table scan per stored page makes a single
//     crawl quadratic in its own page count and would dominate anything measured
//     through it. The fixtures here store html in the crawl DB itself and never
//     touch the global store, so it cannot participate.
//   - THE PATH. The CLI runs v1 (`runRulesOnStorage`, every page resident) and
//     the cloud runs the streamed pass; #1910 measured the CLI. Both are timed
//     here, because "site rules are quadratic" would mean something different
//     about each.
//
//   bun run scripts/build-mixed-fixture.ts --db /tmp/mix400.sqlite --pages 400
//   bun run scripts/rules-scaling-bench.ts --dbs /tmp/mix400.sqlite,/tmp/mix2500.sqlite
//
// Add `--profile` for per-rule timings, which is what names an individual rule
// that walks the page set once per page. Note that site rules run with bounded
// concurrency, so their per-rule times sum to MORE than the phase's wall time.

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
  type StreamingRulePhase,
} from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DBS = arg("dbs", "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
const BATCH = Number.parseInt(arg("batch", "200"), 10);

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

/**
 * Every rule on, nothing that reaches the network. `rules.enable: ["*"]` is not
 * optional: `filterRules` defaults every rule to DISABLED, so a bench without it
 * measures an empty rule set and reports a flat, meaningless line.
 */
function benchConfig(): Config {
  const base = getDefaultConfig();
  return {
    ...base,
    cloud: { ...base.cloud, enabled: false },
    intel: { ...base.intel, enabled: false },
    external_links: { ...base.external_links, enabled: false },
    rules: { enable: ["*"] },
  } as unknown as Config;
}

interface Row {
  pages: number;
  universeMs: number;
  pageRulesMs: number;
  siteRulesMs: number;
  siteQueryMs: number;
  v1ParseMs: number;
  v1RulesMs: number;
}

async function measure(db: string): Promise<Row> {
  const storage = new SQLiteStorage(db);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
  const pages = await run(storage.getPageCount(crawlId));

  const started = new Map<StreamingRulePhase, number>();
  const phase = new Map<StreamingRulePhase, number>();
  await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: BATCH,
      onPhase: (name, boundary) => {
        if (boundary === "start") started.set(name, Date.now());
        else phase.set(name, Date.now() - started.get(name)!);
      },
    }),
  );

  // v1, the path the CLI takes and the one #1910 measured. Its parse is timed
  // separately because #1910 reports per-page PARSE cost rising too, and in v1
  // the parse is a distinct step rather than part of the batched walk.
  const t0 = Date.now();
  const all = await run(storage.getPages(crawlId));
  const ctx = await run(buildSiteContext(all));
  const v1ParseMs = Date.now() - t0;
  const t1 = Date.now();
  await run(runRulesOnStorage(storage, crawlId, ctx, benchConfig(), EMPTY_ASSETS));
  const v1RulesMs = Date.now() - t1;

  await run(storage.close());
  return {
    pages,
    universeMs: phase.get("universe") ?? 0,
    pageRulesMs: phase.get("page-rules") ?? 0,
    siteRulesMs: phase.get("site-rules") ?? 0,
    siteQueryMs: phase.get("site-query") ?? 0,
    v1ParseMs,
    v1RulesMs,
  };
}

const rows: Row[] = [];
for (const db of DBS) {
  const row = await measure(db);
  rows.push(row);
  console.log(`measured ${db.split("/").pop()} (${row.pages} pages)`);
}

// PER-PAGE is the column that answers the question. A phase that doubles when
// the crawl doubles is linear and its per-page number is flat; a superlinear
// phase shows up here as a rising one, whatever the absolute times are.
const per = (ms: number, pages: number) => (ms / pages).toFixed(2);
console.log(
  `\n${"pages".padStart(6)} ` +
    `${"universe".padStart(9)} ${"/pg".padStart(6)} ` +
    `${"pageRules".padStart(10)} ${"/pg".padStart(6)} ` +
    `${"siteRules".padStart(10)} ${"/pg".padStart(6)} ` +
    `${"v1 parse".padStart(9)} ${"/pg".padStart(6)} ` +
    `${"v1 rules".padStart(9)} ${"/pg".padStart(6)}`,
);
for (const r of rows) {
  console.log(
    `${String(r.pages).padStart(6)} ` +
      `${`${r.universeMs}ms`.padStart(9)} ${per(r.universeMs, r.pages).padStart(6)} ` +
      `${`${r.pageRulesMs}ms`.padStart(10)} ${per(r.pageRulesMs, r.pages).padStart(6)} ` +
      `${`${r.siteRulesMs}ms`.padStart(10)} ${per(r.siteRulesMs, r.pages).padStart(6)} ` +
      `${`${r.v1ParseMs}ms`.padStart(9)} ${per(r.v1ParseMs, r.pages).padStart(6)} ` +
      `${`${r.v1RulesMs}ms`.padStart(9)} ${per(r.v1RulesMs, r.pages).padStart(6)}`,
  );
}

if (rows.length >= 2) {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const ratio = last.pages / first.pages;
  // The exponent, so a reader does not have to divide in their head. Linear is
  // 1.0; #1910 reports 2.0 for site rules.
  const exponent = (a: number, b: number) =>
    a > 0 && b > 0 ? (Math.log(b / a) / Math.log(ratio)).toFixed(2) : "n/a";
  console.log(
    `\nacross ${first.pages} -> ${last.pages} pages (${ratio.toFixed(1)}x), cost ~ n^k:\n` +
      `  universe   n^${exponent(first.universeMs, last.universeMs)}\n` +
      `  pageRules  n^${exponent(first.pageRulesMs, last.pageRulesMs)}\n` +
      `  siteRules  n^${exponent(first.siteRulesMs, last.siteRulesMs)}\n` +
      `  v1 parse   n^${exponent(first.v1ParseMs, last.v1ParseMs)}\n` +
      `  v1 rules   n^${exponent(first.v1RulesMs, last.v1RulesMs)}`,
  );
}
