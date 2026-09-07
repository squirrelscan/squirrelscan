// What does SQUIRREL_STREAM_BATCH_BYTES actually buy? (#1860 follow-up.)
//
// The rules loop's retained data is ~80 KB/page (page-loop-census.ts) while its
// RSS moves by hundreds of MB, so the peak is set by a batch's working set plus
// whatever the allocator keeps rather than by anything the run holds. The byte
// budget is the only dial over that, and nothing recorded what turning it does.
//
// Four things this is careful about, each because the obvious version is wrong:
//
//   - The peak comes from the OS, not from a hook. The page loop is synchronous
//     CPU that yields only when `yieldEveryMs` is set, so a sampler on the
//     heartbeat cannot see a spike between two heartbeats and reports a floor on
//     the peak as though it were the peak.
//   - The BUDGET is what varies, resolved through the production
//     `resolveStreamBatch`. Pinning a page count measures a number no operator
//     sets and says nothing about the dial.
//   - Nothing takes a heap snapshot. Generating one perturbs RSS by a few MB and
//     collects, so an instrumented run is not the run being sized.
//   - The reuse probe runs in its OWN child. Parsing a batch at the end of the
//     measured process can set that process's high-water, which would put the
//     probe inside the number it is supposed to explain.
//
//   bun run scripts/batch-budget-sweep.ts --db /tmp/real150.sqlite \
//     --budgets 6,12,24,48,96 --repeat 3
//
// WHAT THE PEAK IS AND IS NOT. It is the high-water of a whole child process:
// the parsed universe, the site-fetch phase, the page loop, the site query, the
// site rules and the assembly. The universe and the page loop both take the
// resolved batch size, so the budget moves more than one phase and this cannot
// attribute the maximum to any single one of them. It is a whole-pipeline
// number, which is the right shape for sizing a container and the wrong shape
// for blaming a phase.
//
// `--mimalloc` adds a pass per budget with MIMALLOC_PURGE_DELAY=0, which asks
// mimalloc to decommit freed pages immediately rather than after its default
// delay. Bun honours mimalloc's environment options — `MIMALLOC_VERBOSE=1`
// prints its option dump — so this is a real setting and not a guess.
//
// macOS and Linux only, and they need different `time` invocations; anything
// else exits rather than reporting a number it cannot stand behind.
//
// --child and --probe-child are the inner halves; the parent re-invokes this
// file with them.

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

async function openCrawl(): Promise<{
  storage: SQLiteStorage;
  crawlId: string;
  pageCount: number;
}> {
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
  return { storage, crawlId, pageCount: await run(storage.getPageCount(crawlId)) };
}

// ── child: one measured run of the pipeline ──────────────────────────────────

if (process.argv.includes("--child")) {
  const budgetBytes = Number.parseInt(arg("budget-bytes", "0"), 10);
  const { storage, crawlId, pageCount } = await openCrawl();
  const batch = await run(
    resolveStreamBatch(storage, crawlId, pageCount, { byteBudget: budgetBytes }),
  );

  // Boundary RSS only — one read, no collect, no snapshot. The loop already
  // collects at every batch boundary (batch-gc.ts), so these say whether RSS
  // comes back after a batch that has just been collected.
  const boundaryRss: number[] = [];
  await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: batch.pages,
      hooks: { onBatch: () => boundaryRss.push(process.memoryUsage().rss) },
    }),
  );
  const endRss = process.memoryUsage().rss;
  await run(storage.close());
  console.log(
    `CHILD ${JSON.stringify({
      budgetMB: Math.round(budgetBytes / MB),
      batchPages: batch.pages,
      avgPageKB: Math.round(batch.avgPageBytes / 1024),
      pages: pageCount,
      boundaryRssMB: boundaryRss.map((r) => Math.round(r / MB)),
      endRssMB: Math.round(endRss / MB),
    })}`,
  );
  process.exit(0);
}

// ── child: the allocator reuse probe ─────────────────────────────────────────

