// Content-language detector benchmark (squirrelscan/repo#2360). Usage:
//   bun benchmarks/harness/content-language.ts <corpus-dir> [--out=report.json]
//     [--table] [--target=0.95] [--detector=<module>]...
//
// Reads a labelled corpus from <corpus-dir> (no path is baked in; see
// loadLanguageCorpus in packages/parser/src/language/benchmark.ts for the two
// layouts) and runs every detector RAW, without the production floor, so the
// floor can be chosen from the results. Built in: `franc` (the production
// detector's language list) and `franc-all` (all 187 franc languages).
// `--detector=<module>` adds a candidate: a module whose default export is a
// LanguageDetector or a function returning one (e.g. an eld or tinyld adapter
// installed only where the corpus lives).
//
// PRIVACY: the output is aggregate-only (counts, rates, latencies, language
// codes). It never carries page text, URLs, hosts, file names or per-sample
// labels, so it can be pasted into a public PR from a private corpus.

import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LanguageDetector } from "../../packages/parser/src/language";
import { createFrancDetector, FRANC_WEB_LANGUAGES } from "../../packages/parser/src/language";
import {
  formatBenchmarkTable,
  loadLanguageCorpus,
  runLanguageBenchmark,
  type CorpusLoadStats,
} from "../../packages/parser/src/language/benchmark";

const USAGE =
  "usage: bun benchmarks/harness/content-language.ts <corpus-dir> [--out=report.json] [--table] [--target=0.95] [--detector=<module>]...";

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const corpusDir = positional[0];
if (!corpusDir || positional.length > 1) fail("expected exactly one corpus directory");
if (!existsSync(corpusDir) || !statSync(corpusDir).isDirectory()) fail("corpus directory not found");

const target = flag("target") === undefined ? 0.95 : Number(flag("target"));
if (!(target > 0 && target <= 1)) fail("--target must be in (0, 1]");

const detectors: LanguageDetector[] = [
  createFrancDetector({ only: FRANC_WEB_LANGUAGES }),
  createFrancDetector(),
];
for (const spec of args.filter((a) => a.startsWith("--detector=")).map((a) => a.slice(11))) {
  const mod = (await import(resolve(spec))) as { default?: unknown };
  const exported = typeof mod.default === "function" ? (mod.default as () => unknown)() : mod.default;
  const candidate = exported as Partial<LanguageDetector> | undefined;
  if (!candidate || typeof candidate.id !== "string" || typeof candidate.detectLanguage !== "function") {
    fail("a --detector module must default-export a LanguageDetector or a function returning one");
  }
  detectors.push(candidate as LanguageDetector);
}

const stats: CorpusLoadStats = { unreadable: 0 };
const report = runLanguageBenchmark(loadLanguageCorpus(corpusDir, stats), detectors, {
  targetPrecision: target,
});
const output = { ...report, skipped: report.skipped + stats.unreadable };

const json = `${JSON.stringify(output, null, 2)}\n`;
const out = flag("out");
if (out) writeFileSync(out, json);
if (args.includes("--table")) process.stdout.write(formatBenchmarkTable(output));
else if (!out) process.stdout.write(json);
