#!/usr/bin/env bun
/**
 * Which workspaces and test suites a diff can affect (#2180).
 *
 * ci.yml's `changes` job pipes the changed paths in (one per line, as for
 * scripts/ci-classify.sh) and writes the output to $GITHUB_OUTPUT:
 *
 *   printf 'packages/rules/src/a.ts\n' | bun run scripts/ci-affected.ts
 *
 * Output, always these three lines in this order:
 *
 *   full=true|false   true: run every workspace and every suite
 *   workspaces=<names> affected workspace package names, space-separated
 *   suites=<names>     test suites to run (scripts/test-suites.ts names)
 *
 * A workspace is affected when it holds a changed file or depends on one that
 * does, transitively. Dependencies are the workspace dependencies in each
 * package.json plus every cross-workspace import found in the tracked source
 * (importEdges), so a test that reaches into a package it does not declare is
 * still selected.
 * Each affected workspace runs the named suite rooted at it, or `rest`.
 *
 * Fail open: `full=true` for an empty diff, for any path outside a known
 * workspace that scripts/ci-classify.sh does not put in the docs set (bun.lock,
 * the root package.json, scripts/, .github/, install.sh, a new top-level file),
 * and for a path under apps/ or packages/ that belongs to no workspace. The docs
 * set itself selects nothing here: the docs job covers it.
 */

import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { suiteForRoot, suiteNames } from "./test-suites.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Workspace {
  name: string;
  dir: string;
  deps: string[];
}

export interface Selection {
  full: boolean;
  workspaces: string[];
  suites: string[];
}

type PackageJson = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** Every workspace declared by the root package.json, with its workspace deps. */
export async function readWorkspaces(root = repoRoot): Promise<Workspace[]> {
  const rootPkg = (await Bun.file(join(root, "package.json")).json()) as PackageJson;
  const patterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);

  const found: { dir: string; pkg: PackageJson }[] = [];
  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      const pkg = (await Bun.file(join(root, file)).json()) as PackageJson;
      found.push({ dir: dirname(file), pkg });
    }
  }

  const names = new Set(found.map((f) => f.pkg.name).filter((n): n is string => !!n));
  return found
    .filter((f) => !!f.pkg.name)
    .map(({ dir, pkg }) => {
      const all = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      };
      // By name, not by the `workspace:` protocol: a workspace pinned by
      // version still resolves to the local copy.
      const deps = Object.keys(all).filter((d) => names.has(d) && d !== pkg.name);
      return { name: pkg.name as string, dir, deps: deps.sort() };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

const SOURCE_FILE = /\.(?:m|c)?[jt]sx?$/;
// A static, dynamic or require import of a relative or @squirrelscan/ path.
const IMPORT_SPEC =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.{1,2}\/[^"']+|@squirrelscan\/[a-z0-9-]+)/g;

/**
 * The workspace edges package.json does not declare, read from the source: a
 * file that imports another workspace by relative path (rules tests import
 * packages/report sources, for one) or by an undeclared package name. Each
 * becomes a dependency edge, so a change to the imported workspace selects
 * the importer. Returns importer name to imported names.
 */
export async function importEdges(
  workspaces: Workspace[],
  root = repoRoot,
): Promise<Map<string, Set<string>>> {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const dirs = workspaces.map((w) => w.dir);
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--", ...dirs], { cwd: root });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);

  const edges = new Map<string, Set<string>>();
  for (const file of out.stdout.toString().split("\0")) {
    if (!SOURCE_FILE.test(file)) continue;
    const from = workspaceOf(file, workspaces);
    if (!from) continue;
    const source = await Bun.file(join(root, file)).text();
    for (const match of source.matchAll(IMPORT_SPEC)) {
      const spec = match[1] as string;
      const to = spec.startsWith(".")
        ? workspaceOf(normalize(join(dirname(file), spec)), workspaces)
        : byName.get(spec);
      if (!to || to.name === from.name || from.deps.includes(to.name)) continue;
      edges.set(from.name, (edges.get(from.name) ?? new Set()).add(to.name));
    }
  }
  return edges;
}

/** The workspaces with their source import edges merged into `deps`. */
export async function workspaceGraph(root = repoRoot): Promise<Workspace[]> {
  const workspaces = await readWorkspaces(root);
  const edges = await importEdges(workspaces, root);
  return workspaces.map((w) => ({
    ...w,
    deps: [...new Set([...w.deps, ...(edges.get(w.name) ?? [])])].sort(),
  }));
}

/** The workspace a path belongs to, by longest directory prefix. */
export function workspaceOf(path: string, workspaces: Workspace[]): Workspace | undefined {
  let best: Workspace | undefined;
  for (const ws of workspaces) {
    if (path.startsWith(`${ws.dir}/`) && (!best || ws.dir.length > best.dir.length)) best = ws;
  }
  return best;
}

/** `names` plus every workspace that depends on one of them, transitively. */
export function withDependents(names: Iterable<string>, workspaces: Workspace[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const ws of workspaces) {
    for (const dep of ws.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), ws.name]);
  }
  const out = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (out.has(name)) continue;
    out.add(name);
    queue.push(...(dependents.get(name) ?? []));
  }
  return out;
}

/** True when scripts/ci-classify.sh puts every path in the docs set. */
export function allDocs(paths: string[]): boolean {
  if (paths.length === 0) return true;
  const out = Bun.spawnSync(["bash", join(repoRoot, "scripts/ci-classify.sh")], {
    stdin: new TextEncoder().encode(`${paths.join("\n")}\n`),
  });
  // A failed classifier is not a docs verdict.
  if (out.exitCode !== 0) return false;
  return out.stdout.toString().split("\n").includes("code=false");
}

/**
 * The selection for a diff. `isDocs` decides the paths outside every workspace;
 * a test can pass its own instead of shelling out to ci-classify.sh.
 */
export function selectAffected(
  changed: string[],
  workspaces: Workspace[],
  isDocs: (paths: string[]) => boolean = allDocs,
): Selection {
  const paths = changed.filter((p) => p !== "");
  if (paths.length === 0) return fullSelection(workspaces);

  const hit = new Set<string>();
  const outside: string[] = [];
  for (const path of paths) {
    const ws = workspaceOf(path, workspaces);
    // docs/ is a workspace, but it is in the docs set and nothing depends on it:
    // let the classifier decide it like any other docs path.
    if (ws && ws.dir !== "docs") hit.add(ws.name);
    else if (/^(apps|packages)\//.test(path)) return fullSelection(workspaces);
    else outside.push(path);
  }
  if (!isDocs(outside)) return fullSelection(workspaces);

  const affected = workspaces.filter((w) => withDependents(hit, workspaces).has(w.name));
  const suites = new Set(affected.map((w) => suiteForRoot(w.dir)));
  return {
    full: false,
    workspaces: affected.map((w) => w.name),
    // In suiteNames() order, so the log reads the same way every run.
    suites: suiteNames().filter((s) => suites.has(s)),
  };
}

function fullSelection(workspaces: Workspace[]): Selection {
  return { full: true, workspaces: workspaces.map((w) => w.name), suites: suiteNames() };
}

export function formatSelection(s: Selection): string {
  return `full=${s.full}\nworkspaces=${s.workspaces.join(" ")}\nsuites=${s.suites.join(" ")}\n`;
}

async function main(): Promise<number> {
  const input = await Bun.stdin.text();
  const selection = selectAffected(input.split("\n"), await workspaceGraph());
  process.stdout.write(formatSelection(selection));
  return 0;
}

if (import.meta.main) process.exit(await main());
