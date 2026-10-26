#!/usr/bin/env bun
/**
 * Internal link, anchor and Options table check for the docs (#322, #649, #319).
 * `make validate` and `bun run check` run it after `tangly check --strict`, which
 * passes dead internal links and dead `#anchor` links (tangly 0.5).
 *
 * - Every internal link must reach a page, a redirect or a file. Links are inline
 *   markdown links and images (`[text](target)`), reference definitions
 *   (`[ref]: target`) and JSX `href="target"`, absolute (`/rules/perf/lcp`),
 *   relative (`./lcp`) or same-page (`#how-to-fix`), resolved the way a browser
 *   resolves them from the page's URL. External links (with a scheme), targets
 *   built from a JSX expression (containing `{`), code and MDX comments are not
 *   checked.
 * - A page is `<route>.mdx`, `<route>.md` or `<route>/index.mdx`; `/x/index` and
 *   `/x.md` reach the same page as `/x`. A redirect is a source in docs.json or
 *   `_redirects`.
 * - An anchor must be an id on the target page: a heading's id as the site renders
 *   it (github-slugger over the heading text, `-1`, `-2` for repeats), an explicit
 *   `{#id}` marker at the end of a heading (escaped `\{#id\}` in MDX), an `id="..."`
 *   attribute or an `<a name="...">`. Anchors on a redirect or a file are not
 *   checked.
 * - `required-anchors.json` lists anchors that code outside the docs links to (the
 *   cloud app's failure explanations). Removing one fails here.
 * - No rule page's `## Options` table may print `unknown` as a type or
 *   `` `undefined` `` as a default: those rows came from a generator that could
 *   not read the option schemas (#319).
 *
 * It reads the source line by line, not through the MDX parser, so an inline link
 * whose `(target)` spans lines is not checked. The docs have none.
 *
 * Usage: `bun scripts/check-links.ts [docs-root]`. Prints each problem as
 * `file:line: message` and exits 1 if there are any.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface DocsProblem {
  file: string;
  line: number;
  message: string;
}

const SKIP_DIRS = new Set(["node_modules", "dist"]);
// This script's own directory, at the docs root only: a docs section that happens
// to be called `scripts` deeper down is still checked.
const SKIP_TOP_LEVEL = new Set(["scripts"]);
// Any host will do: links are resolved against the page URL, then only the path and hash are read.
const ORIGIN = "https://docs.invalid";

/** Lists a directory's entry names. `readdirSync`'s order is the filesystem's, so callers sort. */
export type ListDir = (dir: string) => string[];

function walk(dir: string, top: boolean, listDir: ListDir, out: string[] = []): string[] {
  for (const name of listDir(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    if (top && SKIP_TOP_LEVEL.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, false, listDir, out);
    else out.push(path);
  }
  return out;
}

/** The route a path names: `/rules/perf/lcp.mdx`, `/rules/perf/lcp/` and `/rules/perf/index` drop to `/rules/perf/lcp` and `/rules/perf`. */
export function normalizeRoute(path: string): string {
  const route = path
    .replace(/\.(mdx|md)$/, "")
    .replace(/\/+$/, "")
    .replace(/(^|\/)index$/, "");
  return route === "" ? "/" : route;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * github-slugger's slug: lowercased, every character that is not a letter, mark,
 * number, connector punctuation, hyphen or space dropped, each space a hyphen.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

// The entities the docs could plausibly put in a heading. Any other named entity
// is dropped, which is right for symbols (`&copy;`), whose character the slug drops
// too, and wrong for letters (`&eacute;`): write a letter as the character itself.
// No heading uses a named entity today.
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntity(_entity: string, name: string): string {
  if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? "";
  const hex = name[1] === "x" || name[1] === "X";
  const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  const valid =
    code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return valid ? String.fromCodePoint(code) : "\ufffd";
}

/** Inline HTML tags (`<kbd>`, `</kbd>`) dropped, their text kept; `\<` stays escaped. */
function stripTags(text: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      if (!inTag) out += ch + text[i + 1];
      i += 1;
    } else if (ch === "<") inTag = true;
    else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** Markdown outside a code span, reduced to the text it renders. */
function renderProse(markdown: string): string {
  return (
    stripTags(
      markdown
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    )
      .replace(/(\*\*|\*|~~)(?=\S)(.*?\S)\1/g, "$2")
      // `_` and `__` only emphasise at a word boundary: `per_host_delay` stays as written.
      .replace(/(?<![\p{L}\p{N}])(__|_)(?=\S)(.*?\S)\1(?![\p{L}\p{N}])/gu, "$2")
      .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, "$1")
      // Astro's smartypants turns `---` and `--` into dashes, which the slug drops.
      .replace(/---|--/g, "")
      .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, decodeEntity)
      // Any `<` or `>` still here (a stray one, an unescaped `\<`, a decoded
      // `&lt;`) is punctuation, which the slug drops anyway.
      .replace(/[<>]/g, "")
  );
}

