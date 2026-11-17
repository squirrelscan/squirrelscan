#!/usr/bin/env bun
// One changelog file per PR, assembled at release (#2113).
//
// A user-visible PR adds one file, `changelog.d/<name>.<section>.md`, holding
// its bullet exactly as it would read under that section of CHANGELOG.md. No PR
// edits CHANGELOG.md, so two PRs never touch the same lines. The release bump
// PR assembles every file into the new version's section and deletes them.
//
//   bun run changelog                        print the assembled unreleased section
//   bun run changelog:release <version>      write `## v<version> (date)` and delete the files
//   bun run changelog:convert [--base ref]   move this branch's CHANGELOG.md bullets into files
//     (a branch opened before #2113 lacks this script: run main's copy, as
//     changelog.d/README.md shows; it works on whatever checkout it runs in)
//   bun scripts/changelog.ts check           validate every file in changelog.d/
//
// scripts/check-changelog-entries.sh is the CI guard. It repeats SECTIONS in
// bash so that job needs no bun install; changelog.test.ts keeps the two lists
// identical.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Section order in a release. File names use the lowercase form. */
export const SECTIONS = ["Added", "Changed", "Fixed", "Security", "Docs"] as const;
export type Section = (typeof SECTIONS)[number];

export const ENTRY_DIR = "changelog.d";
const CHANGELOG = "CHANGELOG.md";
/** Files in changelog.d/ that are not entries. */
const NON_ENTRY_FILES = new Set(["README.md"]);
const ENTRY_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.([A-Za-z]+)\.md$/;

export interface Entry {
  file: string;
  section: Section;
  text: string;
}

export class ChangelogError extends Error {}

function sectionFromSlug(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.toLowerCase() === slug);
}

/** Reads and validates every entry. Throws one error naming every bad file. */
export function readEntries(dir: string): Entry[] {
  if (!existsSync(dir)) return [];
  const problems: string[] = [];
  const entries: Entry[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (NON_ENTRY_FILES.has(file)) continue;
    const match = ENTRY_NAME.exec(file);
    const section = match ? sectionFromSlug(match[2]!) : undefined;
    if (!match || !section) {
      problems.push(
        `${dir}/${file}: name must be <name>.<section>.md with section one of ${SECTIONS.map((s) => s.toLowerCase()).join(", ")}`,
      );
      continue;
    }
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
    if (!text.startsWith("- ")) {
      problems.push(`${dir}/${file}: must hold a Markdown bullet starting with "- "`);
      continue;
    }
    entries.push({ file, section, text });
  }
  if (problems.length > 0) throw new ChangelogError(problems.join("\n"));
  return entries;
}

/** The section body: `### Added` and the rest in SECTIONS order, file-name order within. Empty sections are left out. */
export function renderSections(entries: Entry[]): string {
  const blocks: string[] = [];
  for (const section of SECTIONS) {
    const items = entries
      .filter((e) => e.section === section)
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    if (items.length === 0) continue;
    blocks.push(`### ${section}\n\n${items.map((e) => e.text).join("\n")}`);
  }
  return blocks.join("\n\n");
}

export function renderUnreleased(entries: Entry[]): string {
  const body = renderSections(entries);
  return body
    ? `## [Unreleased]\n\n${body}\n`
    : `## [Unreleased]\n\nNo entries in ${ENTRY_DIR}/.\n`;
}

