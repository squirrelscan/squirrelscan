/**
 * Rebuild one stored audit's report in a fresh process and write a V8 heap
 * snapshot of it (repo#1991). NOT product code.
 *
 * The report phase of a 10,000-page audit leaves about 1 GB of settled heap,
 * and snapshotting that from inside the audit (`SQUIRREL_HEAP_SNAPSHOT_DIR`)
 * needs the audit's own residency plus the snapshot at once, which an 8 GiB
 * box cannot hold. `reconstructReport` reads only the project database, so
 * running it here on the same database produces the same report object without
 * the crawl and rules phases' leftovers, and the snapshot is of that object.
 *
 * Usage (from repo root, with the stage's content store):
 *   SQUIRREL_CONTENT_STORE_PATH=<store.db> \
 *     bun benchmarks/harness/report-heap.ts <project.db> <out.heapsnapshot> [batchSize]
 */

// `benchmarks/` is not a workspace member, so it has no node_modules of its own.
import { Effect } from "../../apps/cli/node_modules/effect";

import { SQLiteStorage } from "../../packages/crawler/src/index.ts";
import { getGlobalContentStore } from "../../apps/cli/src/crawler/storage/content-store";
import { reconstructReport } from "../../apps/cli/src/reports/reconstruct";

const [dbPath, outPath, batchArg] = process.argv.slice(2);
if (!dbPath || !outPath) throw new Error("usage: report-heap.ts <project.db> <out.heapsnapshot> [batchSize]");

const mb = (b: number) => `${Math.round(b / (1024 * 1024))} MiB`;
const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
await Effect.runPromise(storage.init());
const crawls = await Effect.runPromise(storage.listCrawls());
const crawlId = crawls[0]?.id;
if (!crawlId) throw new Error(`no crawl in ${dbPath}`);

Bun.gc(true);
const before = process.memoryUsage();
const report = await Effect.runPromise(
  reconstructReport(storage, crawlId, undefined, { batchSize: Number(batchArg ?? 100) }),
);
Bun.gc(true);
const after = process.memoryUsage();
console.error(
  `crawl ${crawlId}: ${report.pages.length} pages; heapUsed ${mb(before.heapUsed)} -> ${mb(after.heapUsed)}, rss ${mb(after.rss)}`,
);
await Bun.write(outPath, Bun.generateHeapSnapshot("v8"));
// Keep the report reachable until the snapshot is taken.
console.error(`snapshot written to ${outPath} (${Object.keys(report.ruleResults).length} rules)`);
