#!/usr/bin/env bun

import { $ } from "bun";
import { inc, rcompare, valid, type ReleaseType } from "semver";
import { createInterface } from "node:readline";

const PACKAGE_JSON = "apps/cli/package.json";

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;

const log = (msg: string) => console.log(`${green("==>")} ${msg}`);
const warn = (msg: string) => console.log(`${yellow("Warning:")} ${msg}`);
const info = (msg: string) => console.log(`${blue("::")} ${msg}`);

const error = (msg: string): never => {
  console.error(`${red("Error:")} ${msg}`);
  process.exit(1);
};

type Channel = "beta" | "stable";
type BumpType = "patch" | "minor" | "major";

interface PackageJson {
  version: string;
  [key: string]: unknown;
}

async function readPackageJson(): Promise<PackageJson> {
  const file = Bun.file(PACKAGE_JSON);
  return (await file.json()) as PackageJson;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function checkPrerequisites(): Promise<void> {
  // Check we're in repo root
  const pkgExists = await Bun.file(PACKAGE_JSON).exists();
  if (!pkgExists) {
    error("Must run from repository root (apps/cli/package.json not found)");
  }

  // Check git status is clean
  const status = await $`git status --porcelain`.text();
  if (status.trim()) {
    error("Working directory not clean. Commit or stash changes first.");
  }

  // Check branch
  const branch = (await $`git branch --show-current`.text()).trim();
  if (branch !== "main") {
    warn(`Not on main branch (currently on: ${branch})`);
    const answer = await prompt("Continue anyway? [y/N] ");
    if (answer.toLowerCase() !== "y") {
      process.exit(1);
    }
  }
}

function isPrerelease(version: string): boolean {
  return version.includes("-beta") || version.includes("-alpha");
}

function getBaseVersion(version: string): string {
  return version.replace(/-(beta|alpha)(\.\d+)?$/, "");
}

// Mirror release.yml's version job so the local preflight greps the same version
// CI will release: `promote` drops the prerelease suffix; only an existing *beta*
// bumps its number (an alpha/release falls through to a fresh semver prerelease,
// matching the workflow's `grep -q "beta"`); stable bumps normally.
export function computeNextVersion(
  current: string,
  channel: Channel,
  bump: BumpType | "promote",
): string {
  if (bump === "promote") return getBaseVersion(current);
  if (channel === "beta") {
    if (current.includes("beta")) {
      const n = Number(current.match(/beta\.(\d+)/)?.[1] ?? 0);
      return `${getBaseVersion(current)}-beta.${n + 1}`;
    }
    return (
      inc(current, `pre${bump}` as ReleaseType, "beta") ??
      error(`Cannot compute beta version from ${current}`)
    );
  }
  return inc(current, bump) ?? error(`Cannot compute version from ${current}`);
}

export function latestTaggedVersion(tags: string[], fallback: string): string {
  const versions = tags
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag): tag is string => valid(tag) !== null)
    .sort(rcompare);
  return versions[0] ?? fallback;
}

export async function resolveCurrentVersion(fallback: string): Promise<string> {
  await $`git fetch --tags --force`.quiet();
  const tags = (await $`git tag --list ${"v*"}`.text()).split(/\r?\n/).filter(Boolean);
  return latestTaggedVersion(tags, fallback);
}

