#!/usr/bin/env bun
/**
 * Split the whole-tree unit test run into named CI suites (#1670).
 *
 * CI's "CLI tests" job used to be a single bare `bun test`. Bare `bun test` walks
 * the WHOLE tree, so packages/* were already gating every PR — but under a job
 * called "CLI tests", with one 400-file log, so nobody could tell. This module is
 * the single source of truth for the split: ci.yml runs one `--run <suite>` step
 * per suite, and a red step names the package.
 *
 * `rest` is the COMPLEMENT of the named suites, computed from the tree rather than
 * hand-kept, so a new package is covered the day it lands. `--check` (run in the
 * quality job) fails if a test file escapes every suite, if two suites would run
 * the same file, if a named suite has gone stale, or if ci.yml stops running one
 * of them.
 *
 * Note `bun run test` is apps/cli ONLY — it is not, and must not become, the CI
 * entry point.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = join(repoRoot, ".github/workflows/ci.yml");

// Suites that get their own step, so a red step names the package. ci.yml orders
// the steps cheapest-first; this order only shapes --list and error messages.
const NAMED_SUITES: { name: string; roots: string[] }[] = [
  { name: "audit-engine", roots: ["packages/audit-engine"] },
  { name: "crawler", roots: ["packages/crawler"] },
  { name: "cli", roots: ["apps/cli"] },
  { name: "rules", roots: ["packages/rules"] },
  { name: "report", roots: ["packages/report"] },
];
const REST_SUITE = "rest";

// Mirrors bun's own test-file convention: *.test.* / *.spec.* / *_test.* / *_spec.*
// with a js/ts extension. Case-insensitive because bun's discovery is: it runs
// `Cloudflare.Test.ts`, so a case-sensitive regex here would hide a real file.
export const TEST_FILE = /(?:\.|_)(?:test|spec)\.(?:m|c)?[jt]sx?$/i;

// bun never descends into dot-directories, so a test file under one cannot run
// and must not be counted as covered.
const HIDDEN_PATH = /(?:^|\/)\./;

/** Every tracked test file bun could run, repo-relative. */
export function testFilesIn(tracked: string[]): string[] {
  return tracked.filter((f) => f !== "" && TEST_FILE.test(f) && !HIDDEN_PATH.test(f));
}

function trackedFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  // -z, so a path with a space or quote arrives verbatim rather than git-quoted.
  return out.stdout.toString().split("\0");
}

/**
 * The directory a test file is attributed to: `apps/<x>` and `packages/<x>` keep
 * their workspace, anything else groups under its top-level directory.
 */
export function suiteRoot(file: string): string {
  const parts = file.split("/");
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? "";
}

/** Resolve every suite against a set of test files. `rest` is the complement. */
export function planSuites(files: string[]): { name: string; roots: string[] }[] {
  const claimed = new Set(NAMED_SUITES.flatMap((s) => s.roots));
  const restRoots = [...new Set(files.map(suiteRoot))].filter((r) => !claimed.has(r)).sort();
  return [...NAMED_SUITES, { name: REST_SUITE, roots: restRoots }];
}

/**
 * How a root is handed to bun. The `./` matters: a bare filter is a path
 * SUBSTRING, so `scripts` also selects `apps/cli/scripts/` and `packages/report`
 * also selects `packages/report-v2`. `./scripts` resolves as a real path instead,
 * which is what makes each file land in exactly one suite.
 */
export function bunFilter(root: string): string {
  return `./${root}`;
}

/** The files `bun test ./<root>` would select. */
export function selectedBy(roots: string[], files: string[]): string[] {
  return files.filter((f) => roots.some((root) => f === root || f.startsWith(`${root}/`)));
}

/** Suite names ci.yml is expected to run. */
export function suiteNames(): string[] {
  return [...NAMED_SUITES.map((s) => s.name), REST_SUITE];
}

/**
 * Suite names ci.yml actually runs, parsed from its `--run <suite>` steps.
 * Comment lines are skipped: a commented-out step runs nothing and must not
 * count as coverage, and the job's own comment block names this script.
 */
