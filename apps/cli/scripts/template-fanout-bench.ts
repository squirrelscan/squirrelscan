// What template fan-out (#1951) is worth, measured on a finished `project.db`.
// No network, and no write to the crawl it reads.
//
//   bun run scripts/template-fanout-bench.ts --db ~/.squirrel/projects/rl-e2e/project.db
//   bun run scripts/template-fanout-bench.ts --db <path> --verify       # equivalence, not timing
//   bun run scripts/template-fanout-bench.ts --db <path> --profile      # per-rule attribution
//
// It measures the STREAMED PAGE-RULE PASS only (`streamPageRules`) — the phase
// the change is in. That pass is pure sync CPU over stored HTML: no site rules, so
// nothing here reaches the network, which two things in the site phase otherwise
// do (`security/http-to-https` probes sample URLs, and the soft-404 confirmation
// re-fetches candidates). A rules-phase number measured with either of those in it
// is a number about the network.
//
// METHOD, and why each part is there (the traps are recorded in
// benchmarks/2026-09-perf-program.md and cost several confident wrong headlines):
//
//  - **Every measurement runs in its own CHILD PROCESS.** Two arms in one process
//    share a warm JIT, a warm linkedom and a warm SQLite page cache, and whichever
//    runs second wins for reasons that have nothing to do with the change.
//  - **The arms are INTERLEAVED and the report is the MEDIAN**, not the minimum of
//    a block per arm: a machine that gets busier during the run otherwise loads
//    the whole penalty onto whichever arm ran last. State the load average.
//  - **CPU time is reported alongside wall time, and on a busy box it is the one
//    to read.** Five repeats here swung 66 to 101 s on the SAME arm while the load
//    average moved between 3.7 and 8; the CPU time for that work does not move
//    with someone else's.
//  - **Per-rule time comes from `durationUs`, never `durationMs`.** The profiler
//    rounds `durationMs` to whole milliseconds, and a page rule runs once per page
//    — thousands of sub-millisecond samples sum to zero and a rule that crosses
//    1 ms on heavy pages jumps a whole unit. Invocation COUNTS are exact either
//    way, and are the honest measure of what the fan-out removed.
//  - **The corpus is a real crawl.** The synthetic bench sites are generated from
//    1-6 templates, so every page is a cluster member and the saving comes out
//    flattering and wrong (#1026). A synthetic corpus is worth measuring only as
//    the "everything is one template" ceiling, clearly labelled as such.
//
// `--verify` is the other half and is not a timing run: it runs both arms in ONE
// process over the same crawl and compares the complete per-page check lists, the
// per-rule results and the folded tallies. That is the byte-identity claim checked
// against a real corpus rather than against an authored fixture — the CI gates
// (`template-fanout-equivalence-golden.test.ts`,
// `template-fanout-parity-golden.test.ts`) only ever see the pages they contain.

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { SiteData } from "@squirrelscan/rules";

import { streamPageRules } from "@squirrelscan/audit-engine";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner } from "@squirrelscan/rules";
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
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const DB = arg("db", "");
if (!DB) {
  console.error(
    "usage: bun run scripts/template-fanout-bench.ts --db <project.db> [--repeat 3] [--verify] [--profile] [--batch 200]"
  );
  process.exit(1);
}
// Validated as TEXT before conversion: `parseInt` turns "1.5" into 1 and "1e3"
// into 1, both of which pass an is-integer check afterwards. A non-positive batch
// makes storage omit its LIMIT and never advance the offset (see the invariance
// script's note) — an infinite read of the whole crawl.
function positiveInt(name: string, fallback: string): number {
  const raw = arg(name, fallback);
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) {
    console.error(
      `--${name} must be a positive integer, got ${JSON.stringify(raw)}`
    );
    process.exit(1);
  }
  return Number.parseInt(raw, 10);
}
const REPEATS = positiveInt("repeat", "3");
const BATCH = positiveInt("batch", "200");

/**
 * Open a DISPOSABLE COPY. `SQLiteStorage.init()` opens the file writable,
 * switches it to WAL and runs migrations, so pointing it at a corpus would
 * silently upgrade someone's crawl — and a mistyped path would create an empty
 * database instead of failing. The -wal/-shm sidecars come too, or the copy is
 * missing committed pages.
 */
function copyCorpus(source: string): { dir: string; db: string } {
  if (!existsSync(source)) {
    console.error(`no such database: ${source}`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "squirrel-fanout-bench-"));
  const db = join(dir, "probe.db");
  copyFileSync(source, db);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, db + suffix);
  }
  return { dir, db };
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["*"] },
} as unknown as Parameters<typeof createRunner>[0];

