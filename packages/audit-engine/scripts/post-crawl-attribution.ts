// Attribute the post-crawl RSS steps the CLOUD path actually takes (#1860).
//
// Production run 01M1XAA5GBR8SHXG10NZZB2PAR (drscholls.com, 150 pages, full,
// rendered, cloud prefetch on, standard-3) showed the streamed page loop flat
// (2583 -> 2659 MB across 120 pages) with two ~1 GB steps around it:
//
//   (a) +1.1 GB between "rules started" and the first 20-page heartbeat
//   (b) +1.0 GB between the last page heartbeat and "rules completed"
//
// `runStreamingRules` emitted nothing between those points, so neither step
// could be attributed from the event stream. It now emits sub-phase boundaries;
// this samples RSS around each one against a real crawl DB.
//
// Sampling is SYNCHRONOUS at each boundary: these phases are sync CPU that never
// yields, so a timer-based sampler records nothing until they finish (an
// interval sampler reported a peak of 0 the first time this was tried).
//
//   bun run scripts/post-crawl-attribution.ts --db /tmp/crawl.sqlite --batch 50

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { runStreamingRules, type PreFetchedAssets, type StreamingRulePhase } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const DB = arg("db", "/tmp/squirrel-bench.sqlite")!;
const BATCH = Number.parseInt(arg("batch", "50")!, 10);
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

const rss = () => process.memoryUsage().rss;

async function main(): Promise<void> {
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = crawls[0]?.id;
  if (!crawlId) throw new Error(`no crawl in ${DB}`);
  const pageCount = await run(storage.getPageCount(crawlId));

  console.log(`db=${DB} pages=${pageCount} batch=${BATCH}\n`);
  Bun.gc(true);
  const base = rss();
  console.log(`baseline rss=${(base / MB).toFixed(0)} MB\n`);

  const started = new Map<StreamingRulePhase, number>();
  const peak = new Map<StreamingRulePhase, number>();
  let pagesDone = 0;

  const result = await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: BATCH,
      onPhase: (phase, boundary) => {
        if (boundary === "start") {
          started.set(phase, rss());
          return;
        }
        const from = started.get(phase) ?? base;
        const to = rss();
        peak.set(phase, to - from);
        console.log(
          `${phase.padEnd(12)} ${`${(from / MB).toFixed(0)}`.padStart(6)} -> ${`${(to / MB).toFixed(0)}`.padStart(6)} MB` +
            `   delta ${((to - from) / MB).toFixed(0).padStart(6)} MB`,
        );
      },
      pageLoopHooks: {
        heartbeatEveryPages: 20,
        onProgress: (done) => {
          pagesDone = done;
          console.log(`  page-rules heartbeat ${done} pages  rss=${(rss() / MB).toFixed(0)} MB`);
        },
      },
    }),
  );

  console.log(`\npages scored=${pagesDone} findings-rules=${result.ruleResultsMap.size}`);
  console.log(`final rss=${(rss() / MB).toFixed(0)} MB (baseline ${(base / MB).toFixed(0)} MB)`);
  await run(storage.close());
}

await main();
