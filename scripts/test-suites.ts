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

import { readFileSync } from "node:fs";
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
 * Suite names ci.yml actually runs. Two shapes count:
 *   - a literal `--run <suite>` step;
 *   - the CLI tests matrix (#2180): its full-run fallback list, the JSON array
 *     in `suite: ${{ fromJSON(... || '[...]') }}`, counts only when a step
 *     also runs `--run "${SUITE}"` or `--run ${{ matrix.suite }}`. The
 *     fallback is what runs on main, on an unknown base and when the changes
 *     job failed, so it must name every suite.
 * Comment lines are skipped: a commented-out step runs nothing and must not
 * count as coverage, and the job's own comment block names this script.
 */
export function suitesRunBy(workflowYaml: string): string[] {
  const names: string[] = [];
  const matrix: string[] = [];
  let matrixStep = false;
  for (const line of workflowYaml.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const fallback = line.match(
      /^\s*suite:\s*\$\{\{\s*fromJSON\(.*\|\|\s*'(\[[^']*\])'\s*\)\s*\}\}/,
    );
    if (fallback) {
      const parsed: unknown = JSON.parse(fallback[1] as string);
      if (Array.isArray(parsed)) matrix.push(...parsed.map(String));
      continue;
    }
    if (
      /test-suites\.ts\s+--run\s+(?:"\$\{SUITE\}"|"\$SUITE"|\$\{\{\s*matrix\.suite\s*\}\})/.test(
        line,
      )
    ) {
      matrixStep = true;
      continue;
    }
    const match = line.match(/test-suites\.ts\s+--run\s+([a-z0-9-]+)/);
    if (match) names.push(match[1] as string);
  }
  return matrixStep ? [...names, ...matrix] : names;
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

// ---------------------------------------------------------------------------
// Diff selection (#2180): which workspaces and suites a change reaches.
//
// ci-classify.sh decides whether the selection is FULL (any path outside
// apps/*, packages/* and the docs set, or an unknown base). Otherwise it pipes
// the apps/* and packages/* paths to `--select`, which maps them here:
//   - a workspace is affected when it holds a changed file or depends on one
//     (any `workspace:` dependency, dev and peer included), transitively;
//   - each affected workspace selects the named suite rooted at it, or `rest`.
// A path in no known workspace (a deleted or brand-new package) fails open to
// the full selection, as an unknown path does in ci-classify.sh.
// ---------------------------------------------------------------------------

export interface Workspace {
  dir: string;
  name: string;
  /** Names of the workspace packages this one depends on via `workspace:`. */
  deps: string[];
}

export interface Selection {
  workspaces: string[];
  suites: string[];
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Every workspace the root package.json declares, with its `workspace:` deps. */
export function readWorkspaces(root: string = repoRoot): Workspace[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const found: Workspace[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const rel of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const pkg = JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;
      const deps = new Set<string>();
      for (const field of DEP_FIELDS) {
        const table = pkg[field];
        if (!table || typeof table !== "object") continue;
        for (const [dep, spec] of Object.entries(table as Record<string, unknown>)) {
          if (typeof spec === "string" && spec.startsWith("workspace:")) deps.add(dep);
        }
      }
      found.push({ dir: dirname(rel), name: String(pkg.name ?? dirname(rel)), deps: [...deps] });
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The workspace dir a path belongs to: `apps/<x>` or `packages/<x>`, else null. */
export function workspaceOf(path: string): string | null {
  const parts = path.split("/");
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length > 2 && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

/** The suite that owns a workspace's test files. */
export function suiteForWorkspace(dir: string): string {
  return NAMED_SUITES.find((s) => s.roots.includes(dir))?.name ?? REST_SUITE;
}

/** The selection that runs everything. */
export function fullSelection(workspaces: Workspace[]): Selection {
  return { workspaces: workspaces.map((w) => w.dir), suites: suiteNames() };
}

/**
 * Affected workspaces and suites for a list of changed paths. Paths outside
 * apps/* and packages/* are ignored (ci-classify.sh has already routed them);
 * a path in an apps/ or packages/ dir that is not a workspace runs everything.
 */
export function selectFor(paths: string[], workspaces: Workspace[]): Selection {
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const dependents = new Map<string, string[]>();
  for (const w of workspaces) {
    for (const dep of w.deps) {
      const list = dependents.get(dep) ?? [];
      list.push(w.dir);
      dependents.set(dep, list);
    }
  }

  const affected = new Set<string>();
  const queue: string[] = [];
  for (const path of paths) {
    if (path === "") continue;
    const dir = workspaceOf(path);
    if (dir === null) continue;
    if (!byDir.has(dir)) return fullSelection(workspaces);
    if (!affected.has(dir)) {
      affected.add(dir);
      queue.push(dir);
    }
  }
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const name = (byDir.get(dir) as Workspace).name;
    for (const dependent of dependents.get(name) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const dirs = workspaces.map((w) => w.dir).filter((d) => affected.has(d));
  const wanted = new Set(dirs.map(suiteForWorkspace));
  return { workspaces: dirs, suites: suiteNames().filter((s) => wanted.has(s)) };
}

/** `workspaces=<json>` and `suites=<json>`, the lines ci-classify.sh appends. */
export function formatSelection(sel: Selection): string {
  return `workspaces=${JSON.stringify(sel.workspaces)}\nsuites=${JSON.stringify(sel.suites)}`;
}

async function main(): Promise<number> {
  const [flag, value] = process.argv.slice(2);

  if (flag === "--list") {
    console.log(suiteNames().join("\n"));
    return 0;
  }

  // Reads changed paths (one per line) on stdin. `--select-all` ignores stdin.
  if (flag === "--select" || flag === "--select-all") {
    const workspaces = readWorkspaces();
    const sel =
      flag === "--select-all"
        ? fullSelection(workspaces)
        : selectFor((await Bun.stdin.text()).split("\n"), workspaces);
    console.log(formatSelection(sel));
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

  console.error(
    "usage: bun run scripts/test-suites.ts --list | --check | --run <suite> | --select | --select-all",
  );
  return 1;
}

if (import.meta.main) process.exit(await main());
