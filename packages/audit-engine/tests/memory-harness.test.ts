// v1 engine memory harness (#1021/#1022, blueprint §5) — documents TODAY's
// memory wall at 5k/25k synthetic pages, the "before" number the streaming
// engine (E-E) is being built to fix. Not a correctness test: it just runs
// the real v1 pipeline (packages/audit-engine's own runV1Pipeline — the same
// wiring golden-baseline.test.ts uses) over a large synthetic crawl DB and
// samples RSS at phase boundaries + periodically during the rules loop (via
// PageRuleLoopHooks.onProgress — the SAME hook cloud-runner.ts uses for its
// own mid-rules RSS sampling, #1252) to find the peak.
//
// SKIPPED BY DEFAULT — heavy (minutes), and the 25k case may legitimately
// OOM the test process (that IS the point: it's supposed to document the
// wall, not stay under it). packages/*/tests aren't in CI's test matrix
// regardless (apps/{cli,api,crawler-worker,dashboard} only), so this file
// never runs unattended even without the extra guard — the guard exists so
// a developer running `bun test` locally in this package doesn't
// accidentally eat 10+ minutes and a possible OOM.
//
// Run explicitly:
//   RUN_MEMORY_HARNESS=1 bun test tests/memory-harness.test.ts
//   RUN_MEMORY_HARNESS=1 MEMORY_HARNESS_25K=1 bun test tests/memory-harness.test.ts  (also attempt 25k)
//
// Each run's samples are flushed to disk incrementally (after every phase
// boundary and every rules-loop heartbeat), not just at the end — so a hard
// crash (OOM kill) still leaves the RSS trajectory up to that point on disk
// instead of losing everything. Report path printed at the end of each case.

import { describe, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { getGoldenBaselineConfig, run, runV1Pipeline } from "./helpers/golden-baseline";

const RUN_MEMORY_HARNESS = process.env.RUN_MEMORY_HARNESS === "1";
const RUN_25K = process.env.MEMORY_HARNESS_25K === "1";

interface RssSample {
  phase: string;
  pagesDone?: number;
  rssMb: number;
  elapsedMs: number;
}

interface MemoryHarnessReport {
  pageCount: number;
  completed: boolean;
  peakRssMb: number;
  healthScoreOverall?: number | null;
  samples: RssSample[];
}

// Only created when the harness actually runs — the describe block below is
// skip-by-default, and there's no point creating (then immediately deleting)
// a temp dir on every normal `bun test` run that never touches it.
const tmpDir = RUN_MEMORY_HARNESS
  ? mkdtempSync(join(tmpdir(), "squirrelscan-memory-harness-"))
  : "";

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function runMemoryHarness(pageCount: number, label: string): Promise<MemoryHarnessReport> {
  const reportPath = join(tmpDir, `${label}-report.json`);
  const dbPath = join(tmpDir, `${label}.sqlite`);
  const startedAt = performance.now();
  const samples: RssSample[] = [];

  const flush = (completed: boolean, healthScoreOverall?: number | null) => {
    const peakRssMb = samples.length > 0 ? Math.max(...samples.map((s) => s.rssMb)) : 0;
    const report: MemoryHarnessReport = {
      pageCount,
      completed,
      peakRssMb,
      healthScoreOverall,
      samples,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return report;
  };

  const sample = (phase: string, pagesDone?: number) => {
    samples.push({
      phase,
      pagesDone,
      rssMb: bytesToMb(process.memoryUsage().rss),
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    // Every ~1000 pages of rules progress (not every heartbeat — avoid I/O
    // becoming the bottleneck) plus every non-rules phase boundary.
    if (phase !== "rules" || (pagesDone ?? 0) % 1000 < 200) flush(false);
  };

  console.log(`[memory-harness] ${label}: generating ${pageCount}-page synthetic model`);
  sample("start");
  const model = generateSiteModel({
    seed: `memory-harness-${label}`,
    pageCount,
    templateCount: 8,
    minPageSizeBytes: 20_000,
    maxPageSizeBytes: 60_000,
    cleanRatio: 0.4,
    issues: {
      longH1: { ratio: 0.05 },
      oversizeTitle: { ratio: 0.05 },
      duplicateTitles: { ratio: 0.02 },
      orphanPages: { ratio: 0.02 },
      brokenLinks: { ratio: 0.03 },
    },
  });
  sample("model-generated");

  console.log(`[memory-harness] ${label}: writing crawl DB to ${dbPath}`);
  const written = await writeCrawlToStorage(model, dbPath);
  const crawlId = written.crawlId;
  await run(written.storage.close());
  sample("db-written", written.pageCount);

  // Fresh connection — matches captureEngineBaseline's own contract (a real
  // crawl and its audit are commonly separate process phases; reopening
  // avoids the writer's own prepared-statement/cache footprint lingering
  // alongside the reader's during the measurement).
  const storage = new SQLiteStorage(dbPath);
  await run(storage.init());
  const config = getGoldenBaselineConfig();

  console.log(`[memory-harness] ${label}: running v1 pipeline`);
  const { report } = await runV1Pipeline(storage, crawlId, config, {
    pageLoopHooks: {
      yieldEveryMs: 50,
      heartbeatEveryPages: Math.max(50, Math.floor(pageCount / 50)),
      onProgress: (done) => sample("rules", done),
    },
    onPhase: (phase) => sample(phase),
  });
  sample("done");
  await run(storage.close());

  const final = flush(true, report.healthScore.overall);
  console.log(
    `[memory-harness] ${label}: peak RSS ${final.peakRssMb}MB over ${samples.length} samples, ` +
      `healthScore=${report.healthScore.overall}, report at ${reportPath}`,
  );
  return final;
}

describe.skipIf(!RUN_MEMORY_HARNESS)(
  "v1 engine memory harness — 5k/25k RSS (skip-by-default)",
  () => {
    // Generous timeout: an earlier run showed severe wall-time degradation as
    // the rules phase progresses (site-wide rules re-scanning ctx.site.pages
    // presumably get costlier as more of the crawl accumulates) — 600s cut it
    // off at ~3100/5000 pages with RSS still moderate (~640MB), so this is
    // genuinely a time wall as much as a memory one. Let it run to completion
    // rather than re-guessing a tighter bound.
    test("5k-page synthetic crawl — peak RSS + phase timings", async () => {
      const result = await runMemoryHarness(5_000, "5k");
      console.log(JSON.stringify(result, null, 2).slice(0, 2000));
    }, 1_800_000);

    test.skipIf(!RUN_25K)(
      "25k-page synthetic crawl — peak RSS (may OOM the process — that documents the wall)",
      async () => {
        const result = await runMemoryHarness(25_000, "25k");
        console.log(JSON.stringify(result, null, 2).slice(0, 2000));
      },
      1_800_000,
    );
  },
);
