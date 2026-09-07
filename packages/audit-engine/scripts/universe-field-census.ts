// Which FIELD of the streamed parsed universe carries the weight (#1860).
//
// universe-retention.ts says the universe holds ~100-150 KB per page after the
// detach. That is the term that scales with the whole crawl — it is built in
// Pass 1 and stays alive through the page loop and the site pass — so at 10k
// pages it is the difference between fitting a container and not. This says
// what it is made of.
//
// Measured by DROPPING one field from every retained page and re-collecting,
// inside a single process: a between-process comparison of two variants carries
// the run's own variance (±50 MB on this fixture), which at any page count this
// harness can afford is the same order as the signal.
//
//   bun run scripts/universe-field-census.ts --db /tmp/real150.sqlite

import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import { buildSiteContext, releaseSiteContextDocuments } from "../src/adapter";
import { collectDroppedBatch } from "../src/batch-gc";
import { detachParsedPage } from "../src/detach";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const BATCH = Number.parseInt(arg("batch", "50"), 10);

function retained(): number {
  Bun.gc(true);
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawls = await run(storage.listCrawls(1));
const crawlId = (crawls as Array<{ id: string }>)[0]!.id;

const kept: Array<Record<string, unknown>> = [];
const before = retained();

for (let offset = 0; ; offset += BATCH) {
  const batch = await run(storage.getPages(crawlId, { limit: BATCH, offset }));
  if (batch.length === 0) break;
  const ctx = await run(buildSiteContext(batch));
  for (const { parsed } of ctx) {
    if (!parsed) continue;
    // The accumulator's own two steps, in its order.
    if (parsed.content?.textContent) parsed.content.textContent = "";
    kept.push(detachParsedPage(parsed) as unknown as Record<string, unknown>);
  }
  releaseSiteContextDocuments(ctx);
  collectDroppedBatch();
  if (batch.length < BATCH) break;
}

const after = retained();
const pages = kept.length;

// Ordered biggest-suspect first only for readability; the drops are independent
// because no two fields share structure.
const FIELDS = [
  "links",
  "images",
  "content",
  "schemas",
  "schema",
  "headings",
  "meta",
  "og",
  "twitter",
  "h1",
  "contactLinks",
  "author",
  "pageType",
];

console.log(
  `db=${DB.split("/").pop()} pages=${pages}  universe holds ` +
    `${((after - before) / 1024 / 1024).toFixed(0)} MB ` +
    `(${Math.round((after - before) / pages / 1024)} KB/page, uncorrected for the harness floor)\n`,
);

let prev = after;
const rows: Array<[string, number]> = [];
for (const field of FIELDS) {
  for (const page of kept) page[field] = undefined;
  const now = retained();
  rows.push([field, prev - now]);
  prev = now;
}
kept.length = 0;
rows.push(["(page objects)", prev - retained()]);

rows.sort((a, b) => b[1] - a[1]);
for (const [field, bytes] of rows) {
  console.log(
    `  ${field.padEnd(16)} ${`${(bytes / 1024 / 1024).toFixed(1)} MB`.padStart(9)} ` +
      `${`${Math.round(bytes / pages / 1024)} KB/page`.padStart(14)}`,
  );
}
await run(storage.close());
