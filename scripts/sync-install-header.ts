#!/usr/bin/env bun
// Writes the squirrelscan header (pixel squirrel + wordmark) into install.sh
// and install.ps1 from apps/cli/src/cli/brand.ts, the single source of the art.
// The installers run before any squirrel binary exists (curl | bash,
// iwr | iex), so they carry pre-rendered copies between marker comments.
//
//   bun run scripts/sync-install-header.ts          rewrite both installers
//   bun run scripts/sync-install-header.ts --check  exit 1 if either has drifted

import { join } from "node:path";

import { renderHeader } from "../apps/cli/src/cli/brand";

const ROOT = join(import.meta.dir, "..");
const BEGIN = "BEGIN GENERATED HEADER (scripts/sync-install-header.ts, from apps/cli/src/cli/brand.ts; do not edit)";
const END = "END GENERATED HEADER";

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

function replaceBlock(source: string, block: string, file: string): string {
  const start = source.indexOf(`# ${BEGIN}`);
  const endMarker = `# ${END}`;
  const end = source.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error(`${file}: generated header markers not found`);
  return source.slice(0, start) + block + source.slice(end + endMarker.length);
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  let drift = false;
  for (const [file, block] of [
    ["install.sh", shBlock()],
    ["install.ps1", psBlock()],
  ] as const) {
    const path = join(ROOT, file);
    const current = await Bun.file(path).text();
    const next = replaceBlock(current, block, file);
    if (next === current) continue;
    if (check) {
      console.error(`${file}: header is out of date. Run: bun run scripts/sync-install-header.ts`);
      drift = true;
    } else {
      await Bun.write(path, next);
      console.log(`${file}: header updated`);
    }
  }
  return drift ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
