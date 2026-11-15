// Refresh cross-site rule prevalence (repo#2491) from a stored corpus run.
//
//   bun run scripts/rule-prevalence.ts --reports <dir of JSON reports> [--out <file>] [--check]
//
// <dir> holds one `squirrel report --format json` (or `audit --format json`)
// file per site. Prevalence of a rule is the share of sites whose report lists
// at least one finding for it. Writes packages/report/src/rule-prevalence.json,
// keeping the existing `kept` reasons. Rules above the near-universal threshold
// that have no `kept` reason are printed, so a re-run after rule fixes shows
// what is still unexplained; `--check` exits 1 when any exist. No network.

import { NEAR_UNIVERSAL_PREVALENCE, type RulePrevalenceData } from "@squirrelscan/report";
import { Glob } from "bun";
import { join, resolve } from "node:path";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const dir = arg("reports");
if (!dir) {
  console.error("usage: bun run scripts/rule-prevalence.ts --reports <dir> [--out <file>] [--check]");
  process.exit(2);
}
const out = resolve(
  arg("out") ?? join(import.meta.dir, "../../../packages/report/src/rule-prevalence.json"),
);

const counts = new Map<string, number>();
let sites = 0;
for (const file of new Glob("*.json").scanSync({ cwd: dir, absolute: true })) {
  const report = (await Bun.file(file).json()) as { issues?: Array<{ ruleId?: string }> };
  if (!Array.isArray(report.issues)) continue;
  sites++;
  for (const id of new Set(report.issues.map((i) => i.ruleId).filter((id): id is string => !!id))) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
}
if (sites === 0) {
  console.error(`no JSON reports with an issues list found in ${dir}`);
  process.exit(2);
}

const previous = (await Bun.file(out).exists())
  ? ((await Bun.file(out).json()) as RulePrevalenceData)
  : undefined;
const kept = previous?.kept ?? {};
const prevalence: Record<string, number> = {};
for (const id of [...counts.keys()].sort()) {
  prevalence[id] = Math.round(((counts.get(id) ?? 0) / sites) * 1000) / 1000;
}
const data: RulePrevalenceData = {
  generatedAt: new Date().toISOString().slice(0, 10),
  sites,
  prevalence,
  kept,
};
await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);

const unexplained = Object.entries(prevalence).filter(
  ([id, p]) => p > NEAR_UNIVERSAL_PREVALENCE && !kept[id],
);
console.log(`${sites} sites, ${counts.size} rules, wrote ${out}`);
for (const [id, p] of unexplained) console.log(`above ${NEAR_UNIVERSAL_PREVALENCE * 100}% with no kept reason: ${id} (${p})`);
if (arg("check") !== undefined || process.argv.includes("--check")) {
  if (unexplained.length > 0) process.exit(1);
}
