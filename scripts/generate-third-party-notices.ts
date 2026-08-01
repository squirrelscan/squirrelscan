#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackageNotice {
  name: string;
  version: string;
  license: string;
  source: string;
  noticeHashes: string[];
}

const root = resolve(import.meta.dir, "..");
const workspacePackages = new Map<string, string>();

for (const directory of [join(root, "apps", "cli"), ...new Bun.Glob("packages/*").scanSync(root)]) {
  const absolute = resolve(root, directory);
  const packagePath = join(absolute, "package.json");
  if (!existsSync(packagePath)) continue;
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  if (pkg.name) workspacePackages.set(pkg.name, absolute);
}

function dependencyPackageDirectory(name: string, fromDirectory: string): string | null {
  const workspace = workspacePackages.get(name);
  if (workspace) return workspace;

  let cursor = fromDirectory;
  while (true) {
    const candidate = join(cursor, "node_modules", ...name.split("/"), "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function repositoryUrl(repository: PackageJson["repository"]): string {
  const value = typeof repository === "string" ? repository : repository?.url;
  if (!value) return "";
  const normalized = value
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com[:/]/, "https://github.com/")
    .replace(/^git:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/\.git$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)
    ? `https://github.com/${normalized}`
    : normalized;
}

function hashText(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Versions recorded in bun.lock, keyed by package name.
 *
 * The walk below reads versions off whatever happens to be installed in
 * node_modules, which is local state: a partial or stale install silently
 * yields a different version than the lockfile pins, so the generated notices
 * disagree with a correct repo and `--check` fails for a reason the contributor
 * cannot see (#1410). The lockfile is the authority, so any disagreement is
 * reported as "your install is stale", not as "the notices are wrong".
 */
function lockfileVersions(): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const path = join(root, "bun.lock");
  if (!existsSync(path)) return versions;
  // bun.lock is JSONC: strip trailing commas before parsing.
  const raw = readFileSync(path, "utf8").replace(/,(\s*[}\]])/g, "$1");
  let parsed: { packages?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { packages?: Record<string, unknown> };
  } catch {
    return versions;
  }
  // A name can legitimately appear at several versions — the lockfile records
  // nested resolutions under path keys ("@squirrelscan/config/zod"), so collect
  // every version per name rather than letting the last key win.
  for (const entry of Object.values(parsed.packages ?? {})) {
    const descriptor = Array.isArray(entry) ? entry[0] : entry;
    if (typeof descriptor !== "string") continue;
    // "name@version" / "@scope/name@version" — split on the LAST @.
    const at = descriptor.lastIndexOf("@");
    if (at <= 0) continue;
    const name = descriptor.slice(0, at);
    const version = descriptor.slice(at + 1);
    const existing = versions.get(name);
    if (existing) existing.add(version);
    else versions.set(name, new Set([version]));
  }
  return versions;
}

const lockedVersions = lockfileVersions();
const versionMismatches: string[] = [];

const packages = new Map<string, PackageNotice>();
const noticeTexts = new Map<string, { filename: string; text: string; packages: Set<string> }>();
const visitedDirectories = new Set<string>();

function visit(directory: string): void {
  const realDirectory = realpathSync(directory);
  if (visitedDirectories.has(realDirectory)) return;
  visitedDirectories.add(realDirectory);

  const pkg = JSON.parse(readFileSync(join(realDirectory, "package.json"), "utf8")) as PackageJson;
  const dependencyNames = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);

  if (pkg.name && !pkg.name.startsWith("@squirrelscan/")) {
    const locked = lockedVersions.get(pkg.name);
    if (locked && pkg.version && !locked.has(pkg.version)) {
      versionMismatches.push(
        `${pkg.name}: installed ${pkg.version}, bun.lock has ${[...locked].sort().join(", ")}`,
      );
    }
    const id = `${pkg.name}@${pkg.version ?? "unknown"}`;
    const noticeHashes: string[] = [];
    for (const filename of readdirSync(realDirectory).sort()) {
      if (!/^(licen[cs]e|copying|notice)(\..*)?$/i.test(filename)) continue;
      const path = join(realDirectory, filename);
      let text: string;
      try {
        text = readFileSync(path, "utf8").trim();
      } catch {
        continue;
      }
      if (!text) continue;
      const hash = hashText(text);
      noticeHashes.push(hash);
      const existing = noticeTexts.get(hash);
      if (existing) {
        existing.packages.add(id);
      } else {
        noticeTexts.set(hash, { filename, text, packages: new Set([id]) });
      }
    }

    packages.set(id, {
      name: pkg.name,
      version: pkg.version ?? "unknown",
      license: pkg.license ?? "SEE PACKAGE",
      source: repositoryUrl(pkg.repository),
      noticeHashes,
    });
  }

  for (const name of [...dependencyNames].sort()) {
    const dependencyDirectory = dependencyPackageDirectory(name, realDirectory);
    if (dependencyDirectory) visit(dependencyDirectory);
  }
}

visit(join(root, "apps", "cli"));

const lines = [
  "# Third-Party Notices",
  "",
  "The squirrelscan CLI distribution includes the following third-party software.",
  "This file is generated by `scripts/generate-third-party-notices.ts` from the",
  "runtime dependency closure of `apps/cli`.",
  "",
  "## Package Inventory",
  "",
  "| Package | License | Source |",
  "| --- | --- | --- |",
];

for (const notice of [...packages.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
)) {
  const source = notice.source ? `[source](${notice.source})` : "-";
  lines.push(`| \`${notice.name}@${notice.version}\` | ${notice.license} | ${source} |`);
}

lines.push("", "## License And Notice Texts", "");

for (const [hash, notice] of [...noticeTexts].sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(
    `### ${notice.filename} (${hash.slice(0, 12)})`,
    "",
    `Packages: ${[...notice.packages]
      .sort()
      .map((id) => `\`${id}\``)
      .join(", ")}`,
    "",
    ...notice.text
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+$/, ""))
      .map((line) => (line ? `    ${line}` : "")),
    "",
  );
}

const output = `${lines.join("\n").replace(/\n+$/, "")}\n`;
const targets = [join(root, "THIRD_PARTY_NOTICES.md"), join(root, "npm", "THIRD_PARTY_NOTICES.md")];

// A stale/partial node_modules yields versions the lockfile does not pin, so
// the notices generated from it are wrong no matter what the committed file
// says. Fail on that directly instead of reporting it as out-of-date notices.
if (versionMismatches.length > 0) {
  console.error("Installed dependencies do not match bun.lock:");
  for (const mismatch of versionMismatches.sort()) console.error(`  ${mismatch}`);
  console.error("Run `bun install` and try again.");
  process.exit(1);
}

if (process.argv.includes("--check")) {
  const stale = targets.filter((target) => {
    try {
      return readFileSync(target, "utf8") !== output;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(`Third-party notices are out of date: ${stale.join(", ")}`);
    console.error("Run `bun run notices:generate` and commit the result.");
    process.exit(1);
  }
  console.log(`Third-party notices are up to date (${packages.size} packages).`);
} else {
  for (const target of targets) await Bun.write(target, output);
  console.log(`Wrote notices for ${packages.size} packages (${noticeTexts.size} unique texts).`);
}