export function suitesRunBy(workflowYaml: string): string[] {
  const names: string[] = [];
  for (const line of workflowYaml.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/test-suites\.ts\s+--run\s+([a-z0-9-]+)/);
    if (match) names.push(match[1] as string);
  }
  return names;
}

/**
 * Reasons ci.yml and the tree disagree. Empty means the split is sound: every
 * test file runs in exactly one suite, and ci.yml runs each suite exactly once.
 */
export function checkCoverage(files: string[], workflowYaml: string): string[] {
  const problems: string[] = [];
  const plan = planSuites(files);

  for (const suite of plan) {
    // No roots would make `bun test` run with no filter at all — the whole tree,
    // in a step claiming to be one package.
    if (suite.roots.length === 0) {
      problems.push(`suite "${suite.name}" resolves to no directories`);
      continue;
    }
    // A renamed or deleted package leaves a named suite pointing at nothing. bun
    // exits non-zero on a filter that matches no files, so this would surface as
    // an opaque failure in the test job rather than here.
    for (const root of suite.roots) {
      if (selectedBy([root], files).length === 0) {
        problems.push(`suite "${suite.name}" points at ${root}/, which has no test files`);
      }
    }
  }

  // Two suites running the same file is wasted time rather than lost coverage,
  // but it means the split has stopped being a partition, so treat it as drift.
  const owners = new Map<string, string>();
  for (const suite of plan) {
    for (const file of selectedBy(suite.roots, files)) {
      const owner = owners.get(file);
      if (owner === undefined) owners.set(file, suite.name);
      else problems.push(`suites "${owner}" and "${suite.name}" both run ${file}`);
    }
  }
  for (const file of files) {
    if (!owners.has(file)) problems.push(`no suite runs ${file}`);
  }

  const expected = suiteNames();
  const actual = suitesRunBy(workflowYaml);
  for (const name of expected) {
    const runs = actual.filter((a) => a === name).length;
    if (runs === 0) problems.push(`ci.yml never runs suite "${name}"`);
    else if (runs > 1) problems.push(`ci.yml runs suite "${name}" ${runs} times`);
  }
  for (const name of actual) {
    if (!expected.includes(name)) problems.push(`ci.yml runs unknown suite "${name}"`);
  }
  return problems;
}

async function main(): Promise<number> {
  const [flag, value] = process.argv.slice(2);

  if (flag === "--list") {
    console.log(suiteNames().join("\n"));
    return 0;
  }

  if (flag === "--check") {
    const problems = checkCoverage(testFilesIn(trackedFiles()), await Bun.file(workflow).text());
    if (problems.length === 0) {
      console.log(`test suites cover every test file (${suiteNames().join(", ")})`);
      return 0;
    }
    for (const p of problems) console.error(`error: ${p}`);
    console.error(
      "\nFix scripts/test-suites.ts and the unit test steps in .github/workflows/ci.yml.",
    );
    return 1;
  }

  if (flag === "--run") {
    const suite = planSuites(testFilesIn(trackedFiles())).find((s) => s.name === value);
    if (!suite) {
      console.error(`error: unknown suite "${value}". Known: ${suiteNames().join(", ")}`);
      return 1;
    }
    // Guarded by --check, but re-asserted here: bare `bun test` would silently
    // widen this step to the whole tree.
    if (suite.roots.length === 0) {
      console.error(`error: suite "${value}" resolves to no directories`);
      return 1;
    }
    const filters = suite.roots.map(bunFilter);
    console.log(`bun test ${filters.join(" ")}`);
    const proc = Bun.spawn(["bun", "test", ...filters], {
      cwd: repoRoot,
      stdio: ["inherit", "inherit", "inherit"],
    });
    // `exited`, not `exitCode`: a signal-killed run (an OOM kill, say) reports
    // exitCode null but resolves `exited` to 137, so the step still fails.
    return await proc.exited;
  }

  console.error("usage: bun run scripts/test-suites.ts --list | --check | --run <suite>");
  return 1;
}

if (import.meta.main) process.exit(await main());
