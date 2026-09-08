// Template cluster census (#1949) — what `page_features.template_fp` groups a
// real crawl into, read straight off a finished `project.db`. No network, and no
// write to the crawl it reads.
//
//   bun run scripts/template-cluster-census.ts --db ~/.squirrel/projects/rl-e2e/project.db
//   bun run scripts/template-cluster-census.ts --db <path> --crawl <id>
//
// It does NOT trust its own in-memory grouping. Crawls finished before #1949 hold
// `template_fp NULL` on every row, so the only honest way to check the shipped
// path end to end is to replay it: run the REAL writer (`extractPageFeatures`)
// into a scratch `:memory:` store, then read the clusters back through the REAL
// reader (`getPageFeatureTemplateClusters`, i.e. `SiteQuery.templateClusters()`)
// and require the SQL `GROUP BY` to agree with the grouping computed here. A
// census that only hashed in memory would print identical totals against an
// entirely null column.
//
// Why this lives here and not in packages/audit-engine/scripts: a finished
// project.db stores `pages.html` as NULL and keeps the bytes in the GLOBAL content
// store, which is a CLI module. A `SQLiteStorage` built without
// `getGlobalContentStore()` reads every page as html-less, parses nothing, and
// reports zero clusters while looking like it worked.
//
// The numbers this is here to hold the key to (measured for #1026):
//
//   corpus                      pages  clusters  multi-page  redundant
//   gymshark.com                  247        13           8      94.7%
//   openelectricity.org.au        100        12           3      88.0%
//
// Do NOT re-derive those from the synthetic bench corpora. They are generated from
// 1-6 templates, so every clustering definition collapses to ~99% redundancy on
// them and the answer comes out flattering and wrong.

import { SQLiteStorage } from "@squirrelscan/crawler";
import {
  buildSiteContext,
  extractPageFeatures,
  isAuditablePage,
  templateFingerprintKey,
} from "@squirrelscan/audit-engine";
import { fingerprintPage } from "@squirrelscan/rules";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";
import { Effect } from "effect";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getGlobalContentStore } from "@/crawler/storage/content-store";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const DB = arg("db", "");
if (!DB) {
  console.error("usage: bun run scripts/template-cluster-census.ts --db <project.db> [--crawl <id>]");
  process.exit(1);
}

// Validated as TEXT before anything opens. `getPages` passes the limit straight to
// SQLite, where `LIMIT 0` means NO limit, and `offset += 0` never advances — so a
// non-positive batch reads the whole crawl forever instead of erroring. Checking
// the string rather than the parsed number matters: `parseInt` turns "1.5" into 1,
// "50garbage" into 50 and "1e3" into 1, and all three pass an is-integer test.
const BATCH_ARG = arg("batch", "50");
if (!/^[1-9][0-9]{0,6}$/.test(BATCH_ARG)) {
  console.error(`--batch must be a positive integer, got ${JSON.stringify(BATCH_ARG)}`);
  process.exit(1);
}
const BATCH = Number.parseInt(BATCH_ARG, 10);

// `SQLiteStorage.init()` opens the file WRITABLE, switches it to WAL and runs
// migrations, so pointing it at a corpus would silently upgrade someone's crawl,
// and a mistyped path would create an empty database rather than fail. Census a
// disposable copy instead, sidecars included so the copy is not missing committed
// pages. This is what "no write to the crawl it reads" costs.
if (!existsSync(DB)) {
  console.error(`no such database: ${DB}`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "squirrel-census-"));
const dbCopy = join(scratch, "census.db");
copyFileSync(DB, dbCopy);
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(DB + suffix)) copyFileSync(DB + suffix, dbCopy + suffix);
}

const storage = new SQLiteStorage(dbCopy, getGlobalContentStore());
await run(storage.init());

const crawlArg = arg("crawl", "");
const crawls = (await run(storage.listCrawls(50))) as Array<{ id: string; baseUrl?: string }>;
const crawlId = crawlArg || crawls[0]?.id;
if (!crawlId) {
  console.error("no crawls in this db");
  process.exit(1);
}

// The scratch store the replayed page_features rows go into. The crawl being
// censused is never written to.
const replay = new SQLiteStorage(":memory:");
await run(replay.init());

const byKey = new Map<string, string[]>();
let scored = 0;
let rateLimited = 0;
let noKey = 0;
let fingerprintMs = 0;
let keyMs = 0;