// Preflight (#495): release.yml resolves notes by running the SAME extractor over
// CHANGELOG.md; if the section is missing the release ships a silent minimal body
// AFTER the bump+tag are already pushed to main. Catch it here, before dispatch.
// Tooling failures (missing extractor/CHANGELOG, no awk) skip rather than masquerade
// as a missing section — only a successful-but-empty extraction is a real omission.
async function checkChangelogSection(version: string): Promise<void> {
  const awkFile = "scripts/extract-changelog.awk";
  if (!(await Bun.file(awkFile).exists()) || !(await Bun.file("CHANGELOG.md").exists())) {
    warn("CHANGELOG preflight skipped — extractor or CHANGELOG.md not found.");
    return;
  }
  if (!Bun.which("awk")) {
    warn("CHANGELOG preflight skipped — awk not found.");
    return;
  }
  // A real awk failure (bad script / unreadable file) throws and surfaces via
  // main()'s catch; only a successful-but-empty extraction is a missing section.
  const notes = await $`awk -v ${`v=${version}`} -f ${awkFile} CHANGELOG.md`.text();
  if (notes.trim()) return;
  warn(`No CHANGELOG.md section for v${version} — the release would ship a minimal body.`);
  const answer = await prompt("Dispatch without release notes? [y/N] ");
  if (answer.toLowerCase() !== "y") {
    error(`Aborted — add a "## v${version}" section to CHANGELOG.md and re-run.`);
  }
}

// Every manifest that carries the release version. server.json is deliberately
// absent: it tracks its own 1.0.x cadence because the MCP registry rejects a
// backwards version jump.
export const SYNCED_MANIFESTS = [
  PACKAGE_JSON,
  "npm/package.json",
  "plugin.json",
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
];

// A manifest absent from the checkout is skipped, not treated as drift: the
// vendor copies are optional. A manifest that exists and disagrees is drift,
// so a half-applied bump can never read as "already landed".
export async function manifestsCarry(version: string, root = "."): Promise<boolean> {
  for (const rel of SYNCED_MANIFESTS) {
    const file = Bun.file(`${root}/${rel}`);
    if (!(await file.exists())) continue;
    if ((JSON.parse(await file.text()) as PackageJson).version !== version) return false;
  }
  return true;
}

