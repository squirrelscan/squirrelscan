#!/usr/bin/env bun
/**
 * Search-snippet guard (#2378). Search engines truncate titles near 60
 * characters and descriptions near 155, and drop pages whose titles repeat.
 * The docs site renders `title` unchanged in the <title> tag (no suffix), so
 * the frontmatter value is what a searcher sees.
 */
import { Glob } from "bun";
import { join } from "node:path";

export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 155;

export interface FrontmatterPage {
  file: string;
  title: unknown;
  description: unknown;
}

export function readFrontmatter(file: string, source: string): FrontmatterPage {
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  const data = match ? (Bun.YAML.parse(match[1]!) as Record<string, unknown> | null) : null;
  return { file, title: data?.title, description: data?.description };
}

export function checkFrontmatter(pages: FrontmatterPage[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const { file, title, description } of pages) {
    if (typeof title !== "string" || title.trim() === "") {
      problems.push(`${file}: missing title`);
    } else {
      const t = title.trim();
      if (t.length < TITLE_MIN || t.length > TITLE_MAX) {
        problems.push(`${file}: title is ${t.length} characters, want ${TITLE_MIN}-${TITLE_MAX}: ${t}`);
      }
      const key = t.toLowerCase();
      const other = seen.get(key);
      if (other) problems.push(`${file}: title duplicates ${other}: ${t}`);
      else seen.set(key, file);
    }
    if (typeof description !== "string" || description.trim() === "") {
      problems.push(`${file}: missing description`);
    } else {
      const d = description.trim();
      if (d.length < DESCRIPTION_MIN || d.length > DESCRIPTION_MAX) {
        problems.push(
          `${file}: description is ${d.length} characters, want ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}: ${d}`,
        );
      }
      if (/[—–]/.test(d)) problems.push(`${file}: description has a dash character, use a colon, comma or full stop`);
      if (!/^[\p{Lu}\d`]/u.test(d)) problems.push(`${file}: description must start with a capital letter: ${d}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const pages: FrontmatterPage[] = [];
  for (const file of [...new Glob("**/*.mdx").scanSync({ cwd: root })].sort()) {
    if (file.startsWith("node_modules/") || file.startsWith("dist/")) continue;
    pages.push(readFrontmatter(file, await Bun.file(join(root, file)).text()));
  }
  const problems = checkFrontmatter(pages);
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`\n${problems.length} frontmatter problem(s) in ${pages.length} pages`);
    process.exit(1);
  }
  console.log(`frontmatter ok: ${pages.length} pages`);
}
