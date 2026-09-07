// Does SQUIRREL_STREAM_BATCH_BYTES bound the rules loop's peak RSS, and how much
// of that peak is the allocator not giving pages back? (#1860 follow-up.)
//
// The loop's retained data is ~80 KB/page (page-loop-census.ts) while its RSS
// moves by hundreds of MB, so the peak is set by one batch's working set plus
// whatever the allocator keeps. Both of those are supposed to follow the byte
// budget. This checks whether they do.
//
// Three things this measures that an in-process sampler cannot:
//
//   - The peak comes from the OS (`/usr/bin/time -l`, maximum resident set
//     size), not from a hook. The page loop is synchronous CPU that yields only
//     when `yieldEveryMs` is set, so a sampler on the heartbeat cannot see a
//     spike between two heartbeats — a batch's parse, one expensive rule — and
//     will report a floor on the peak as though it were the peak.
//   - The BUDGET is what varies, resolved through `resolveStreamBatch` exactly
//     as the cloud resolves it. Pinning a page count measures a number no
//     operator sets and says nothing about the dial.
//   - Nothing takes a heap snapshot. Generating one perturbs RSS by a few MB
//     and collects, so a run instrumented that way is not the run being sized.
//
//   bun run scripts/batch-budget-sweep.ts --db /tmp/real150.sqlite --budgets 6,12,24,48,96
//
// `--mimalloc` adds a second pass per budget with MIMALLOC_PURGE_DELAY=0, which
// makes mimalloc decommit freed pages immediately instead of after its default
// delay. Bun honours mimalloc's environment options (MIMALLOC_VERBOSE=1 prints
// its option dump), so this is a real lever and not a guess.
//
// --child is the inner half; the parent re-invokes this file with it.

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import {
  buildSiteContext,
  releaseSiteContextDocuments,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";
import { collectDroppedBatch } from "../src/batch-gc";
import { resolveStreamBatch } from "../src/batch-sizing";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
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

// ── child ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--child")) {
  const budgetBytes = Number.parseInt(arg("budget-bytes", "0"), 10);
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
  const pageCount = await run(storage.getPageCount(crawlId));

  // The cloud's own resolution, not a pinned page count.
  const batch = await run(resolveStreamBatch(storage, crawlId, pageCount, { byteBudget: budgetBytes }));

  // Boundary RSS only — one syscall-free read, no collect, no snapshot. The
  // loop already collects at every batch boundary (batch-gc.ts), so these say
  // whether RSS comes back after a batch that has just been collected.
  const boundaryRss: number[] = [];
  await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: batch.pages,
      hooks: { onBatch: () => boundaryRss.push(process.memoryUsage().rss) },
    }),
  );

  const endRss = process.memoryUsage().rss;
  Bun.gc(true);
  const endAfterGc = process.memoryUsage().rss;

  // Is the memory the allocator kept USABLE, or is it lost?
  //
  // RSS that does not come back after a collect is either pages the allocator
  // holds for reuse or pages that are gone. Subtracting a live-heap measure
  // cannot tell those apart — the difference also contains live native
  // allocations, SQLite's caches and resident JIT code. What does tell them
  // apart is the NEXT allocation: parse one more batch and see whether RSS
  // climbs again or the run is handed back what it already had.
  const probeBefore = process.memoryUsage().rss;
  const probeBatch = await run(storage.getPages(crawlId, { limit: batch.pages, offset: 0 }));
  const probeCtx = await run(buildSiteContext(probeBatch));
  const probePeak = process.memoryUsage().rss;
  releaseSiteContextDocuments(probeCtx);
  collectDroppedBatch();
  console.log(
    `CHILD ${JSON.stringify({
      budgetMB: Math.round(budgetBytes / MB),
      batchPages: batch.pages,
      avgPageKB: Math.round(batch.avgPageBytes / 1024),
      pages: pageCount,
      boundaryRssMB: boundaryRss.map((r) => Math.round(r / MB)),
      endRssMB: Math.round(endRss / MB),
      endRssAfterGcMB: Math.round(endAfterGc / MB),
      // How much fresh RSS one more batch needed, after the run had finished.
      // Near zero = the allocator's residency is reusable, so the peak is a
      // high-water and not a leak.
      reuseProbeMB: Math.round((probePeak - probeBefore) / MB),
    })}`,
  );
  await run(storage.close());
  process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────────────

