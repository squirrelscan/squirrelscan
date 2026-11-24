// Before/after evaluation of component-aware findings (squirrelscan/reporepo#2307).
//
//   bun benchmarks/harness/component-findings-eval.ts [--json <path>] [--repeats <n>]
//
// Runs the real a11y/link-text and content/stale-copyright rules over the
// synthetic case corpus in packages/rules/tests/fixtures/component-eval/, runs
// the real report grouping with and without component evidence, scores the
// result against the corpus's human labels, and prints a markdown table.
// Everything is deterministic except the timing and heap columns. The record is
// ../2026-11-component-findings-eval.md.

import {
  evaluateCase,
  type CaseResult,
  type EvalOrder,
} from "../../packages/rules/tests/component-eval/evaluate";
import { EVAL_CASES } from "../../packages/rules/tests/fixtures/component-eval/cases";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const jsonPath = flag("json");
const repeats = Math.max(1, Number(flag("repeats") ?? 5));
const ORDERS: EvalOrder[] = ["forward", "reversed", "shuffled"];

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir });
  return result.stdout.toString().trim();
}

const mb = (bytes: number) => bytes / 1024 / 1024;

interface Row {
  result: CaseResult;
  heapDeltaMb: number;
  deterministic: boolean;
}

const rows: Row[] = [];
for (const evalCase of EVAL_CASES) {
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  const result = await evaluateCase(evalCase, { order: "forward", repeats });
  Bun.gc(true);
  const heapDeltaMb = mb(process.memoryUsage().heapUsed - before);

  // Ids and membership under the other page orders.
  const shape = (r: CaseResult) =>
    JSON.stringify([r.groups.map((g) => [g.id, g.pages, g.members]), r.rollupSummary]);
  const others = await Promise.all(ORDERS.slice(1).map((order) => evaluateCase(evalCase, { order })));
  const deterministic = others.every((other) => shape(other) === shape(result));
  rows.push({ result, heapDeltaMb, deterministic });
}

const fixed = (n: number, digits = 2) => n.toFixed(digits);
const header = [
  "case",
  "pages",
  "observations",
  "before groups",
  "after groups",
  "rollups",
  "affected pages",
  "incorrect merges",
  "missed merges",
  "rule ms",
  "grouping ms on",
  "grouping ms off",
  "heap delta MB",
];
const lines = [
  `| ${header.join(" | ")} |`,
  `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`,
];
for (const { result, heapDeltaMb } of rows) {
  lines.push(
    `| ${[
      result.id,
      result.pages,
      result.observations,
      result.beforeGroups,
      result.afterGroups,
      result.rollups,
      result.affectedPages,
      result.incorrectMerges,
      result.missedMerges,
      fixed(result.ruleMs),
      fixed(result.groupingMsOn),
      fixed(result.groupingMsOff),
      fixed(heapDeltaMb),
    ].join(" | ")} |`,
  );
}
const sum = (pick: (r: CaseResult) => number) => rows.reduce((total, row) => total + pick(row.result), 0);
lines.push(
  `| **total** | ${sum((r) => r.pages)} | ${sum((r) => r.observations)} | ${sum((r) => r.beforeGroups)} | ${sum((r) => r.afterGroups)} | ${sum((r) => r.rollups)} | ${sum((r) => r.affectedPages)} | ${sum((r) => r.incorrectMerges)} | ${sum((r) => r.missedMerges)} | ${fixed(sum((r) => r.ruleMs))} | ${fixed(sum((r) => r.groupingMsOn))} | ${fixed(sum((r) => r.groupingMsOff))} | ${fixed(rows.reduce((t, r) => t + r.heapDeltaMb, 0))} |`,
);
console.log(lines.join("\n"));
console.log("");
console.log(
  `message grouping unchanged by evidence: ${rows.every((r) => r.result.presentationOnly) ? "all cases" : "NO"}; ` +
    // #2256: shared-component evidence may raise the score (capped density), never lower it.
    `health score never lowered by evidence: ${rows.every((r) => (r.result.healthScoreOn ?? 0) >= (r.result.healthScoreOff ?? 0)) ? "all cases" : "NO"}` +
    ` (raised in ${rows.filter((r) => (r.result.healthScoreOn ?? 0) > (r.result.healthScoreOff ?? 0)).length}); ` +
    `ids and membership identical across forward/reversed/shuffled: ${rows.every((r) => r.deterministic) ? "all cases" : "NO"}; ` +
    `coverage complete: ${rows.every((r) => r.result.coverageOk) ? "all cases" : "NO"}`,
);
console.log(`timings: min of ${repeats} grouping runs per case, one rule run per page`);

if (jsonPath) {
  const payload = {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    bun: Bun.version,
    platform: `${process.platform}/${process.arch}`,
    repeats,
    cases: rows.map(({ result, heapDeltaMb, deterministic }) => ({
      ...result,
      heapDeltaMb,
      deterministicAcrossOrders: deterministic,
    })),
  };
  await Bun.write(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${jsonPath}`);
}