// A code span opens and closes on backtick runs of the same length.
const CODE_SPAN = /(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

/** A heading's text as the page renders it. */
export function renderedText(markdown: string): string {
  let text = "";
  let last = 0;
  for (const match of markdown.matchAll(CODE_SPAN)) {
    text += renderProse(markdown.slice(last, match.index));
    const code = match[2]!;
    text += /^ .* $/.test(code) ? code.slice(1, -1) : code;
    last = match.index + match[0].length;
  }
  return (text + renderProse(markdown.slice(last))).trim();
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
// MDX parses markdown inside JSX blocks, indented or not, so a heading may be indented.
const HEADING = /^\s*(#{1,6})\s+(.+?)\s*$/;
// tangly's remark-explicit-ids: only a marker that ends the heading becomes its id.
const EXPLICIT_ID = /\\?\{#([a-zA-Z0-9][\w-]*)\\?\}$/;
const ID_ATTRIBUTE = /(?<![\w-])id\s*=\s*\{?\s*["']([^"']+)["']/g;
const A_NAME = /<a\s[^>]*?(?<![\w-])name\s*=\s*["']([^"']+)["']/g;

/** Each line of a page outside fenced code, frontmatter and MDX comments, with its 1-based line number. */
function proseLines(source: string): Array<{ text: string; line: number }> {
  const lines = source
    .replace(MDX_COMMENT, (comment) => comment.replace(/[^\n]/g, ""))
    .split("\n");
  const out: Array<{ text: string; line: number }> = [];
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) start = end + 1;
  }
  // A fence closes on the same character, at least as long, with nothing after it.
  let fence: string | null = null;
  for (let i = start; i < lines.length; i += 1) {
    const text = lines[i]!;
    const match = FENCE.exec(text);
    if (fence === null) {
      if (match) fence = match[1]!;
      else out.push({ text, line: i + 1 });
    } else if (
      match &&
      match[1]![0] === fence[0] &&
      match[1]!.length >= fence.length &&
      match[2]!.trim() === ""
    ) {
      fence = null;
    }
  }
  return out;
}

/** Every id a page renders. */
export function anchorsOf(source: string): Set<string> {
  const ids = new Set<string>();
  // github-slugger: a repeat gets `-1`, `-2`, ..., skipping any slug already taken.
  const occurrences = new Map<string, number>();
  for (const { text } of proseLines(source)) {
    const prose = text.replace(CODE_SPAN, "");
    for (const match of prose.matchAll(ID_ATTRIBUTE)) ids.add(match[1]!);
    for (const match of prose.matchAll(A_NAME)) ids.add(match[1]!);
    const heading = HEADING.exec(text);
    if (!heading) continue;
    const content = heading[2]!.replace(/\s+#+$/, "");
    const explicit = EXPLICIT_ID.exec(content)?.[1];
    // rehype-slug skips a heading that already has an id, so an explicit id takes
    // no part in the repeat count below.
    if (explicit) {
      ids.add(explicit);
      continue;
    }
    const base = slugify(renderedText(content));
    let slug = base;
    while (occurrences.has(slug)) {
      const count = occurrences.get(base)! + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    ids.add(slug);
  }
  return ids;
}

export interface Link {
  target: string;
  line: number;
}

// Only the `](target)` half: matching the bracketed text too goes quadratic on a long run of `[`.
const INLINE_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
const HREF = /(?<![\w-])href\s*=\s*\{?\s*["']([^"']+)["']/g;

/** Every link target on a page outside code. */
export function linksOf(source: string): Link[] {
  const links: Link[] = [];
  for (const { text, line } of proseLines(source)) {
    const prose = text.replace(CODE_SPAN, "");
    for (const match of prose.matchAll(INLINE_LINK))
      links.push({ target: match[1]!, line });
    const definition = REFERENCE_DEFINITION.exec(prose);
    if (definition) links.push({ target: definition[1]!, line });
    for (const match of prose.matchAll(HREF))
      links.push({ target: match[1]!, line });
  }
  return links;
}

/** Redirect sources from docs.json and `_redirects`; a trailing `/*` is a prefix match. */
function redirectSources(root: string): string[] {
  const sources: string[] = [];
  const config = join(root, "docs.json");
  if (existsSync(config)) {
    let parsed: { redirects?: Array<{ source?: string }> };
    try {
      parsed = JSON.parse(readFileSync(config, "utf8"));
    } catch (e) {
      throw new Error(`docs.json: ${(e as Error).message}`);
    }
    for (const r of parsed.redirects ?? [])
      if (r.source) sources.push(r.source);
  }
  const cloudflare = join(root, "_redirects");
  if (existsSync(cloudflare)) {
    for (const line of readFileSync(cloudflare, "utf8").split("\n")) {
      const source = line.trim().split(/\s+/)[0];
      if (source && !source.startsWith("#")) sources.push(source);
    }
  }
  return sources;
}

/** A redirect source as a pattern: `*` matches anything, a `:name` placeholder one path segment. */
function sourcePattern(source: string): RegExp {
  const body = normalizeRoute(source)
    .split(/(\*|:[A-Za-z_]\w*)/)
    .map((part) =>
      part === "*"
        ? ".*"
        : part.startsWith(":")
          ? "[^/]+"
          : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  return new RegExp(`^${body}$`);
}

function redirected(path: string, sources: string[]): boolean {
  const route = normalizeRoute(path);
  return sources.some((source) => sourcePattern(source).test(route));
}

const OPTIONS_HEADING = /^##\s+Options\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Options table rows on a rule page whose Type cell is `unknown` or whose Default
 * cell is `` `undefined` ``. Other columns, such as a description that mentions
 * an `unknown` value, are not read.
 */
export function brokenOptionRows(source: string): number[] {
  const rows: number[] = [];
  let inOptions = false;
  let columns: { type: number; value: number } | null = null;
  for (const { text, line } of proseLines(source)) {
    if (/^#{1,2}\s/.test(text)) {
      inOptions = OPTIONS_HEADING.test(text);
      columns = null;
    } else if (!inOptions || !text.trimStart().startsWith("|")) {
      if (text.trim() === "") columns = null;
    } else if (columns === null) {
      const header = cells(text).map((cell) => cell.toLowerCase());
      columns = {
        type: header.indexOf("type"),
        value: header.indexOf("default"),
      };
    } else if (!/^[\s|:-]+$/.test(text)) {
      const row = cells(text);
      if (
        row[columns.type] === "unknown" ||
        row[columns.value] === "`undefined`"
      )
        rows.push(line);
    }
  }
  return rows;
}

/**
 * Check the docs under `root`. `requiredAnchors` are `/route#id` strings that
 * must exist. Problems come back sorted by file, then line (pub#943): the
 * filesystem lists a directory in its own order, which differs between
 * machines, so nothing here may depend on it. `listDir` is for tests.
 */
export function checkDocs(
  root: string,
  requiredAnchors: string[] = [],
  listDir: ListDir = (dir) => readdirSync(dir)
): DocsProblem[] {
  // Sorted, so the page that wins when two files name one route
  // (`a.mdx` and `a/index.mdx`) is the same everywhere.
  const files = walk(root, true, listDir)
    .map((f) => relative(root, f).split("\\").join("/"))
    .sort();
  const pages = new Map<string, { file: string; source: string }>();
  for (const file of files) {
    if (file.endsWith(".mdx") || file.endsWith(".md")) {
      pages.set(normalizeRoute(`/${file}`), {
        file,
        source: readFileSync(join(root, file), "utf8"),
      });
    }
  }
  const assets = new Set(files.map((f) => `/${f}`));
  const sources = redirectSources(root);
  const anchorCache = new Map<string, Set<string>>();
  const anchors = (route: string): Set<string> => {
    let ids = anchorCache.get(route);
    if (!ids) {
      ids = anchorsOf(pages.get(route)!.source);
      anchorCache.set(route, ids);
    }
    return ids;
  };

  const problems: DocsProblem[] = [];
  for (const [route, page] of pages) {
    for (const { target, line } of linksOf(page.source)) {
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.startsWith("//") ||
        target.includes("{")
      )
        continue;
      const url = new URL(target, `${ORIGIN}${route}`);
      const path = decode(url.pathname);
      const targetRoute = normalizeRoute(path);
      if (!pages.has(targetRoute)) {
        if (!assets.has(path) && !redirected(path, sources)) {
          problems.push({
            file: page.file,
            line,
            message: `dead link ${target}`,
          });
        }
        continue;
      }
      const anchor = decode(url.hash.slice(1));
      if (anchor && !anchors(targetRoute).has(anchor)) {
        problems.push({
          file: page.file,
          line,
          message: `dead anchor ${target}: ${targetRoute} has no #${anchor}`,
        });
      }
    }
    if (page.file.startsWith("rules/")) {
      for (const row of brokenOptionRows(page.source)) {
        problems.push({
          file: page.file,
          line: row,
          message:
            "Options row prints `unknown` (Type) or `undefined` (Default): write its type and default from the rule's schema",
        });
      }
    }
  }

  for (const required of requiredAnchors) {
    const [path = "", anchor = ""] = required.split("#", 2);
    const route = normalizeRoute(path);
    if (!pages.has(route) || (anchor !== "" && !anchors(route).has(anchor))) {
      problems.push({
        file: "scripts/required-anchors.json",
        line: 1,
        message: `required anchor ${required} is missing (linked from outside the docs)`,
      });
    }
  }
  // Stable: problems on one line keep the order they were found in.
  return problems.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
  );
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(dirname(import.meta.path), "..");
  const required = (
    JSON.parse(
      readFileSync(join(import.meta.dir, "required-anchors.json"), "utf8")
    ) as { anchors: string[] }
  ).anchors;
  const problems = checkDocs(root, required);
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} docs link problem(s).`);
    process.exit(1);
  }
  console.log("Internal links, anchors and Options tables: all good.");
}