// The release workflow used to stamp the version itself, commit it on a
// detached checkout and push only the tag — so the bump was reachable from the
// tag and nowhere else, and main sat a full release behind forever (0.0.82
// while v0.0.83 was live). It cannot simply push the branch instead: main is
// covered by a ruleset with an empty bypass list, so CI can neither push to it
// nor open the PR (Actions PR creation is off for this repo). The bump has to
// land the way every other change does, before the tag is cut.
async function ensureVersionLanded(version: string): Promise<void> {
  if (await manifestsCarry(version)) {
    info(`main already carries v${version}.`);
    return;
  }

  console.log();
  warn(`main does not carry v${version} yet — that bump has to merge before the tag is cut.`);

  // A bump PR built on a stale main just gets rejected by the "branch must be
  // up to date" rule, so require the real tip up front.
  await $`git fetch --no-tags origin main`.quiet();
  const head = (await $`git rev-parse HEAD`.text()).trim();
  const tip = (await $`git rev-parse FETCH_HEAD`.text()).trim();
  if (head !== tip) {
    error("HEAD is not at origin/main. Pull main, then re-run.");
  }

  const branch = `release/v${version}`;
  // A leftover branch from an abandoned attempt would make `git switch -c` fail
  // with a message that says nothing about releasing.
  if (
    await $`git rev-parse --verify --quiet ${branch}`
      .quiet()
      .nothrow()
      .then((r) => r.exitCode === 0)
  ) {
    error(`Branch ${branch} already exists locally. Delete it or finish that PR, then re-run.`);
  }

  log("Opening the version bump PR:");
  info(`Branch: ${branch}`);
  info(`Files:  ${SYNCED_MANIFESTS.join(", ")}`);
  const answer = await prompt("Create and push it? [y/N] ");
  if (answer.toLowerCase() !== "y") {
    error("Aborted — nothing was pushed.");
  }

  await $`git switch -c ${branch}`;
  const pkg = await readPackageJson();
  // Spread keeps `version` in its original position, so the diff stays 1 line.
  await Bun.write(PACKAGE_JSON, JSON.stringify({ ...pkg, version }, null, 2) + "\n");
  await $`bun run scripts/sync-plugin-manifests.ts --version ${version}`;

  const title = `chore(release): v${version}`;
  await $`git add ${SYNCED_MANIFESTS}`;
  await $`git commit -s -m ${title}`;
  await $`git push --set-upstream origin ${branch}`;
  await $`gh pr create --base main --head ${branch} --title ${title} --body ${
    `Stamps the release version into the synced manifests so main matches the tag.\n\n` +
    `server.json is excluded: it tracks its own 1.0.x cadence.\n\n` +
    `Merge this, then re-run \`make release\` to cut v${version}.`
  }`;

  console.log();
  log(`Bump PR opened for v${version}.`);
  info(`Merge it, then: git switch main && git pull && make release`);
  process.exit(0);
}

async function promptChannel(): Promise<Channel> {
  console.log("\nChannel:");
  console.log("  1) beta    - Pre-release for early adopters");
  console.log("  2) stable  - Production release");
  const answer = await prompt("Select channel [1/2]: ");
  if (answer === "1") return "beta";
  if (answer === "2") return "stable";
  error("Invalid selection");
}

async function promptBumpType(baseVersion: string): Promise<BumpType> {
  console.log("\nBump type:");
  console.log(`  1) patch  - Bug fixes (${baseVersion} -> ${inc(baseVersion, "patch")})`);
  console.log(`  2) minor  - New features (${baseVersion} -> ${inc(baseVersion, "minor")})`);
  console.log(`  3) major  - Breaking changes (${baseVersion} -> ${inc(baseVersion, "major")})`);
  const answer = await prompt("Select bump type [1/2/3]: ");
  if (answer === "1") return "patch";
  if (answer === "2") return "minor";
  if (answer === "3") return "major";
  error("Invalid selection");
}

async function main(): Promise<void> {
  const channelArg = process.argv[2] as Channel | undefined;

  await checkPrerequisites();

  const pkg = await readPackageJson();
  const currentVersion = await resolveCurrentVersion(pkg.version);
  const baseVersion = getBaseVersion(currentVersion);

  info(`Current version: ${currentVersion}`);
  info(`Base version: ${baseVersion}`);

  // Determine channel
  let channel: Channel;
  if (channelArg === "beta" || channelArg === "stable") {
    channel = channelArg;
  } else if (channelArg) {
    error(`Invalid channel: ${channelArg}. Use 'beta' or 'stable'.`);
  } else {
    channel = await promptChannel();
  }

  // Determine bump type. The release workflow does the actual version
  // bump/commit/tag — locally we only choose inputs and dispatch it.
  // (Tag pushes do NOT trigger builds anymore; release.yml is
  // workflow_dispatch-only since the CI overhaul.)
  let bump: BumpType | "promote";
  if (channel === "stable" && isPrerelease(currentVersion)) {
    console.log();
    info(`Promoting ${baseVersion} from beta to stable`);
    const answer = await prompt(`Release v${baseVersion} as stable? [y/N] `);
    if (answer.toLowerCase() !== "y") {
      process.exit(1);
    }
    bump = "promote";
  } else {
    bump = await promptBumpType(baseVersion);
  }

  console.log();
  log("Dispatching release workflow:");
  info(`Channel: ${channel}`);
  info(`Bump: ${bump}`);
  const nextVersion = computeNextVersion(currentVersion, channel, bump);
  info(`Next version: v${nextVersion}`);
  await checkChangelogSection(nextVersion);
  // Exits after opening the bump PR when main is behind; the release is
  // dispatched on the re-run, once that PR has merged.
  await ensureVersionLanded(nextVersion);
  console.log();

  const confirm = await prompt("Run release workflow? [y/N] ");
  if (confirm.toLowerCase() !== "y") {
    warn("Aborted.");
    process.exit(1);
  }

  await $`gh workflow run release.yml -f channel=${channel} -f bump=${bump}`;

  console.log();
  log("Release workflow dispatched!");
  info(
    "It bumps the version, tags, builds all platforms, publishes the GitHub release (un-drafts after upload), publishes npm, and runs install tests.",
  );
  info(
    "Watch progress: gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')",
  );
  info("Or: https://github.com/squirrelscan/squirrelscan/actions/workflows/release.yml");
}

// Guard so tests can import computeNextVersion without triggering the dispatcher.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
