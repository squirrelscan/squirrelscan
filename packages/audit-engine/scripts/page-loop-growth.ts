// What the streamed page loop still RETAINS per page (#1860).
//
// post-crawl-attribution.ts samples RSS, which is the number the OOM killer
// sees but not the number that says whether the pipeline is holding data: the
// JSC arena absorbs retention and never gives allocations back, so RSS reports
// a flat loop over a leak and a rising loop over churn. heapUsed + external is
// the retention measure (see #234 / the detach work).
//
// This samples BOTH, each after a synchronous collect, at two different points:
//
//   - at every FULL BATCH boundary, which is where the slope comes from. Two
//     things make any other sample incomparable. Inside a batch the loop
//     releases each page's document as it finishes it, so the working set is
//     DRAINING while the accumulators fill. And the boundary hook runs before
//     the batch's PageRecords leave scope, so a short final batch is holding
//     fewer of them than a full one — 30 pages of html against 50 — which on
//     its own can turn a growing loop into a negative slope. Partial batches
//     are therefore printed and excluded from the fit.
//   - at every heartbeat, as an in-batch trace. Reported, not fitted.
//
// A gap between the retained and RSS slopes means the growth is allocator
// residency, not retained data.
//
// What it reports is a TAIL slope, not a steady state: the first boundary is
// excluded because it alone carries the walk's one-time startup allocation, and
// that allocation is real memory the run holds — it moves into the intercept,
// it does not vanish. Read the printed absolute samples alongside the slope.
//
// This is a DIAGNOSTIC, not a measurement of any one structure. Its slope moves
// by a factor of two between runs of the same fixture, because a whole-pipeline
// heapUsed sample carries the arena's growth policy along with the data. To
// attribute bytes to a structure, drop that structure inside one process and
// re-collect — page-loop-census.ts and universe-field-census.ts do that, and
// their per-page figures repeat exactly at 50, 100 and 150 pages.
//
//   bun run scripts/page-loop-growth.ts --db /tmp/real150.sqlite --batch 50
//
// `--every N` sets the heartbeat interval (default 10 pages).

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { runStreamingRules, type PreFetchedAssets, type StreamingRulePhase } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const BATCH = Number.parseInt(arg("batch", "50"), 10);
const EVERY = Number.parseInt(arg("every", "10"), 10);
const MB = 1024 * 1024;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

function benchConfig(): Config {
  const base = getDefaultConfig();
  return {
    ...base,
    cloud: { ...base.cloud, enabled: false },
    intel: { ...base.intel, enabled: false },
    external_links: { ...base.external_links, enabled: false },
  } as Config;
}

/** Retained bytes: heap plus external, after a synchronous collect. */
function retained(): number {
  Bun.gc(true);
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}
const rss = () => process.memoryUsage().rss;