if (process.argv.includes("--probe-child")) {
  const budgetBytes = Number.parseInt(arg("budget-bytes", "0"), 10);
  const { storage, crawlId, pageCount } = await openCrawl();
  const batch = await run(
    resolveStreamBatch(storage, crawlId, pageCount, { byteBudget: budgetBytes }),
  );

  // COLD: what one batch costs in fresh RSS from a standing start.
  const coldBefore = process.memoryUsage().rss;
  let rows = await run(storage.getPages(crawlId, { limit: batch.pages, offset: 0 }));
  let parsed = await run(buildSiteContext(rows));
  const coldPeak = process.memoryUsage().rss;
  releaseSiteContextDocuments(parsed);
  collectDroppedBatch();

  // Then the whole pipeline, so the process reaches its high-water.
  await run(
    runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
      batchSize: batch.pages,
    }),
  );
  Bun.gc(true);

  // WARM: the same batch again. Fresh RSS needed for it is what the allocator
  // could NOT hand back. Read the two together and nothing else: both arms have
  // the same SQLite and OS page cache state by construction, but the warm arm
  // also has a warm parser and JIT, so this is an upper bound on reuse rather
  // than an isolate of it.
  const warmBefore = process.memoryUsage().rss;
  rows = await run(storage.getPages(crawlId, { limit: batch.pages, offset: 0 }));
  parsed = await run(buildSiteContext(rows));
  const warmPeak = process.memoryUsage().rss;
  releaseSiteContextDocuments(parsed);
  collectDroppedBatch();
  await run(storage.close());

  console.log(
    `PROBE ${JSON.stringify({
      budgetMB: Math.round(budgetBytes / MB),
      batchPages: batch.pages,
      coldMB: Math.round((coldPeak - coldBefore) / MB),
      warmMB: Math.round((warmPeak - warmBefore) / MB),
    })}`,
  );
  process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────────────

/**
 * `time` differs between the two platforms in flag, label and unit, and getting
 * any of the three wrong yields a plausible-looking number rather than an error.
 * macOS `-l` prints "<bytes> maximum resident set size"; GNU time has no `-l`
 * and its own label and order, so it is given an explicit format with a marker
 * of ours and anchored parsing.
 */
const TIME = ((): { cmd: string[]; parse: (stderr: string) => number | null } => {
  if (process.platform === "darwin") {
    return {
      cmd: ["/usr/bin/time", "-l"],
      parse: (stderr) => {
        const m = stderr.match(/^\s*(\d+)\s+maximum resident set size$/m);
        return m ? Number.parseInt(m[1]!, 10) : null;
      },
    };
  }
  if (process.platform === "linux") {
    return {
      // GNU time reports maxrss in KB.
      cmd: ["/usr/bin/time", "-f", "SWEEP_MAXRSS_KB %M"],
      parse: (stderr) => {
        const m = stderr.match(/^SWEEP_MAXRSS_KB (\d+)$/m);
        return m ? Number.parseInt(m[1]!, 10) * 1024 : null;
      },
    };
  }
  console.error(
    `batch-budget-sweep: no maxrss source on ${process.platform}; macOS or Linux only.`,
  );
  process.exit(2);
})();

const budgets = arg("budgets", "6,12,24,48,96")
  .split(",")
  .map((b) => Number.parseInt(b, 10) * MB)
  .filter((b) => Number.isFinite(b) && b > 0);
const withMimalloc = process.argv.includes("--mimalloc");
// Repeats are not optional at this signal-to-noise: two runs of the same budget
// measured 344 MB and 417 MB, so one number per budget cannot separate the
// budget's effect from the run's. Hence a default of 3 rather than 1.
const REPEATS = Math.max(1, Number.parseInt(arg("repeat", "3"), 10));

interface ChildResult {
  record: Record<string, number | number[]>;
  maxRss: number | null;
}

