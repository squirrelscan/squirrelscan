// How much of the streamed loop's RSS is the batch working set, and how much is
// the allocator not giving it back (#1860 follow-up).
//
// The rules phase's RSS step looks like per-page growth and is not: the loop's
// retained data is ~80 KB/page (page-loop-census.ts) while RSS moves by hundreds
// of MB. This separates the three things that can be true at a batch boundary:
//
//   LIVE     what the JS heap actually holds, from a heap snapshot, plus
//            `external` (string backing stores, which the snapshot's node sizes
//            under-count for slices).
//   RSS      what the OS has given the process and the OOM killer counts.
//   RSS-LIVE the allocator's residency — freed, unreturned.
//
// Every sample is taken after a synchronous collect, so a gap between LIVE and
// RSS at a boundary is memory nothing is using and nothing will reclaim.
//
//   bun run scripts/batch-floor.ts --db /tmp/real150.sqlite --batch 50
//
// Run it across batch sizes to see whether peak RSS is proportional to the batch
// — which is the question behind the SQUIRREL_STREAM_BATCH_BYTES dial. If it is,
// the dial is the whole control and no code change buys anything.

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { runStreamingRules, type PreFetchedAssets } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const BATCH = Number.parseInt(arg("batch", "50"), 10);
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

/**
 * Live JS-heap bytes, summed from a heap snapshot's node sizes.
 *
 * The snapshot is the only measure here that cannot include garbage: it walks
 * what is reachable. `heapUsed` reports the allocator's view of the heap, which
 * includes blocks it has not swept.
 */
function liveHeapBytes(): number {
  const snapshot = Bun.generateHeapSnapshot() as unknown as { nodes: number[] };
  const { nodes } = snapshot;
  let total = 0;
  for (let i = 0; i < nodes.length / 4; i++) total += nodes[i * 4 + 1]!;
  return total;
}

interface Sample {
  label: string;
  pages: number;
  live: number;
  rss: number;
}

const samples: Sample[] = [];

function sample(label: string, pages: number): Sample {
  Bun.gc(true);
  const memory = process.memoryUsage();
  const row = {
    label,
    pages,
    live: liveHeapBytes() + memory.external,
    rss: memory.rss,
  };
  samples.push(row);
  return row;
}

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawls = await run(storage.listCrawls(1));
const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
const pageCount = await run(storage.getPageCount(crawlId));

const base = sample("baseline", 0);
console.log(
  `db=${DB.split("/").pop()} pages=${pageCount} batch=${BATCH}  ` +
    `mimalloc env: ${Object.keys(process.env).filter((k) => k.startsWith("MIMALLOC_")).join(",") || "none"}\n`,
);
console.log(`${"point".padEnd(22)} ${"pages".padStart(6)} ${"LIVE".padStart(9)} ${"RSS".padStart(9)} ${"RSS-LIVE".padStart(10)}`);
const show = (row: Sample) =>
  console.log(
    `${row.label.padEnd(22)} ${String(row.pages).padStart(6)} ` +
      `${`${(row.live / MB).toFixed(0)} MB`.padStart(9)} ${`${(row.rss / MB).toFixed(0)} MB`.padStart(9)} ` +
      `${`${((row.rss - row.live) / MB).toFixed(0)} MB`.padStart(10)}`,
  );
show(base);

// Peak RSS is sampled at heartbeats WITHOUT a collect: the high-water is what
// the container is charged for, and forcing a collect first would report the
// number after the thing being measured had already been cleaned up.
let peakRss = 0;

await run(
  runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
    batchSize: BATCH,
    hooks: {
      onBatch: ({ batchIndex, pagesDone }) => show(sample(`batch ${batchIndex} end`, pagesDone)),
    },
    pageLoopHooks: {
      heartbeatEveryPages: Math.max(1, Math.floor(BATCH / 4)),
      onProgress: () => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      },
    },
  }),
);

const end = sample("loop end", pageCount);
const boundaries = samples.filter((s) => s.label.startsWith("batch "));
const floor = boundaries.length > 0 ? Math.min(...boundaries.map((s) => s.rss)) : end.rss;

console.log(
  `\npeak RSS in loop (no collect)   ${(peakRss / MB).toFixed(0)} MB` +
    `\nlowest boundary RSS (collected) ${(floor / MB).toFixed(0)} MB` +
    `\nbatch swing (peak - floor)      ${((peakRss - floor) / MB).toFixed(0)} MB` +
    `\nallocator residency at end      ${((end.rss - end.live) / MB).toFixed(0)} MB` +
    ` (RSS ${(end.rss / MB).toFixed(0)}, live ${(end.live / MB).toFixed(0)})`,
);
await run(storage.close());
