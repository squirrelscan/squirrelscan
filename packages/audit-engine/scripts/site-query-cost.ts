// What createSiteQuery costs on a real-shape crawl (#1860).
//
//   bun run scripts/site-query-cost.ts --db X.sqlite [--batch 50]
//
// Reports two SEPARATE things, which is the whole point:
//
//   grownKB  the post-GC heapUsed+external delta — what the call still HOLDS.
//   rssDelta the process RSS delta — what the allocator grew and did not give
//            back, including memory the JS heap has already freed.
//
// A wide read feeding a narrow consumer moves the second and not the first, so
// reporting either alone hides it. This is an endpoint delta, not a sampled
// peak: the scan's batches do not reliably yield to the event loop, so a timer
// sampler placed here can record nothing at all.

import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { createSiteQuery } from "../src/site-query";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const BATCH = Number.parseInt(arg("batch", "50"), 10);

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawls = await run(storage.listCrawls(1));
const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
const pageCount = await run(storage.getPageCount(crawlId));

function snap(): number {
  Bun.gc(true);
  Bun.gc(true);
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

const before = snap();
const rssBefore = process.memoryUsage.rss();
const t0 = performance.now();
const siteQuery = await run(createSiteQuery(storage, crawlId, { pageScanBatchSize: BATCH }));
const ms = performance.now() - t0;
const rssAfter = process.memoryUsage.rss();
const after = snap();

console.log(
  JSON.stringify({
    db: DB.split("/").pop(),
    pages: pageCount,
    batch: BATCH,
    ms: Math.round(ms),
    grownKB: Math.round((after - before) / 1024),
    grownPerPageKB: Math.round((after - before) / pageCount / 1024),
    rssDeltaMB: Math.round((rssAfter - rssBefore) / 1024 / 1024),
    // Touch the result so it cannot be collected before the sample.
    incoming: siteQuery.incomingLinkCounts().size,
  }),
);
await run(storage.close());