/** Least-squares slope of y over x, in bytes per page. */
function slope(points: Array<[number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((a, [x]) => a + x, 0) / n;
  const my = points.reduce((a, [, y]) => a + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  return den === 0 ? 0 : num / den;
}

async function main(): Promise<void> {
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = (crawls as Array<{ id: string }>)[0]?.id;
  if (!crawlId) throw new Error(`no crawl in ${DB}`);
  const pageCount = await run(storage.getPageCount(crawlId));

  const base = retained();
  const baseRss = rss();
  console.log(
    `db=${DB.split("/").pop()} pages=${pageCount} batch=${BATCH}  ` +
      `baseline retained=${(base / MB).toFixed(0)} MB rss=${(baseRss / MB).toFixed(0)} MB\n`,
  );

  const started = new Map<StreamingRulePhase, { retained: number; rss: number }>();
  /** Full-batch boundary samples — the only ones the slope is fitted to. */
  const samples: Array<[number, number]> = [];
  const rssSamples: Array<[number, number]> = [];
  let lastBoundaryPages = 0;
  let peakInLoop = 0;

  const result = await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: BATCH,
      onPhase: (phaseName, boundary) => {
        if (boundary === "start") {
          started.set(phaseName, { retained: retained(), rss: rss() });
          return;
        }
        const from = started.get(phaseName)!;
        const toRetained = retained();
        const toRss = rss();
        console.log(
          `${phaseName.padEnd(12)} retained ${`${(from.retained / MB).toFixed(0)}`.padStart(5)} -> ` +
            `${`${(toRetained / MB).toFixed(0)}`.padStart(5)} MB (${((toRetained - from.retained) / MB).toFixed(0).padStart(5)})   ` +
            `rss ${`${(from.rss / MB).toFixed(0)}`.padStart(5)} -> ${`${(toRss / MB).toFixed(0)}`.padStart(5)} MB ` +
            `(${((toRss - from.rss) / MB).toFixed(0).padStart(5)})`,
        );
      },
      hooks: {
        onBatch: ({ batchIndex, pagesDone }) => {
          const r = retained();
          const s = rss();
          // The hook runs while this batch's PageRecords are still in scope, so
          // a short batch is holding less html than a full one and its sample
          // is not comparable to the others.
          const full = pagesDone - lastBoundaryPages === BATCH;
          lastBoundaryPages = pagesDone;
          if (full) {
            samples.push([pagesDone, r]);
            rssSamples.push([pagesDone, s]);
          }
          console.log(
            `  batch ${String(batchIndex).padStart(3)} end (${String(pagesDone).padStart(4)} pages)` +
              `${full ? "     " : " PART"}  ` +
              `retained=${`${(r / MB).toFixed(0)}`.padStart(5)} MB  rss=${`${(s / MB).toFixed(0)}`.padStart(5)} MB`,
          );
        },
      },
      pageLoopHooks: {
        heartbeatEveryPages: EVERY,
        onProgress: (done) => {
          // Trace only. These land mid-batch, where the batch's documents are
          // part-released, so they are not comparable to each other and must
          // not be fitted. The maximum over them is a POST-COLLECT high-water,
          // not the container's: `retained()` collects before it samples, so a
          // real RSS peak between two heartbeats is never seen. batch-floor.ts
          // is what samples the uncollected peak.
          const r = retained();
          peakInLoop = Math.max(peakInLoop, r);
          console.log(
            `  pages ${String(done).padStart(4)}  retained=${`${(r / MB).toFixed(0)}`.padStart(5)} MB  ` +
              `rss=${`${(rss() / MB).toFixed(0)}`.padStart(5)} MB`,
          );
        },
      },
    }),
  );

  // The first FULL boundary is dropped too: it is the only one whose preceding
  // state is "no batch has ever been read", so it carries the walk's one-time
  // startup allocation. That allocation does not disappear by being excluded —
  // it moves into the intercept, which is why the absolute samples are printed.
  const fitted = samples.slice(1);
  const fittedRss = rssSamples.slice(1);
  if (fitted.length < 2) {
    console.log(
      `\nPAGE LOOP TAIL SLOPE  not measurable: ${samples.length} full-batch boundaries, ` +
        `and the first is startup. Lower --batch, or use more pages.`,
    );
  } else {
    console.log(
      `\nPAGE LOOP TAIL SLOPE (full boundaries 2..${samples.length}, startup excluded)  ` +
        `retained ${(slope(fitted) / 1024).toFixed(0)} KB/page   ` +
        `rss ${(slope(fittedRss) / 1024).toFixed(0)} KB/page`,
    );
  }
  console.log(
    `max post-collect retained across mid-batch samples ${(peakInLoop / MB).toFixed(0)} MB ` +
      `(NOT the container peak — see batch-floor.ts)`,
  );

  // What the RESULT holds after the run, measured by dropping one field at a
  // time: each line is the drop in retained bytes when that reference goes.
  // Dropped on `result` ITSELF — a copy of the reference kept anywhere else
  // would keep the structure alive and report every field as free.
  const bag = result as unknown as Record<string, unknown>;
  const fields = [
    "pageResults",
    "pageRuleResults",
    "ruleResultsMap",
    "parsedPages",
    "tallies",
    "siteResults",
  ];
  let prev = retained();
  console.log(`\nresult holds ${(prev / MB).toFixed(0)} MB; dropping one field at a time:`);
  for (const key of fields) {
    bag[key] = undefined;
    const now = retained();
    const freed = prev - now;
    console.log(
      `  ${key.padEnd(16)} ${`${(freed / MB).toFixed(1)} MB`.padStart(10)}  ` +
        `${`${Math.round(freed / pageCount / 1024)} KB/page`.padStart(14)}`,
    );
    prev = now;
  }
  console.log(`  ${"rest".padEnd(16)} ${`${((prev - base) / MB).toFixed(1)} MB`.padStart(10)}`);

  await run(storage.close());
}

await main();
