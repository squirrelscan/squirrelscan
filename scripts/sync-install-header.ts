#!/usr/bin/env bun
// Writes the squirrelscan header (pixel squirrel + wordmark) into install.sh
// and install.ps1 from apps/cli/src/cli/brand.ts, the single source of the art,
// and the pinned release signing keys (and first_signed_version) into install.sh and install.ps1 from release-keys.json
// (squirrelscan/repo#5032), the single source `self update` reads too.
// The installers run before any squirrel binary exists (curl | bash,
// iwr | iex), so they carry pre-rendered copies between marker comments.
//
//   bun run scripts/sync-install-header.ts          rewrite both installers
//   bun run scripts/sync-install-header.ts --check  exit 1 if either has drifted,
//                                                   or a pinned key's id does not match its pem

import { join } from "node:path";

import { renderHeader } from "../apps/cli/src/cli/brand";
import {
  getPinnedReleaseKeys,
  type ReleaseKeySet,
  validateReleaseKeys,
} from "../apps/cli/src/self/release-keys";

const ROOT = join(import.meta.dir, "..");
const BEGIN = "BEGIN GENERATED HEADER (scripts/sync-install-header.ts, from apps/cli/src/cli/brand.ts; do not edit)";
const END = "END GENERATED HEADER";
const KEYS_BEGIN = "BEGIN GENERATED RELEASE KEYS (scripts/sync-install-header.ts, from release-keys.json; do not edit)";
const KEYS_END = "END GENERATED RELEASE KEYS";

const truecolor = renderHeader({ level: 3, unicode: true });
const color256 = renderHeader({ level: 2, unicode: true });
const plain = renderHeader({ level: 0, unicode: true });
const fallback = renderHeader({ level: 0, unicode: false });

/** A bash ANSI-C quoted string: $'...' with ESC, newlines, quotes and backslashes escaped. */
function bashAnsiC(s: string): string {
  return `$'${s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\u001b/g, "\\033")
    .replace(/\n/g, "\\n")}'`;
}

/** A single-quoted bash string (the art has no single quotes to escape). */
function bashSingle(s: string): string {
  if (s.includes("'")) throw new Error("header text contains a single quote");
  return `'${s}'`;
}

function shBlock(): string {
  return [
    `# ${BEGIN}`,
    `BANNER_ART_TRUECOLOR=${bashAnsiC(truecolor)}`,
    `BANNER_ART_256=${bashAnsiC(color256)}`,
    `BANNER_ART_PLAIN=${bashSingle(plain)}`,
    `BANNER_TEXT_FALLBACK=${bashSingle(fallback)}`,
    `# ${END}`,
  ].join("\n");
}

/**
 * install.sh's copy of release-keys.json. Exported so the installer tests can
 * render a block that pins a TEST key into a throwaway copy of the script.
 */
export function releaseKeysShBlock(set: ReleaseKeySet): string {
  const [current, next] = set.keys;
  return [
    `# ${KEYS_BEGIN}`,
    `RELEASE_KEY_CURRENT_ID=${bashSingle(current?.id ?? "")}`,
    `RELEASE_KEY_CURRENT_PEM=${bashSingle(current?.pem.trimEnd() ?? "")}`,
    `RELEASE_KEY_NEXT_ID=${bashSingle(next?.id ?? "")}`,
    `RELEASE_KEY_NEXT_PEM=${bashSingle(next?.pem.trimEnd() ?? "")}`,
    `RELEASE_KEYS_REVOKED=${bashSingle(set.revokedKeyIds.join(" "))}`,
    `RELEASE_FIRST_SIGNED_VERSION=${bashSingle(set.firstSignedVersion)}`,
    `# ${KEYS_END}`,
  ].join("\n");
}

/** A PowerShell single-quoted string: only the quote itself needs escaping. */
function psSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * install.ps1's copy of release-keys.json (squirrelscan/repo#5032). The PEMs
 * are multi-line, which a single-quoted PowerShell string holds as is.
 */
export function releaseKeysPsBlock(set: ReleaseKeySet): string {
  const [current, next] = set.keys;
  return [
    `# ${KEYS_BEGIN}`,
    `$ReleaseKeyCurrentId = ${psSingle(current?.id ?? "")}`,
    `$ReleaseKeyCurrentPem = ${psSingle(current?.pem.trimEnd() ?? "")}`,
    `$ReleaseKeyNextId = ${psSingle(next?.id ?? "")}`,
    `$ReleaseKeyNextPem = ${psSingle(next?.pem.trimEnd() ?? "")}`,
    `$ReleaseKeysRevoked = ${psSingle(set.revokedKeyIds.join(" "))}`,
    `$ReleaseFirstSignedVersion = ${psSingle(set.firstSignedVersion)}`,
    `# ${KEYS_END}`,
  ].join("\n");
}

/** PowerShell literal here-strings keep the raw ESC bytes, like the art they replace. */
function psBlock(): string {
  const here = (s: string) => `@'\n${s}\n'@`;
  return [
    `# ${BEGIN}`,
    `$BannerArtColor = ${here(truecolor)}`,
    "",
    `$BannerArtPlain = ${here(plain)}`,
    "",
    `$BannerTextFallback = ${here(fallback)}`,
    `# ${END}`,
  ].join("\n");
}

export function replaceBlock(source: string, block: string, file: string, begin = BEGIN, end_ = END): string {
  const start = source.indexOf(`# ${begin}`);
  const endMarker = `# ${end_}`;
  const end = source.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error(`${file}: generated markers not found (${end_})`);
  return source.slice(0, start) + block + source.slice(end + endMarker.length);
}

export function withReleaseKeys(installSh: string, set: ReleaseKeySet): string {
  return replaceBlock(installSh, releaseKeysShBlock(set), "install.sh", KEYS_BEGIN, KEYS_END);
}

export function withReleaseKeysPs(installPs1: string, set: ReleaseKeySet): string {
  return replaceBlock(installPs1, releaseKeysPsBlock(set), "install.ps1", KEYS_BEGIN, KEYS_END);
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  let drift = false;
  const keys = getPinnedReleaseKeys();
  const problems = await validateReleaseKeys(keys);
  for (const problem of problems) console.error(`release-keys.json: ${problem}`);
  if (problems.length > 0) return 1;
  for (const [file, render] of [
    ["install.sh", (src: string) => withReleaseKeys(replaceBlock(src, shBlock(), "install.sh"), keys)],
    ["install.ps1", (src: string) => withReleaseKeysPs(replaceBlock(src, psBlock(), "install.ps1"), keys)],
  ] as const) {
    const path = join(ROOT, file);
    const current = await Bun.file(path).text();
    const next = render(current);
    if (next === current) continue;
    if (check) {
      console.error(`${file}: generated header or release keys are out of date. Run: bun run scripts/sync-install-header.ts`);
      drift = true;
    } else {
      await Bun.write(path, next);
      console.log(`${file}: generated blocks updated`);
    }
  }
  return drift ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