function spawnChild(flag: string, budget: number, purge: string): ChildResult | null {
  const env = { ...process.env } as Record<string, string>;
  if (purge === "purge0") env.MIMALLOC_PURGE_DELAY = "0";
  const proc = Bun.spawnSync({
    cmd: [
      ...TIME.cmd,
      process.execPath,
      "run",
      import.meta.path,
      flag,
      "--db",
      DB,
      "--budget-bytes",
      String(budget),
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = proc.stderr.toString();
  // A non-zero exit invalidates the run even when the child printed its line
  // first: a failure after the print is still a failure, and the maxrss of a
  // process that died early is a small and entirely plausible number.
  if (proc.exitCode !== 0) {
    console.error(
      `  ${flag} budget ${budget / MB} MB (${purge}): exit ${proc.exitCode}\n${err.slice(-500)}`,
    );
    return null;
  }
  const prefix = flag === "--child" ? "CHILD " : "PROBE ";
  const line = proc.stdout
    .toString()
    .split("\n")
    .find((l) => l.startsWith(prefix));
  if (!line) {
    console.error(`  ${flag} budget ${budget / MB} MB (${purge}): no result line`);
    return null;
  }
  return { record: JSON.parse(line.slice(prefix.length)), maxRss: TIME.parse(err) };
}

interface Cell {
  budgetMB: number;
  batchPages: number;
  purge: string;
  peaksMB: number[];
  coldMB: number | null;
  warmMB: number | null;
}
const cells: Cell[] = [];

for (const budget of budgets) {
  for (const purge of withMimalloc ? ["default", "purge0"] : ["default"]) {
    const peaks: number[] = [];
    let batchPages = 0;
    for (let attempt = 0; attempt < REPEATS; attempt++) {
      const result = spawnChild("--child", budget, purge);
      if (!result || result.maxRss === null) {
        // A missing measurement is DROPPED, never folded in as a zero: a zero
        // wins every minimum and would read as the best result in the table.
        console.error(`  budget ${budget / MB} MB (${purge}) run ${attempt + 1}: dropped`);
        continue;
      }
      const peakMB = Math.round(result.maxRss / MB);
      peaks.push(peakMB);
      batchPages = result.record.batchPages as number;
      console.log(
        `budget ${String(result.record.budgetMB).padStart(3)} MB -> batch ${String(batchPages).padStart(4)} pages ` +
          `(avg page ${result.record.avgPageKB} KB)  ${purge.padEnd(8)} run ${attempt + 1}  ` +
          `OS peak ${String(peakMB).padStart(5)} MB   end ${String(result.record.endRssMB).padStart(5)} MB   ` +
          `boundaries [${(result.record.boundaryRssMB as number[]).join(" ")}]`,
      );
    }
    // One probe per cell, not per repeat: it is a separate process answering a
    // separate question, and repeating it buys nothing the peak repeats do not.
    const probe = spawnChild("--probe-child", budget, purge);
    if (probe) {
      console.log(
        `  reuse probe: one batch of ${probe.record.batchPages} pages costs ` +
          `${probe.record.coldMB} MB cold, ${probe.record.warmMB} MB again after the run`,
      );
    }
    if (peaks.length > 0) {
      cells.push({
        budgetMB: Math.round(budget / MB),
        batchPages,
        purge,
        peaksMB: peaks,
        coldMB: probe ? (probe.record.coldMB as number) : null,
        warmMB: probe ? (probe.record.warmMB as number) : null,
      });
    }
  }
}

// Min AND max, with the number of runs that actually produced a measurement.
// A minimum alone hides how far apart the runs were, and a fixed "n runs"
// heading would claim samples that were dropped. Every column here comes from
// the same cell's own runs — no row mixes an aggregate with one run's value.
console.log(
  `\n${"budget".padStart(7)} ${"batch".padStart(6)} ${"purge".padEnd(8)} ${"runs".padStart(5)} ` +
    `${"peak min".padStart(9)} ${"peak max".padStart(9)} ${"cold".padStart(7)} ${"warm".padStart(7)}`,
);
for (const cell of cells) {
  console.log(
    `${`${cell.budgetMB} MB`.padStart(7)} ${String(cell.batchPages).padStart(6)} ${cell.purge.padEnd(8)} ` +
      `${String(cell.peaksMB.length).padStart(5)} ${`${Math.min(...cell.peaksMB)} MB`.padStart(9)} ` +
      `${`${Math.max(...cell.peaksMB)} MB`.padStart(9)} ` +
      `${(cell.coldMB === null ? "-" : `${cell.coldMB} MB`).padStart(7)} ` +
      `${(cell.warmMB === null ? "-" : `${cell.warmMB} MB`).padStart(7)}`,
  );
}