for (let offset = 0; ; offset += BATCH) {
  const batch = await run(storage.getPages(crawlId, { limit: BATCH, offset }));
  if (batch.length === 0) break;
  const ctx = await run(buildSiteContext(batch));

  for (const { page, parsed } of ctx) {
    if (!parsed) continue;
    // Production's scored universe, not `isAuditablePage` alone: the streamed
    // loop takes v1's page universe, which drops rate-limited pages as well as
    // WAF challenges (#1829). Grading a 429 body would put a page nobody has
    // seen into a cluster.
    if (isRateLimitStatus(page.status)) {
      rateLimited++;
      parsed.document = null;
      continue;
    }
    if (!isAuditablePage(page)) {
      parsed.document = null;
      continue;
    }

    // Split, because the two halves answer different questions: the DOM walk was
    // already being paid by `buildCollectedPageSignal` and is shared now, so only
    // the key reduction is new work in the streamed loop.
    const t0 = Bun.nanoseconds();
    const fp = fingerprintPage(parsed, page.normalizedUrl);
    const t1 = Bun.nanoseconds();
    const key = templateFingerprintKey(fp);
    const t2 = Bun.nanoseconds();
    fingerprintMs += (t1 - t0) / 1e6;
    keyMs += (t2 - t1) / 1e6;

    // The shipped writer, with the shipped argument, so what lands in the scratch
    // column is what a real crawl would store — not a key this script computed.
    await run(replay.upsertPageFeatures(crawlId, extractPageFeatures(page, parsed, { fingerprint: fp })));

    scored++;
    if (key == null) {
      noKey++;
    } else {
      const urls = byKey.get(key);
      if (urls) urls.push(page.normalizedUrl);
      else byKey.set(key, [page.normalizedUrl]);
    }
    parsed.document = null;
  }
}

const clusters = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length);
const multi = clusters.filter(([, urls]) => urls.length > 1);
const singletons = clusters.length - multi.length;
const redundant = clusters.reduce((n, [, urls]) => n + urls.length - 1, 0);

// The check that makes the rest of this output mean anything: the same clusters,
// read back out of the column through the reader the product uses. It reports
// multi-page groups only (`HAVING count > 1`), so that is what it is compared to.
const stored = await run(
  replay.getPageFeatureTemplateClusters(crawlId, {
    maxGroups: 100_000,
    maxUrlsPerGroup: 100_000,
  }),
);
const asText = (rows: Array<{ fp: string; urls: string[] }>): string =>
  JSON.stringify(
    rows.map((r) => [r.fp, [...r.urls].sort()]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
  );
const expected = multi.map(([fp, urls]) => ({ fp, urls }));
if (asText(stored) !== asText(expected)) {
  console.error("STORED CLUSTERS DISAGREE with the recomputed grouping");
  console.error(`  stored   ${stored.length} groups`);
  console.error(`  expected ${expected.length} groups`);
  process.exit(2);
}

console.log(`db          ${DB}`);
console.log(`crawl       ${crawlId}`);
console.log(`pages       ${scored} scored (${rateLimited} rate-limited, ${noKey} with no key)`);
console.log(`clusters    ${clusters.length} (${multi.length} multi-page, ${singletons} singleton)`);
console.log(
  `redundant   ${redundant} pages (${((redundant / Math.max(1, scored - noKey)) * 100).toFixed(1)}%)`,
);
console.log(
  `GROUP BY    ${stored.length} multi-page groups over ${stored.reduce((n, g) => n + g.count, 0)} pages — agrees`,
);
console.log(
  `fingerprint ${fingerprintMs.toFixed(0)} ms total, ${(fingerprintMs / Math.max(1, scored)).toFixed(3)} ms/page (shared DOM walk, already paid)`,
);
console.log(
  `key         ${keyMs.toFixed(0)} ms total, ${(keyMs / Math.max(1, scored)).toFixed(3)} ms/page (the new work)`,
);
console.log("");
for (const [key, urls] of clusters) {
  console.log(`  ${key}  ${String(urls.length).padStart(4)}  ${urls[0]}`);
}

// `close()` returns an Effect; calling it bare leaves the handle open.
await run(replay.close());
await run(storage.close());
rmSync(scratch, { recursive: true, force: true });
