#!/usr/bin/env bun
/**
 * Sync the public plugin and npm manifests to one source of truth.
 *
 * Version  ← apps/cli/package.json. Override with --version for one-offs.
 * Description ← plugin.json (the portable Open Plugin manifest is
 *            the canonical plugin metadata; vendor copies fan out from it).
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

  const description = (await readJson(join(PUBLIC, "plugin.json"))).description as string;

  // Canonical MCP transport type lives in mcp.json; .mcp.json must match it.
  const canonicalMcp = await readJson<Record<string, any>>(join(PUBLIC, "mcp.json"));
  const canonicalMcpType = canonicalMcp.mcpServers?.squirrelscan?.type as string | undefined;

  // path → mutator. Each returns true if it changed anything.
  const edits: Array<[string, (o: Record<string, any>) => boolean]> = [
    ["npm/package.json", (o) => setField(o, "version", version)],
    ["plugin.json", (o) => setField(o, "version", version)],
    // Evaluate BOTH mutations (avoid || short-circuit) then OR the results.
    [
      ".cursor-plugin/plugin.json",
      (o) =>
        [setField(o, "version", version), setField(o, "description", description)].some(Boolean),
    ],
    [
      ".claude-plugin/plugin.json",
      (o) =>
        [setField(o, "version", version), setField(o, "description", description)].some(Boolean),
    ],
    [
      ".claude-plugin/marketplace.json",
      (o) => {
        const p = o.plugins?.[0];
        if (!p || p.description === description) return false;
        p.description = description;
        return true;
      },
    ],
    [
      ".mcp.json",
      (o) => {
        const s = o.mcpServers?.squirrelscan;
        if (!s || !canonicalMcpType || s.type === canonicalMcpType) return false;
        // reinsert with type first (canonical value wins) to match mcp.json ordering
        const { type: _oldType, ...rest } = s;
        o.mcpServers.squirrelscan = { type: canonicalMcpType, ...rest };
        return true;
      },
    ],
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
      console.error(`Plugin manifests out of sync (version ${version}):\n  ${drift.join("\n  ")}`);
      console.error("Run: bun run scripts/sync-plugin-manifests.ts");
      process.exit(1);
    }
    console.log(`Plugin manifests in sync (version ${version}).`);
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
