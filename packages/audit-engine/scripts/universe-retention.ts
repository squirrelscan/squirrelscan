// Measure what the streamed parsed universe retains per page (#1860 (a)).
//
//   bun run universe-retention.ts --db X.sqlite --mode plain|detach
//
// Mirrors createParsedUniverseAccumulator's retention exactly: keep the parsed
// scalars, drop textContent, release the batch's DOMs, force a collect, and
// report heapUsed+external held with the universe still alive.

import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { buildSiteContext, releaseSiteContextDocuments } from "../src/adapter";
import { detachParsedPage } from "../src/detach";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const MODE = arg("mode", "plain");
const BATCH = Number.parseInt(arg("batch", "50"), 10);
const MAX = Number.parseInt(arg("max", "1000000"), 10);

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawls = await run(storage.listCrawls(1));
const crawlId = (crawls as Array<{ id: string }>)[0]!.id;

const retained: unknown[] = [];
Bun.gc(true);
const before = process.memoryUsage();

let n = 0;
for (let offset = 0; offset < MAX; offset += BATCH) {
  const batch = await run(storage.getPages(crawlId, { limit: BATCH, offset }));
  if (batch.length === 0) break;
  if (MODE === "read") {
    // Control: read the batch and drop it without parsing anything.
    n += batch.length;
    Bun.gc(true);
    if (batch.length < BATCH) break;
    continue;
  }
  const ctx = await run(buildSiteContext(batch as never));
  for (const { page, parsed } of ctx) {
    if (!parsed) continue;
    const p = parsed as unknown as Record<string, unknown>;
    const content = p.content as { textContent?: string } | undefined;
    if (content?.textContent) content.textContent = "";
    if (MODE === "none") {
      // Control: retain nothing at all. Any per-page growth this reports is the
      // measurement's own floor (storage caches, arena) and must be subtracted.
    } else if (MODE === "scalars") {
      retained.push({
        url: page.normalizedUrl,
        finalUrl: page.finalUrl,
        statusCode: page.status,
        headers: {},
        redirectChain: page.redirectChain,
      });
    } else {
      retained.push({
        url: page.normalizedUrl,
        finalUrl: page.finalUrl,
        statusCode: page.status,
        parsed: MODE === "detach" ? detachParsedPage(p as never) : p,
        headers: {},
        redirectChain: page.redirectChain,
      });
    }
    n++;
  }
  releaseSiteContextDocuments(ctx);
  Bun.gc(true);
  if (batch.length < BATCH) break;
}

Bun.gc(true);
const after = process.memoryUsage();
const held = after.heapUsed - before.heapUsed + (after.external - before.external);
console.log(
  JSON.stringify({
    db: DB.split("/").pop(),
    mode: MODE,
    pages: n,
    retainedKB: Math.round(held / 1024),
    perPageKB: Math.round(held / n / 1024),
    heapPerPageKB: Math.round((after.heapUsed - before.heapUsed) / n / 1024),
    externalPerPageKB: Math.round((after.external - before.external) / n / 1024),
    alive: retained.length,
  }),
);
await run(storage.close());