const VERSION_HEADING = /^## \[?v?\d+\.\d+\.\d+/m;
/** The version token of a `## [v]X.Y.Z...` heading line. */
const HEADING_VERSION = /^## \[?v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Inserts the version's section above the newest release. Pure: the caller deletes the files. */
export function insertRelease(
  changelog: string,
  version: string,
  date: string,
  entries: Entry[],
): string {
  const v = version.replace(/^v/, "");
  if (!RELEASE_VERSION.test(v)) {
    throw new ChangelogError(`"${version}" is not a release version (X.Y.Z or X.Y.Z-pre.N)`);
  }
  if (entries.length === 0) throw new ChangelogError(`no entries in ${ENTRY_DIR}/ to release`);
  // Exact token match, so a stable X.Y.Z may follow its own X.Y.Z-beta.N heading.
  const existing = changelog
    .split("\n")
    .map((line) => HEADING_VERSION.exec(line)?.[1])
    .filter((token): token is string => token !== undefined);
  if (existing.includes(v)) {
    throw new ChangelogError(`${CHANGELOG} already has a section for v${v}`);
  }
  const section = `## v${v} (${date})\n\n${renderSections(entries)}\n\n`;
  const at = changelog.search(VERSION_HEADING);
  if (at === -1) return `${changelog.replace(/\n*$/, "\n\n")}${section.replace(/\n+$/, "\n")}`;
  return changelog.slice(0, at) + section + changelog.slice(at);
}

/** Assembles changelog.d/ into CHANGELOG.md and deletes the entry files. Returns how many it moved. */
export function release(root: string, version: string, date: string): number {
  const dir = join(root, ENTRY_DIR);
  const entries = readEntries(dir);
  const path = join(root, CHANGELOG);
  writeFileSync(path, insertRelease(readFileSync(path, "utf8"), version, date, entries));
  for (const e of entries) rmSync(join(dir, e.file));
  return entries.length;
}

// --- Converting an open PR's CHANGELOG.md bullets -------------------------------

export interface Bullet {
  section: string;
  text: string;
}

