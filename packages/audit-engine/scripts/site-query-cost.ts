// What createSiteQuery costs on a real-shape crawl (#1860).
//
//   bun run scripts/site-query-cost.ts --db X.sqlite [--batch 50]
//
// Reports the heap+external the call leaves behind (the SiteQuery itself plus
// the arena the scan grew, which never comes back) and its wall time. Run it
// before and after a change to the scan; both numbers move together when the
// scan stops materializing HTML it does not read.

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
let rssPeak = rssBefore;
// The scan awaits between batches, so a timer DOES get to run here — unlike a
// sampler placed around a synchronous loop, which never fires and reports 0.
const sampler = setInterval(() => {
  const r = process.memoryUsage.rss();
  if (r > rssPeak) rssPeak = r;
}, 5);
const t0 = performance.now();
const siteQuery = await run(createSiteQuery(storage, crawlId, { pageScanBatchSize: BATCH }));
const ms = performance.now() - t0;
clearInterval(sampler);
const rssAfter = process.memoryUsage.rss();
if (rssAfter > rssPeak) rssPeak = rssAfter;
const after = snap();

console.log(
  JSON.stringify({
    db: DB.split("/").pop(),
    pages: pageCount,
    batch: BATCH,
    ms: Math.round(ms),
    grownKB: Math.round((after - before) / 1024),
    grownPerPageKB: Math.round((after - before) / pageCount / 1024),
    rssPeakMB: Math.round((rssPeak - rssBefore) / 1024 / 1024),
    rssHeldMB: Math.round((rssAfter - rssBefore) / 1024 / 1024),
    // Touch the result so it cannot be collected before the sample.
    incoming: siteQuery.incomingLinkCounts().size,
  }),
);
await run(storage.close());
