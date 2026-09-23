#!/usr/bin/env bun
/**
 * Keep the public manifests that remain here in line.
 *
 * Version ← apps/cli/package.json, stamped into npm/package.json. Override with
 * --version for one-offs.
 *
 * The agent plugins (Claude Code, Cursor, Agent Plugins) and the skills live in
 * github.com/squirrelscan/skills now and version by commit there, so nothing
 * here stamps them. What is left of them is .claude-plugin/marketplace.json: a
 * redirect that keeps `/plugin marketplace add squirrelscan/squirrelscan` users
 * on the plugin by pointing its entry at squirrelscan/skills. Both modes fail if
 * that redirect stops pointing there, or gains a local path or a pinned version.
 *
 * server.json is deliberately NOT synced. It tracks its own 1.0.x cadence
 * because the MCP registry can reject a backwards version jump, so stamping the
 * CLI version into it would break publishing. Do not add it to `edits` below.
 *
 *   bun run scripts/sync-plugin-manifests.ts            # stamp + write
 *   bun run scripts/sync-plugin-manifests.ts --check    # no writes, exit 1 on drift
 *   bun run scripts/sync-plugin-manifests.ts --version 0.0.79
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC = ROOT;
const CLI_PKG = join(ROOT, "apps/cli/package.json");

const args = process.argv.slice(2);
const check = args.includes("--check");
const versionFlag = args.indexOf("--version");
const versionOverride = versionFlag !== -1 ? args[versionFlag + 1] : undefined;

// Compare release versions by x.y.z only. Pre-release suffixes (-beta.n) are
// intentionally ignored: the downgrade guard exists to catch a stale numeric
// checkout, not to order stable vs pre-release. Returns <0, 0, >0.
function cmpVersion(a: string, b: string): number {
  const base = (v: string) => v.replace(/-(beta|alpha)(\.\d+)?$/, "");
  const pa = base(a).split(".").map(Number);
  const pb = base(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function readJson<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

// repo-public has no formatter; its manifests hand-author primitive arrays
// (keywords, tags) inline. Re-collapse them so a value change is a 1-line diff,
// not an array-explosion. Only arrays free of nested {}/[] are collapsed.
function serialize(obj: unknown): string {
  const pretty = JSON.stringify(obj, null, 2);
  const collapsed = pretty.replace(/\[\n\s+([^[\]{}]+?)\n\s+\]/g, (_m, inner: string) => {
    const items = inner.split(/,\n\s+/).map((s) => s.trim());
    return `[${items.join(", ")}]`;
  });
  return collapsed + "\n";
}

// The old marketplace must keep redirecting. A relative source would point at
// files that no longer exist here, and a version would pin every existing
// install to whatever commit it named.
async function redirectProblems(): Promise<string[]> {
  const rel = ".claude-plugin/marketplace.json";
  const marketplace = await readJson<Record<string, any>>(join(PUBLIC, rel));
  const entry = marketplace.plugins?.find((p: { name?: string }) => p.name === "squirrelscan");
  const source = entry?.source;
  const problems: string[] = [];
  if (source?.source !== "github" || source?.repo !== "squirrelscan/skills") {
    problems.push(`${rel}: the squirrelscan entry must be {"source": "github", "repo": "squirrelscan/skills"}`);
  }
  if (entry && ("version" in entry || "ref" in (source ?? {}) || "sha" in (source ?? {}))) {
    problems.push(`${rel}: the squirrelscan entry must not pin a version, ref or sha`);
  }
  return problems;
}

async function main() {
  const version = versionOverride ?? (await readJson(CLI_PKG)).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Refusing to sync a non-release version: ${String(version)}`);
  }

  // Guard against stamping below what npm already ships (a stale checkout).
  const publicPkg = await readJson(join(PUBLIC, "npm/package.json"));
  const shipped = publicPkg.version as string;
  if (!versionOverride && cmpVersion(version, shipped) < 0) {
    throw new Error(
      `apps/cli version ${version} is below published ${shipped} — checkout looks stale. ` +
        `Pull main, or pass --version explicitly.`,
    );
  }

  const broken = await redirectProblems();
  if (broken.length) {
    console.error(broken.join("\n"));
    process.exit(1);
  }

  // path → mutator. Each returns true if it changed anything.
  const edits: Array<[string, (o: Record<string, any>) => boolean]> = [
    ["npm/package.json", (o) => setField(o, "version", version)],
  ];

  const drift: string[] = [];
  for (const [rel, mutate] of edits) {
    const path = join(PUBLIC, rel);
    if (!(await Bun.file(path).exists())) continue;
    const obj = await readJson(path);
    if (!mutate(obj)) continue;
    drift.push(rel);
    if (!check) await Bun.write(path, serialize(obj));
  }

  if (check) {
    if (drift.length) {
      console.error(`Manifests out of sync (version ${version}):\n  ${drift.join("\n  ")}`);
      console.error("Run: bun run scripts/sync-plugin-manifests.ts");
      process.exit(1);
    }
    console.log(`Manifests in sync (version ${version}); marketplace redirects to squirrelscan/skills.`);
    return;
  }

  console.log(
    drift.length
      ? `Synced to version ${version}:\n  ${drift.join("\n  ")}`
      : `Already in sync (version ${version}).`,
  );
}

// Set a top-level field; return true if it changed. Order-preserving for
// existing keys; appends when the key is new.
function setField(obj: Record<string, unknown>, key: string, value: unknown): boolean {
  if (obj[key] === value) return false;
  obj[key] = value;
  return true;
}

await main();
