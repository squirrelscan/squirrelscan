// Per-rule wall-time percentiles over the golden corpus.
//
// The rule time budget (`RULE_TIME_BUDGET_MS` in @squirrelscan/rules) is chosen
// from these numbers: it has to sit far above every rule's p99 on ordinary
// pages, so that it only ever fires on pathological input. Re-run this after a
// change that makes a rule markedly slower, and re-check the budget.
//
// Builds the canonical 500-page golden fixture (the same crawl the golden
// baseline tests use), runs the v1 pipeline over it fully offline with the
// rule profiler on, and prints p50/p99/max per rule, slowest p99 first.
//
// Usage (from packages/audit-engine):
//   SQUIRREL_RULE_PROFILE=1 bun run scripts/rule-time-percentiles.ts [--top 25] [--runs 3]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildGoldenBaselineModel,
  getGoldenBaselineConfig,
  run,
  runV1Pipeline,
} from "../tests/helpers/golden-baseline";

const { values } = parseArgs({
  options: { top: { type: "string", default: "25" }, runs: { type: "string", default: "3" } },
});

if (!process.env.SQUIRREL_RULE_PROFILE) {
  console.error("Set SQUIRREL_RULE_PROFILE=1: the per-rule timings come from the rules profiler.");
  process.exit(1);
}

// The profiler writes one `[rule-profile] {json}` line per rule run to stderr.
const samples = new Map<string, number[]>();
const realError = console.error;
console.error = (...args: unknown[]) => {
  const line = args[0];
  if (typeof line === "string" && line.startsWith("[rule-profile] ")) {
    const d = JSON.parse(line.slice("[rule-profile] ".length)) as { ruleId: string; durationUs: number };
    let list = samples.get(d.ruleId);
    if (!list) samples.set(d.ruleId, (list = []));
    list.push(d.durationUs / 1000);
    return;
  }
  realError(...args);
};

const dir = mkdtempSync(join(tmpdir(), "squirrelscan-rule-time-"));
try {
  const dbPath = join(dir, "golden.sqlite");
  const { storage: writer, crawlId } = await writeCrawlToStorage(buildGoldenBaselineModel(), dbPath);
  await run(writer.close());

  for (let i = 0; i < Number(values.runs); i++) {
    const storage = new SQLiteStorage(dbPath);
    try {
      await run(storage.init());
      await runV1Pipeline(storage, crawlId, getGoldenBaselineConfig());
    } finally {
      await run(storage.close());
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.error = realError;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const rows = [...samples].map(([ruleId, list]) => {
  const s = list.toSorted((a, b) => a - b);
  return { ruleId, n: s.length, p50: pct(s, 50), p99: pct(s, 99), max: s[s.length - 1] };
});
rows.sort((a, b) => b.p99 - a.p99);

const all = [...samples.values()].flat().toSorted((a, b) => a - b);
console.log(`rule runs: ${all.length}, rules: ${rows.length}`);
console.log(`all rules: p50 ${pct(all, 50).toFixed(3)} ms, p99 ${pct(all, 99).toFixed(3)} ms, max ${all[all.length - 1].toFixed(1)} ms`);
console.log("");
console.log("rule".padEnd(44) + "n".padStart(6) + "p50 ms".padStart(10) + "p99 ms".padStart(10) + "max ms".padStart(10));
for (const r of rows.slice(0, Number(values.top))) {
  console.log(
    r.ruleId.padEnd(44) + String(r.n).padStart(6) + r.p50.toFixed(3).padStart(10) + r.p99.toFixed(3).padStart(10) + r.max.toFixed(1).padStart(10),
  );
}