const budgets = arg("budgets", "6,12,24,48,96")
  .split(",")
  .map((b) => Number.parseInt(b, 10) * MB)
  .filter((b) => Number.isFinite(b) && b > 0);
const withMimalloc = process.argv.includes("--mimalloc");
// Repeats are not optional at this signal-to-noise. Two runs of the same budget
// measured 370 MB and 525 MB, so a single number per budget cannot separate the
// budget's effect from the run's. The MINIMUM across repeats is the honest
// estimate of the floor: noise here adds pages, it does not give them back.
const REPEATS = Math.max(1, Number.parseInt(arg("repeat", "1"), 10));

interface Row {
  budgetMB: number;
  batchPages: number;
  purge: string;
  maxRssMB: number;
  endRssMB: number;
  endAfterGcMB: number;
  reuseProbeMB: number;
  boundaries: number[];
}
const rows: Row[] = [];

for (const budget of budgets) {
  for (const purge of withMimalloc ? ["default", "purge0"] : ["default"]) {
   const peaks: number[] = [];
   let lastRow: Row | undefined;
   for (let attempt = 0; attempt < REPEATS; attempt++) {
    const env = { ...process.env } as Record<string, string>;
    if (purge === "purge0") env.MIMALLOC_PURGE_DELAY = "0";
    const proc = Bun.spawnSync({
      cmd: [
        "/usr/bin/time",
        "-l",
        process.execPath,
        "run",
        import.meta.path,
        "--child",
        "--db",
        DB,
        "--budget-bytes",
        String(budget),
      ],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    const err = proc.stderr.toString();
    const childLine = out.split("\n").find((l) => l.startsWith("CHILD "));
    if (!childLine) {
      console.error(`budget ${budget / MB} MB (${purge}): child produced no result\n${err.slice(-800)}`);
      continue;
    }
    const child = JSON.parse(childLine.slice(6));
    // `/usr/bin/time -l` reports the high-water in BYTES on macOS and in KB on
    // Linux; the label is the same, so the unit is decided by the platform, not
    // by parsing. Getting this wrong is a factor of 1024, not a rounding error.
    const match = err.match(/(\d+)\s+maximum resident set size/);
    const raw = match ? Number.parseInt(match[1]!, 10) : 0;
    const maxRss = process.platform === "linux" ? raw * 1024 : raw;
    lastRow = {
      budgetMB: child.budgetMB,
      batchPages: child.batchPages,
      purge,
      maxRssMB: Math.round(maxRss / MB),
      endRssMB: child.endRssMB,
      endAfterGcMB: child.endRssAfterGcMB,
      reuseProbeMB: child.reuseProbeMB,
      boundaries: child.boundaryRssMB,
    };
    peaks.push(lastRow.maxRssMB);
    console.log(
      `budget ${String(child.budgetMB).padStart(3)} MB -> batch ${String(child.batchPages).padStart(4)} pages ` +
        `(avg page ${child.avgPageKB} KB)  ${purge.padEnd(8)} run ${attempt + 1}  ` +
        `OS peak ${String(lastRow.maxRssMB).padStart(5)} MB   ` +
        `end ${String(child.endRssMB).padStart(5)} MB   ` +
        `reuse-probe +${String(child.reuseProbeMB).padStart(4)} MB   ` +
        `boundaries [${child.boundaryRssMB.join(" ")}]`,
    );
   }
   if (lastRow) rows.push({ ...lastRow, maxRssMB: Math.min(...peaks) });
  }
}

// Peak per page of batch is the number the dial is supposed to hold constant.
console.log(
  `\nOS peak below is the MINIMUM over ${REPEATS} run(s) per cell.\n` +
    `${"budget".padStart(7)} ${"batch".padStart(6)} ${"purge".padEnd(8)} ${"OS peak".padStart(8)} ${"MB/page of batch".padStart(17)} ${"reuse probe".padStart(12)}`,
);
for (const row of rows) {
  console.log(
    `${`${row.budgetMB} MB`.padStart(7)} ${String(row.batchPages).padStart(6)} ${row.purge.padEnd(8)} ` +
      `${`${row.maxRssMB} MB`.padStart(8)} ${(row.maxRssMB / row.batchPages).toFixed(1).padStart(17)} ` +
      `${`+${row.reuseProbeMB} MB`.padStart(12)}`,
  );
}