async function openCrawl(db: string) {
  const storage = new SQLiteStorage(db, getGlobalContentStore());
  await run(storage.init());
  const wanted = arg("crawl", "");
  const crawls = (await run(storage.listCrawls(50))) as Array<{
    id: string;
    baseUrl?: string;
  }>;
  const crawl = wanted ? crawls.find((c) => c.id === wanted) : crawls[0];
  if (!crawl) {
    console.error("no crawls in this db");
    process.exit(1);
  }
  // Page rules read only the non-`pages` fields of SiteData, so this is the same
  // context both arms get and it costs no fetch.
  const siteData: SiteData = {
    baseUrl: crawl.baseUrl ?? "",
    pages: [],
    robotsTxt: null,
    sitemaps: null,
  };
  return { storage, crawlId: crawl.id, siteData };
}

// ── child: one measurement ───────────────────────────────────────────────────

if (flag("child")) {
  const fanout = arg("arm", "on") === "on";
  // The parent hands the child the disposable COPY as --db, so the child never
  // opens the corpus it was pointed at.
  const { storage, crawlId, siteData } = await openCrawl(DB);
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const result = await run(
    streamPageRules(storage, crawlId, createRunner(CONFIG), siteData, {
      batchSize: BATCH,
      templateFanout: fanout,
    })
  );
  // Wall time on a box running other work is mostly a measurement of the other
  // work: five repeats of the SAME arm swung 66 to 101 s here while the load
  // average moved between 3.7 and 8. CPU time for the same work does not, so both
  // are reported and the CPU column is the one to read on a busy machine.
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const ms = performance.now() - started;
  await run(storage.close());
  console.log(
    `CHILD ${JSON.stringify({
      ms,
      cpuMs,
      pages: result.pageUrls.length,
      clusters: result.templateFanout.clusters,
      fannedPages: result.templateFanout.fannedPages,
      fannedRuleRuns: result.templateFanout.fannedRuleRuns,
    })}`
  );
  process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────────────

const corpus = copyCorpus(DB);
let exitCode = 0;
try {
  // Warm the COPY before anything is timed. `init()` runs migrations and switches
  // the file to WAL, and the pass itself upserts a page_features row per page — so
  // an unwarmed first run pays for a migration and for INSERTs where every later
  // run pays for UPDATEs. Whichever arm went first would carry that, and it is
  // exactly the arm this change is supposed to beat.
  {
    const warm = await openCrawl(corpus.db);
    await run(
      streamPageRules(
        warm.storage,
        warm.crawlId,
        createRunner(CONFIG),
        warm.siteData,
        {
          batchSize: BATCH,
          templateFanout: false,
        }
      )
    );
    await run(warm.storage.close());
  }

  if (flag("verify")) {
    // Not a timing run: one process, both arms, complete comparison.
    const { storage, crawlId, siteData } = await openCrawl(corpus.db);
    const plain = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData, {
        batchSize: BATCH,
        templateFanout: false,
      })
    );
    const fanned = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData, {
        batchSize: BATCH,
        templateFanout: true,
      })
    );
    await run(storage.close());

    const canon = (checks: readonly CheckResult[]): string =>
      JSON.stringify(checks);
    let compared = 0;
    const differing: string[] = [];
    if (plain.pageResults.size !== fanned.pageResults.size) {
      differing.push(
        `page count ${plain.pageResults.size} vs ${fanned.pageResults.size}`
      );
    }
    for (const [url, checks] of plain.pageResults) {
      const other = fanned.pageResults.get(url);
      compared++;
      if (!other || canon(other) !== canon(checks)) differing.push(url);
    }
    for (const [ruleId, rr] of plain.ruleResultsMap) {
      const other = fanned.ruleResultsMap.get(ruleId);
      if (!other || canon(other.checks) !== canon(rr.checks))
        differing.push(`rule ${ruleId}`);
    }
    for (const [ruleId, rt] of plain.tallies) {
      const other = fanned.tallies.get(ruleId);
      if (JSON.stringify(other?.tally) !== JSON.stringify(rt.tally)) {
        differing.push(`tally ${ruleId}`);
      }
    }

    console.log(`db          ${DB}`);
    console.log(`pages       ${compared} compared`);
    console.log(`clusters    ${fanned.templateFanout.clusters}`);
    console.log(
      `fanned      ${fanned.templateFanout.fannedPages} pages, ${fanned.templateFanout.fannedRuleRuns} rule runs removed`
    );
    if (differing.length > 0) {
      console.log("");
      console.log(`FAIL        ${differing.length} differences, first 10:`);
      for (const d of differing.slice(0, 10)) console.log(`  ${d}`);
      exitCode = 2;
    } else if (fanned.templateFanout.fannedPages === 0) {
      // A run where nothing was fanned out proves nothing, the same way a corpus
      // of one template makes every rule look invariant.
      console.log("");
      console.log("INCONCLUSIVE  no page inherited a verdict on this corpus");
      exitCode = 3;
    } else {
      console.log("");
      console.log("PASS        byte-identical with and without fan-out");
    }
  } else {
    // ── timing ─────────────────────────────────────────────────────────────────

    interface Sample {
      ms: number;
      cpuMs: number;
      pages: number;
      clusters: number;
      fannedPages: number;
      fannedRuleRuns: number;
    }
    /** arm -> per-rule summed microseconds and invocation counts. */
    const profiles = new Map<
      string,
      {
        invocations: number;
        us: Map<string, number>;
        calls: Map<string, number>;
      }
    >();

    function child(arm: "on" | "off"): Sample | null {
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          "run",
          import.meta.path,
          "--child",
          "--arm",
          arm,
          "--db",
          corpus.db,
          "--batch",
          String(BATCH),
          ...(arg("crawl", "") ? ["--crawl", arg("crawl", "")] : []),
        ],
        // Read at module load in the rules logger, so it has to be in the child's
        // environment rather than a flag the child would re-plumb.
        env: flag("profile")
          ? { ...process.env, SQUIRREL_RULE_PROFILE: "1" }
          : process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = proc.stderr?.toString() ?? "";
      if (proc.exitCode !== 0) {
        console.error(
          `  arm ${arm}: exit ${proc.exitCode}\n${stderr.slice(-800)}`
        );
        return null;
      }
      if (flag("profile")) recordProfile(arm, stderr);
      const line = proc.stdout
        .toString()
        .split("\n")
        .find((l) => l.startsWith("CHILD "));
      if (!line) return null;
      const sample = JSON.parse(line.slice(6)) as Sample;
      // A field the child stopped emitting reaches the report as `undefined`,
      // where `.toFixed` throws inside a `console.log` and takes the whole table
      // with it — which is exactly how one run here produced a header and no rows.
      // Fail on the sample instead, naming the field.
      for (const field of ["ms", "cpuMs", "pages"] as const) {
        if (typeof sample[field] !== "number" || Number.isNaN(sample[field])) {
          console.error(`  arm ${arm}: child reported no usable ${field}`);
          return null;
        }
      }
      return sample;
    }

    function recordProfile(arm: string, stderr: string): void {
      const acc = profiles.get(arm) ?? {
        invocations: 0,
        us: new Map<string, number>(),
        calls: new Map<string, number>(),
      };
      for (const line of stderr.split("\n")) {
        if (!line.startsWith("[rule-profile]")) continue;
        try {
          const d = JSON.parse(line.slice(14)) as {
            ruleId: string;
            pageUrl?: string;
            durationUs?: number;
          };
          if (d.pageUrl === undefined) continue; // site rule; this pass runs none
          acc.invocations += 1;
          acc.calls.set(d.ruleId, (acc.calls.get(d.ruleId) ?? 0) + 1);
          // durationUs, NOT durationMs: see the header.
          acc.us.set(
            d.ruleId,
            (acc.us.get(d.ruleId) ?? 0) + (d.durationUs ?? 0)
          );
        } catch {
          // A truncated line at the end of a pipe is not worth failing a run over.
        }
      }
      profiles.set(arm, acc);
    }

    const samples: Record<"on" | "off", Sample[]> = { on: [], off: [] };
    for (let i = 0; i < REPEATS; i++) {
      // Interleaved, and off first on every repeat so neither arm is systematically
      // the one that pays for a cold file cache.
      for (const arm of ["off", "on"] as const) {
        const got = child(arm);
        if (got) samples[arm].push(got);
        process.stderr.write(`\r  repeat ${i + 1}/${REPEATS} ${arm}   `);
      }
    }
    process.stderr.write("\n");

    const median = (xs: number[]): number => {
      const s = [...xs].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    };
    // Reported alongside the median because noise on a timing bench ADDS work and
    // never removes it, so the minimum is the closest thing to the cost — the same
    // reading rules-scaling-bench.ts takes. With few repeats on a busy box the
    // median is one sample, and one bad sample moves it: a run here had the arms
    // 5.4% apart on the median and 9.3% apart on the minimum, because a single
    // 106 s sample landed in the middle of three.
    const lowest = (xs: number[]): number => Math.min(...xs);

    if (samples.off.length === 0 || samples.on.length === 0) {
      console.error("no successful runs");
      process.exit(1);
    }
    const pages = samples.off[0]!.pages;
    const offMs = median(samples.off.map((s) => s.ms));
    const onMs = median(samples.on.map((s) => s.ms));
    const offCpu = median(samples.off.map((s) => s.cpuMs));
    const onCpu = median(samples.on.map((s) => s.cpuMs));
    const offCpuMin = lowest(samples.off.map((s) => s.cpuMs));
    const onCpuMin = lowest(samples.on.map((s) => s.cpuMs));
    const offMsMin = lowest(samples.off.map((s) => s.ms));
    const onMsMin = lowest(samples.on.map((s) => s.ms));
    const last = samples.on[samples.on.length - 1]!;

    console.log(`db            ${DB}`);
    console.log(`pages         ${pages}`);
    console.log(
      `clusters      ${last.clusters} (${last.fannedPages} pages inherited a verdict)`
    );
    console.log(`rule runs     ${last.fannedRuleRuns} removed`);
    console.log(`repeats       ${REPEATS} interleaved, median reported`);
    console.log("");
    console.log("              wall ms   wall ms/page    cpu ms   cpu ms/page");
    console.log(
      `fan-out off ${offMs.toFixed(0).padStart(9)} ${(offMs / pages).toFixed(2).padStart(13)} ${offCpu.toFixed(0).padStart(9)} ${(offCpu / pages).toFixed(2).padStart(13)}`
    );
    console.log(
      `fan-out on  ${onMs.toFixed(0).padStart(9)} ${(onMs / pages).toFixed(2).padStart(13)} ${onCpu.toFixed(0).padStart(9)} ${(onCpu / pages).toFixed(2).padStart(13)}`
    );
    console.log(
      `delta       ${(((offMs - onMs) / offMs) * 100).toFixed(1).padStart(8)}% ${"".padStart(13)} ${(((offCpu - onCpu) / offCpu) * 100).toFixed(1).padStart(8)}%`
    );
    console.log("");
    console.log("minimum of the repeats — read this one on a busy box");
    console.log(
      `fan-out off ${offMsMin.toFixed(0).padStart(9)} ${(offMsMin / pages).toFixed(2).padStart(13)} ${offCpuMin.toFixed(0).padStart(9)} ${(offCpuMin / pages).toFixed(2).padStart(13)}`
    );
    console.log(
      `fan-out on  ${onMsMin.toFixed(0).padStart(9)} ${(onMsMin / pages).toFixed(2).padStart(13)} ${onCpuMin.toFixed(0).padStart(9)} ${(onCpuMin / pages).toFixed(2).padStart(13)}`
    );
    console.log(
      `delta       ${(((offMsMin - onMsMin) / offMsMin) * 100).toFixed(1).padStart(8)}% ${"".padStart(13)} ${(((offCpuMin - onCpuMin) / offCpuMin) * 100).toFixed(1).padStart(8)}%`
    );
    console.log("");
    console.log(
      `wall samples  off ${samples.off.map((s) => s.ms.toFixed(0)).join(", ")}`
    );
    console.log(
      `              on  ${samples.on.map((s) => s.ms.toFixed(0)).join(", ")}`
    );
    console.log(
      `cpu samples   off ${samples.off.map((s) => s.cpuMs.toFixed(0)).join(", ")}`
    );
    console.log(
      `              on  ${samples.on.map((s) => s.cpuMs.toFixed(0)).join(", ")}`
    );

    if (flag("profile")) {
      const off = profiles.get("off");
      const on = profiles.get("on");
      if (off && on) {
        console.log("");
        console.log(
          `invocations   off ${off.invocations}   on ${on.invocations}`
        );
        console.log("");
        console.log(
          "rule                              calls    off ms    on ms     saved"
        );
        // ONLY rules whose invocation count actually fell. Every other rule's
        // apparent movement between two profiled runs is noise, and printing it
        // beside a real saving invites reading it as one.
        const rows = [...off.calls.entries()]
          .filter(([id]) => (on.calls.get(id) ?? 0) < (off.calls.get(id) ?? 0))
          .map(([id, calls]) => ({
            id,
            calls: `${calls}\u2192${on.calls.get(id) ?? 0}`,
            off: (off.us.get(id) ?? 0) / 1000,
            on: (on.us.get(id) ?? 0) / 1000,
          }))
          .sort((a, b) => b.off - b.on - (a.off - a.on));
        let saved = 0;
        for (const r of rows) {
          saved += r.off - r.on;
          console.log(
            `${r.id.padEnd(30)} ${r.calls.padStart(10)} ${r.off.toFixed(1).padStart(9)} ${r.on.toFixed(1).padStart(8)} ${(r.off - r.on).toFixed(1).padStart(9)}`
          );
        }
        console.log(
          `${"".padEnd(30)} ${"".padStart(10)} ${"".padStart(9)} ${"".padStart(8)} ${saved.toFixed(1).padStart(9)}`
        );
        console.log("");
        console.log(
          "(profiled runs are SLOWER than the timed ones above — the profiler stringifies a line per rule per page. Read these as attribution, not as the headline.)"
        );
      }
    }
  }
} finally {
  // `process.exit` inside the try would skip this and leak the copy — which for
  // a 200 MB corpus is not a small leak. Exit after it instead.
  rmSync(corpus.dir, { recursive: true, force: true });
}
process.exit(exitCode);