/** The `## [Unreleased]` block as [start, end) offsets, or undefined when there is none. */
function unreleasedRange(changelog: string): [number, number] | undefined {
  const start = changelog.search(/^## \[Unreleased\][^\n]*$/m);
  if (start === -1) return undefined;
  const rest = changelog.slice(start + 1);
  const next = rest.search(/^## /m);
  return [start, next === -1 ? changelog.length : start + 1 + next];
}

/** Every bullet under `## [Unreleased]`, with the `###` heading it sits under. Continuation lines stay with their bullet. */
export function unreleasedBullets(changelog: string): Bullet[] {
  const range = unreleasedRange(changelog);
  if (!range) return [];
  const bullets: Bullet[] = [];
  let section = "";
  let current: Bullet | undefined;
  for (const line of changelog.slice(range[0], range[1]).split("\n").slice(1)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      current = undefined;
    } else if (line.startsWith("- ")) {
      current = { section, text: line };
      bullets.push(current);
    } else if (line.trim() === "") {
      current = undefined;
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  for (const b of bullets) b.text = b.text.trimEnd();
  return bullets;
}

/** Bullets in `head` that `base` does not have (a multiset difference), and base bullets head lost. */
export function addedBullets(base: string, head: string): { added: Bullet[]; removed: Bullet[] } {
  const key = (b: Bullet) => `${b.section}\u0000${b.text}`;
  const remaining = new Map<string, Bullet[]>();
  for (const b of unreleasedBullets(base)) {
    const list = remaining.get(key(b)) ?? [];
    list.push(b);
    remaining.set(key(b), list);
  }
  const added: Bullet[] = [];
  for (const b of unreleasedBullets(head)) {
    const list = remaining.get(key(b));
    if (list && list.length > 0) list.pop();
    else added.push(b);
  }
  return { added, removed: [...remaining.values()].flat() };
}

/** `head` with its `## [Unreleased]` block replaced by `base`'s (or dropped when base has none). */
export function restoreUnreleased(base: string, head: string): string {
  const h = unreleasedRange(head);
  if (!h) return head;
  const b = unreleasedRange(base);
  return head.slice(0, h[0]) + (b ? base.slice(b[0], b[1]) : "") + head.slice(h[1]);
}

/** `<issue>-<first words>`, lowercase, for a bullet's file name. */
export function entryName(text: string): string {
  const issue = [...text.matchAll(/#(\d+)/g)].at(-1)?.[1];
  const words = text
    .replace(/^- /, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return [issue, words || "change"].filter(Boolean).join("-");
}

/** Writes one file per bullet. Throws, writing nothing, when a bullet sits under an unknown section. */
export function writeEntries(dir: string, bullets: Bullet[]): string[] {
  const unknown = bullets.filter((b) => !SECTIONS.includes(b.section as Section));
  if (unknown.length > 0) {
    throw new ChangelogError(
      unknown
        .map((b) => `unknown section "### ${b.section || "(none)"}" for: ${b.text.slice(0, 80)}`)
        .join("\n"),
    );
  }
  // A branch opened before #2113 has no changelog.d/ yet.
  mkdirSync(dir, { recursive: true });
  const taken = new Set(readdirSync(dir));
  const written: string[] = [];
  for (const b of bullets) {
    const stem = entryName(b.text);
    const suffix = `.${b.section.toLowerCase()}.md`;
    let file = `${stem}${suffix}`;
    for (let n = 2; taken.has(file); n++) file = `${stem}-${n}${suffix}`;
    taken.add(file);
    writeFileSync(join(dir, file), `${b.text}\n`);
    written.push(file);
  }
  return written;
}

// --- CLI ------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`changelog: ${message}`);
  process.exit(1);
}

async function convert(root: string, baseRef: string): Promise<void> {
  const mergeBase = (await $`git -C ${root} merge-base ${baseRef} HEAD`.text()).trim();
  const base = await $`git -C ${root} show ${`${mergeBase}:${CHANGELOG}`}`.text();
  const path = join(root, CHANGELOG);
  const head = readFileSync(path, "utf8");
  const { added, removed } = addedBullets(base, head);
  if (added.length === 0 && removed.length === 0) {
    console.log(
      `No ${CHANGELOG} bullets added since ${baseRef} (merge base ${mergeBase.slice(0, 12)}).`,
    );
    return;
  }
  const written = writeEntries(join(root, ENTRY_DIR), added);
  writeFileSync(path, restoreUnreleased(base, head));
  for (const file of written) console.log(`wrote ${ENTRY_DIR}/${file}`);
  console.log(`restored ## [Unreleased] in ${CHANGELOG} to merge base ${mergeBase.slice(0, 12)}`);
  for (const b of removed) {
    console.warn(
      `warning: this branch changed or removed a bullet that was already on the base; edit its ${ENTRY_DIR}/ file on main by hand:\n  ${b.text.slice(0, 120)}`,
    );
  }
}

async function main(): Promise<void> {
  const [command = "unreleased", ...args] = process.argv.slice(2);
  const root = (await $`git rev-parse --show-toplevel`.text()).trim();
  try {
    switch (command) {
      case "unreleased":
        process.stdout.write(renderUnreleased(readEntries(join(root, ENTRY_DIR))));
        return;
      case "check": {
        const n = readEntries(join(root, ENTRY_DIR)).length;
        console.log(`${ENTRY_DIR}/ OK (${n} entries)`);
        return;
      }
      case "release": {
        const version = args.find((a) => !a.startsWith("--"));
        if (!version) fail("usage: changelog.ts release <version> [--date YYYY-MM-DD]");
        const dateArg = args.indexOf("--date");
        const date = dateArg === -1 ? new Date().toISOString().slice(0, 10) : args[dateArg + 1];
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("--date must be YYYY-MM-DD");
        const n = release(root, version, date);
        console.log(
          `Assembled ${n} entries into ${CHANGELOG} under v${version.replace(/^v/, "")}.`,
        );
        return;
      }
      case "convert": {
        const baseArg = args.indexOf("--base");
        await convert(
          root,
          baseArg === -1 ? "origin/main" : (args[baseArg + 1] ?? fail("--base needs a ref")),
        );
        return;
      }
      default:
        fail(`unknown command "${command}" (unreleased, check, release, convert)`);
    }
  } catch (err) {
    if (err instanceof ChangelogError) fail(err.message);
    throw err;
  }
}

if (import.meta.main) await main();
