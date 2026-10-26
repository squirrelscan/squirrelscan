#!/usr/bin/env bun
/**
 * Glossary and rule-category hub generator and drift check (squirrelscan/repo#3138).
 *
 * Sources of truth, in `scripts/glossary/` (not published: `/scripts/` is in
 * `.tanglyignore`):
 * - `terms.json`: every glossary term, its definition, the rules that check it
 *   and its related terms.
 * - `hubs.json`: one entry per rule category hub (`rules/<code>/index.mdx`).
 * - `baseline.json`: findings on pages written before this check existed, each
 *   with a reason. A listed finding is not reported; an entry that no longer
 *   matches anything fails, so the list only shrinks.
 *
 * Rule facts (title, description, category, severity, scope, weight) are read
 * from the docs rule pages, the same way `check-links.ts` reads the docs: no
 * workspace imports, nothing to install.
 *
 * `--write` regenerates the content between generated-block markers and the
 * Glossary tab in docs.json. A marker is an MDX comment on its own line:
 *
 *     {/* glossary:rules:start *\/}
 *     ...generated...
 *     {/* glossary:rules:end *\/}
 *
 * Blocks: `glossary:index` on `glossary/index.mdx`; `glossary:jsonld` on the
 * index (DefinedTermSet) and on every term page (DefinedTerm), required;
 * `glossary:hub`,
 * `glossary:rules`, `glossary:run` and `glossary:related` on a term page
 * (`glossary/<slug>.mdx`); `hub:start-here`, `hub:rules` and `hub:terms` on a
 * category hub; `glossary:backlinks` on a rule page. On a rule page a term
 * lists, in a category whose hubs.json entry has `rule_backlinks: true`,
 * `--write` adds the `glossary:backlinks` markers itself, at the end of the
 * `## Related rules` section, and `--check` fails while they are missing.
 *
 * Text outside the markers is hand-written and never touched, except the
 * `title` and `sidebarTitle` frontmatter of a term page and of a hub that
 * carries `hub:` markers, which come from the data files.
 *
 * `--check` (run by `bun run check` and `make validate`) exits 1 with
 * `file:line: message` for:
 * 1. a term naming a rule id that no docs rule page has, or other bad term data
 *    (unknown related term, self-relation, duplicate slug or name, no rules, no
 *    authority URL, markup MDX would parse in a definition);
 * 2. a hub that does not link one of its category's rules;
 * 3. a glossary page with no term, a term page for an index-only entry, or a
 *    Glossary tab in docs.json that differs from the generated one;
 * 4. a generated block or synced frontmatter field that differs from what
 *    `--write` produces, or a missing `glossary:backlinks` block (see above),
 *    or a rule page that needs one and has no `## Related rules` section;
 * 5. a category hub (every `rules/<dir>/index.mdx` except the score-group
 *    overview pages) with a category `<Card href="/rules/<category>">` or a
 *    stated rule count ("12 rules", "1,000 rules", "300+ audit rules"). The
 *    two halves have different reasons. A category Card is what makes the
 *    private rule-count test read a page as an overview page, and an overview
 *    page it does not list fails at the next submodule bump; Cards are matched
 *    in the raw text, comments and code included, as that test does. A count
 *    is banned by copy policy: nothing keeps a hub's count in sync with the
 *    catalog, and the private test does not look at counts on a page without
 *    category Cards. A number glued to a ratio ("the 4.5:1 rule") is not a
 *    count;
 * 6. a glossary or hub page whose title is over 60 or description over 155
 *    characters (block scalar descriptions included), or that has an em-dash
 *    or a banned phrase;
 * 7. two glossary or rule pages, or two term titles in terms.json (written or
 *    planned), or a planned term title and an existing page, with the same
 *    title;
 * 8. an unclosed code fence on a glossary or rule page: every marker after it
 *    would be read as code and silently ignored.
 *
 * It also prints rule coverage (rules linked from at least one term) and never
 * fails on an uncovered rule.
 *
 * Usage: `bun scripts/glossary.ts --check|--write [docs-root]`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { linksOf, normalizeRoute } from "./check-links";

export interface Problem {
  file: string;
  line: number;
  message: string;
}

export type TermFormat = "page" | "entry";
export type Group = "seo" | "performance" | "security" | "agents";

export interface Term {
  slug: string;
  term: string;
  aliases: string[];
  format: TermFormat;
  hub: string;
  title: string | null;
  primary_query: string;
  definition: string;
  rules: string[];
  related: string[];
  learn: string[];
  tools: string[];
  authority: string[];
  grounding_note: string | null;
  batch: string;
}

export interface Hub {
  code: string;
  category: string;
  group: Group;
  sidebarTitle: string;
  title: string;
  learn: string[];
  tools: string[];
  related: string[];
  /**
   * The category's rule pages carry a `glossary:backlinks` block: `--write`
   * adds one to every rule page a term lists, and `--check` fails without it.
   * Turned on one batch of categories at a time (squirrelscan/repo#3152).
   */
  rule_backlinks?: boolean;
}

export interface BaselineEntry {
  file: string;
  message: string;
  reason: string;
}

export interface RulePage {
  id: string;
  file: string;
  title: string;
  description: string;
  /** The hub code the `**Category**` row links to (`/rules/<hub>`). */
  hub: string;
  severity: string;
  scope: string;
  weight: number;
}

interface FrontmatterField {
  value: string;
  line: number;
}

interface Page {
  file: string;
  source: string;
  frontmatter: Map<string, FrontmatterField>;
}

type BlockKind =
  | "glossary:index"
  | "glossary:hub"
  | "glossary:rules"
  | "glossary:run"
  | "glossary:related"
  | "glossary:jsonld"
  | "glossary:backlinks"
  | "hub:start-here"
  | "hub:rules"
  | "hub:terms";

type PageKind = "index" | "term" | "hub" | "rule" | "other";

const BLOCKS_BY_PAGE: Record<PageKind, ReadonlySet<BlockKind>> = {
  index: new Set(["glossary:index", "glossary:jsonld"]),
  term: new Set([
    "glossary:hub",
    "glossary:rules",
    "glossary:run",
    "glossary:related",
    "glossary:jsonld",
  ]),
  hub: new Set(["hub:start-here", "hub:rules", "hub:terms"]),
  rule: new Set(["glossary:backlinks"]),
  other: new Set(),
};
const ALL_BLOCKS = new Set<string>(
  Object.values(BLOCKS_BY_PAGE).flatMap((set) => [...set]),
);

interface Block {
  kind: BlockKind;
  /** 0-based line indexes of the start and end markers. */
  start: number;
  end: number;
}

const DATA_DIR = "scripts/glossary";
const TERMS_FILE = `${DATA_DIR}/terms.json`;
const HUBS_FILE = `${DATA_DIR}/hubs.json`;
const BASELINE_FILE = `${DATA_DIR}/baseline.json`;
const LINK_ORIGIN = "https://docs.invalid";

/**
 * The score-group overview pages. The private rule-count test
 * (apps/api/tests/routes/rule-count-consistency.test.ts, OVERVIEW_PAGES) lists
 * exactly these as the pages allowed to carry category Cards.
 * `security` is also the security category's hub.
 */
export const OVERVIEW_DIRS: ReadonlySet<string> = new Set([
  "seo",
  "performance",
  "security",
  "agents",
]);

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;
const EM_DASH = "\u2014";
const BANNED_PHRASES = ["agent readiness", "AI readiness", "SEO rules"];
// A proper noun, and two category names ("Core SEO", "Local SEO") followed by "rules".
const ALLOWED_PHRASES = [
  "Cloudflare Agent Readiness",
  "Core SEO rules",
  "Local SEO rules",
];
const GROUP_LABELS: Record<Group, string> = {
  seo: "SEO",
  performance: "Performance",
  security: "Security",
  agents: "Agent experience",
};
const GROUPS = Object.keys(GROUP_LABELS) as Group[];
export const GLOSSARY_TAB = "Glossary";
const GLOSSARY_ICON = "book-a";
const START_HERE_COUNT = 5;
const SEVERITY_ORDER = ["error", "warning", "info"];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RULE_ID = /^[a-z0-9]+\/[a-z0-9-]+$/;
const SITE_LINK = /^https:\/\/squirrelscan\.com\/(learn|tools)\/[a-z0-9-]+$/;

// CATEGORY_CARD matches a superset of the private test's CARD_RE. RULE_COUNT is
// a copy rule, wider than the private ANY_COUNT_RE: it also catches "1,000
// rules" and "300+ audit rules", and skips a number glued to a ratio or decimal
// ("the 4.5:1 rule").
const CATEGORY_CARD = /<Card\b[^>]*?\bhref=["']\/rules\/([a-z0-9-]+)["']/g;
const RULE_COUNT =
  /(?<![\d.:,/])\b(?:\d{1,3}(?:,\d{3})+|\d+)\+?\s+(?:audit\s+)?rules?\b/gi;
const MARKER =
  /^\s*\{\/\*\s*((?:glossary|hub):[a-z-]+):(start|end)\s*\*\/\}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A term's sort key: case-folded, leading punctuation (`@id`) dropped. */
export function sortKey(term: string): string {
  return term.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
}

function read(root: string, file: string): string | null {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function list(root: string, pattern: string): string[] {
  if (!existsSync(root)) return [];
  return [...new Bun.Glob(pattern).scanSync({ cwd: root })]
    .map((f) => f.split("\\").join("/"))
    .sort(cmp);
}

/** The 1-based line of the first occurrence of `needle`, or 1. */
function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at === -1 ? 1 : text.slice(0, at).split("\n").length;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

const FIELD = /^([A-Za-z][\w-]*):\s*(.*)$/;

/**
 * The index of the first line after the field on line `at` (its key line) that
 * is not part of its value. Indented lines continue a scalar: a block scalar
 * (`|`, `>`), a plain or quoted scalar wrapped onto the next lines, or a plain
 * scalar that starts on the line after the key. A blank line counts only when
 * an indented line follows it, an indented `#` comment ends a plain scalar,
 * and a nested map or list under an empty value is not a scalar at all.
 */
function fieldEnd(lines: string[], at: number): number {
  const head = (FIELD.exec(lines[at]!)?.[2] ?? "").trim();
  // A quoted scalar closed on the key line has nothing after it but comments.
  if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#.*)?$/.test(head))
    return at + 1;
  const block = /^[|>][+-]?\d*$/.test(head);
  const plain = !block && !/^["']/.test(head);
  const continues = (text: string) =>
    /^\s+\S/.test(text) && !(plain && /^\s+#/.test(text));
  if (
    head === "" &&
    /^\s+(?:-(?:\s|$)|["']?[\w-]+["']?:(?:\s|$))/.test(lines[at + 1] ?? "")
  )
    return at + 1;
  let next = at + 1;
  for (let j = at + 1; j < lines.length; j += 1) {
    const text = lines[j]!;
    if (text.trim() === "---") break;
    if (text.trim() === "") continue;
    if (!continues(text)) break;
    next = j + 1;
  }
  return next;
}

/**
 * Top-level `key: value` fields of the frontmatter, with the 1-based line of
 * the key. A value continued on indented lines is joined (see `fieldEnd`): a
 * literal block scalar with newlines, anything else with spaces, so a long
 * description cannot hide on its next lines.
 */
export function frontmatterOf(source: string): Map<string, FrontmatterField> {
  const fields = new Map<string, FrontmatterField>();
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return fields;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") break;
    const match = FIELD.exec(lines[i]!);
    if (!match) continue;
    const head = match[2]!.trim();
    const end = fieldEnd(lines, i);
    const rest = lines.slice(i + 1, end).map((l) => l.trim());
    const block = /^([|>])[+-]?\d*$/.exec(head)?.[1];
    const value =
      block === "|"
        ? rest.join("\n").trim()
        : block === ">"
          ? rest.filter(Boolean).join(" ")
          : unquote([head, ...rest].filter(Boolean).join(" "));
    fields.set(match[1]!, { value, line: i + 1 });
    i = end - 1;
  }
  return fields;
}

function loadPage(root: string, file: string): Page {
  const source = read(root, file) ?? "";
  return { file, source, frontmatter: frontmatterOf(source) };
}

/** Each line outside frontmatter, fenced code and MDX or HTML comments, blanked otherwise, so indexes stay line numbers. */
function proseMask(source: string): string[] {
  const blanked = source.replace(
    /\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g,
    (comment) => comment.replace(/[^\n]/g, ""),
  );
  const { fenced } = fencedLines(blanked);
  return blanked.split("\n").map((text, i) => (fenced[i] ? "" : text));
}

/**
 * Per line: is it a code fence or inside one. `unclosed` is the 0-based line of
 * a fence that never closes, or null.
 */
function fencedLines(source: string): {
  fenced: boolean[];
  unclosed: number | null;
} {
  let fence: string | null = null;
  let openedAt = 0;
  const fenced = source.split("\n").map((text, i) => {
    const match = FENCE.exec(text);
    if (fence !== null) {
      if (
        match &&
        match[1]![0] === fence[0] &&
        match[1]!.length >= fence.length
      )
        fence = null;
      return true;
    }
    if (match) {
      fence = match[1]!;
      openedAt = i;
    }
    return match !== null;
  });
  return { fenced, unclosed: fence === null ? null : openedAt };
}

/**
 * Guard 5 sees a page the way the private rule-count test does: Cards in the
 * raw text, counts with only backtick fences and HTML comments removed.
 */
function countMask(source: string): string {
  return source.replace(/```[\s\S]*?```|<!--[\s\S]*?-->/g, (masked) =>
    masked.replace(/[^\n]/g, ""),
  );
}

function tableRow(source: string, label: string): string | null {
  const match = new RegExp(
    `^\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*(.*?)\\s*\\|\\s*$`,
    "m",
  ).exec(source);
  return match ? match[1]! : null;
}

/** A rule page's facts, or a problem when a field the generator needs is missing. */
export function parseRulePage(page: Page): RulePage | Problem {
  const id = /^`([^`]+)`$/.exec(tableRow(page.source, "Rule ID") ?? "")?.[1];
  const hub = /\]\(\/rules\/([a-z0-9-]+)\)/.exec(
    tableRow(page.source, "Category") ?? "",
  )?.[1];
  const title = page.frontmatter.get("title")?.value;
  if (!id || !hub || !title) {
    const missing = !id ? "**Rule ID**" : !hub ? "**Category** link" : "title";
    return {
      file: page.file,
      line: 1,
      message: `rule page has no ${missing}: the glossary generator reads it`,
    };
  }
  const weight = Number(
    /^(\d+(?:\.\d+)?)/.exec(tableRow(page.source, "Weight") ?? "")?.[1] ?? 0,
  );
  return {
    id,
    file: page.file,
    title,
    description: page.frontmatter.get("description")?.value ?? "",
    hub,
    severity: tableRow(page.source, "Severity") ?? "",
    scope: tableRow(page.source, "Scope") ?? "",
    weight,
  };
}

/** Markers on a page, paired; malformed ones come back as problems. */
export function blocksOf(
  file: string,
  source: string,
  allowed: ReadonlySet<BlockKind>,
): { blocks: Block[]; problems: Problem[] } {
  const blocks: Block[] = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  let open: { kind: string; start: number } | null = null;
  const lines = source.split("\n");
  // A marker quoted in a code example is not a marker.
  const { fenced, unclosed } = fencedLines(source);
  if (unclosed !== null)
    problems.push({
      file,
      line: unclosed + 1,
      message:
        "code fence is never closed: everything after it, generated-block markers included, reads as code",
    });
  for (let i = 0; i < lines.length; i += 1) {
    const match = fenced[i] ? null : MARKER.exec(lines[i]!);
    if (!match) continue;
    const [, kind, edge] = match as unknown as [string, string, string];
    const bad = (message: string) =>
      problems.push({ file, line: i + 1, message });
    if (!ALL_BLOCKS.has(kind)) {
      bad(`unknown generated block ${kind}`);
      continue;
    }
    if (!allowed.has(kind as BlockKind)) {
      bad(`generated block ${kind} does not belong on this page`);
      continue;
    }
    if (edge === "start") {
      if (open) bad(`${kind}:start inside ${open.kind}, which is not closed`);
      else if (seen.has(kind)) bad(`generated block ${kind} appears twice`);
      else open = { kind, start: i };
    } else if (!open || open.kind !== kind) {
      bad(`${kind}:end without a matching ${kind}:start`);
    } else {
      blocks.push({ kind: kind as BlockKind, start: open.start, end: i });
      seen.add(kind);
      open = null;
    }
  }
  if (open)
    problems.push({
      file,
      line: open.start + 1,
      message: `${open.kind}:start has no ${open.kind}:end`,
    });
  return { blocks, problems };
}

/** Replace each block's content; lines outside the markers are untouched. */
export function applyBlocks(
  source: string,
  blocks: Block[],
  render: (kind: BlockKind) => string,
): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    out.push(...lines.slice(at, block.start + 1));
    const content = render(block.kind).trim();
    out.push("");
    if (content !== "") out.push(...content.split("\n"), "");
    at = block.end;
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

const RELATED_RULES = /^##\s+Related rules\s*$/;
const SECTION_HEADING = /^#{1,2}\s/;

/**
 * `source` with an empty `glossary:backlinks` block added after the last
 * non-blank line of its `## Related rules` section, and the 1-based line of
 * `source` it goes in before. Null when the page has no such section outside
 * code fences and comments.
 */
export function insertBacklinksBlock(
  source: string,
): { source: string; line: number } | null {
  const lines = source.split("\n");
  // Headings in code fences and MDX or HTML comments are not sections.
  const prose = proseMask(source);
  const heading = prose.findIndex((text) => RELATED_RULES.test(text));
  if (heading < 0) return null;
  const next = prose.findIndex(
    (text, i) => i > heading && SECTION_HEADING.test(text),
  );
  let at = next < 0 ? lines.length : next;
  while (at > heading + 1 && lines[at - 1]!.trim() === "") at -= 1;
  lines.splice(
    at,
    0,
    "",
    "{/* glossary:backlinks:start */}",
    "{/* glossary:backlinks:end */}",
  );
  return { source: lines.join("\n"), line: at + 1 };
}

/** Set frontmatter fields, adding a missing one after `title`. */
export function setFrontmatter(
  source: string,
  values: Record<string, string>,
): string {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return source;
  const endOf = () => lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endOf() < 0) return source;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}: ${JSON.stringify(value)}`;
    const end = endOf();
    const at = lines.findIndex(
      (l, i) => i > 0 && i < end && l.startsWith(`${key}:`),
    );
    if (at >= 0) {
      // Read the field as --check does, so an accepted value is never rewritten.
      if (frontmatterOf(lines.join("\n")).get(key)?.value === value) continue;
      // Drop a multi-line value's continuation lines along with its key.
      lines.splice(at, fieldEnd(lines, at) - at, line);
      continue;
    }
    const title = lines.findIndex(
      (l, i) => i > 0 && i < end && l.startsWith("title:"),
    );
    // After the whole title field, so a multi-line title is not split.
    lines.splice(title >= 0 ? fieldEnd(lines, title) : end, 0, line);
  }
  return lines.join("\n");
}

/** Text from frontmatter or data, made safe for MDX prose and a table cell. */
function cell(text: string): string {
  return text.replace(/[\\<>{}|]/g, (ch) => `\\${ch}`);
}

function severityRank(severity: string): number {
  const word = /^[a-z]+/.exec(severity)?.[0] ?? "";
  const rank = SEVERITY_ORDER.indexOf(word);
  return rank === -1 ? SEVERITY_ORDER.length : rank;
}

function severityLabel(severity: string): string {
  return /^(error|warning|info)\b/.exec(severity)?.[1] ?? cell(severity);
}

export interface Data {
  terms: Term[];
  hubs: Hub[];
  baseline: BaselineEntry[];
}

interface Model {
  root: string;
  data: Data;
  termsText: string;
  hubsText: string;
  rules: Map<string, RulePage>;
  hubs: Map<string, Hub>;
  terms: Map<string, Term>;
  /** Slugs of page-format terms whose `glossary/<slug>.mdx` exists. */
  written: Set<string>;
  hasIndex: boolean;
}

function termLink(model: Model, term: Term): string {
  return model.written.has(term.slug)
    ? `/glossary/${term.slug}`
    : `/glossary#${term.slug}`;
}

function ruleLink(model: Model, id: string): string {
  const rule = model.rules.get(id);
  return `[${cell(rule?.title ?? id)}](/rules/${id})`;
}

function bySortKey(a: Term, b: Term): number {
  return cmp(sortKey(a.term), sortKey(b.term)) || cmp(a.slug, b.slug);
}

function rulesOfHub(model: Model, code: string): RulePage[] {
  return [...model.rules.values()]
    .filter((rule) => rule.hub === code)
    .sort(
      (a, b) =>
        cmp(a.title.toLowerCase(), b.title.toLowerCase()) || cmp(a.id, b.id),
    );
}

function termsOfHub(model: Model, code: string): Term[] {
  return model.data.terms
    .filter((term) =>
      term.rules.some((id) => model.rules.get(id)?.hub === code),
    )
    .sort(bySortKey);
}

function termLine(model: Model, term: Term): string {
  return `- [${cell(term.term)}](${termLink(model, term)}): ${term.definition}`;
}

/** The content of one generated block on `file`. */
export function renderBlock(
  model: Model,
  kind: BlockKind,
  file: string,
): string {
  const slug = /^glossary\/(.+)\.mdx$/.exec(file)?.[1] ?? "";
  const term = model.terms.get(slug);
  const hubCode = /^rules\/([^/]+)\/index\.mdx$/.exec(file)?.[1] ?? "";
  switch (kind) {
    case "glossary:index":
      return renderIndex(model);
    case "glossary:hub": {
      const hub = term ? model.hubs.get(term.hub) : undefined;
      return hub
        ? `Category: [${cell(hub.sidebarTitle)}](/rules/${hub.code})`
        : "";
    }
    case "glossary:rules":
      return term
        ? [
            "| Rule | What it flags | Severity |",
            "|---|---|---|",
            ...term.rules.map((id) => {
              const rule = model.rules.get(id);
              return `| ${ruleLink(model, id)} | ${cell(rule?.description ?? "")} | ${severityLabel(rule?.severity ?? "")} |`;
            }),
          ].join("\n")
        : "";
    case "glossary:run":
      return term
        ? [
            "```bash",
            `squirrel audit https://example.com --rule-include ${term.rules.join(",")}`,
            "```",
          ].join("\n")
        : "";
    case "glossary:related": {
      const related = (term?.related ?? [])
        .map((s) => model.terms.get(s))
        .filter((t): t is Term => t !== undefined);
      if (related.length === 0) return "";
      return [
        "## Related terms",
        "",
        ...related.map((t) => termLine(model, t)),
      ].join("\n");
    }
    case "glossary:jsonld":
      return renderJsonLd(term, file);
    case "glossary:backlinks": {
      const id = [...model.rules.values()].find((r) => r.file === file)?.id;
      const terms = model.data.terms
        .filter((t) => id !== undefined && t.rules.includes(id))
        .sort(bySortKey);
      if (terms.length === 0) return "";
      return `Glossary: ${terms
        .map((t) => `[${cell(t.term)}](${termLink(model, t)})`)
        .join(", ")}.`;
    }
    case "hub:start-here": {
      const top = rulesOfHub(model, hubCode)
        .sort(
          (a, b) =>
            severityRank(a.severity) - severityRank(b.severity) ||
            b.weight - a.weight ||
            cmp(a.title.toLowerCase(), b.title.toLowerCase()) ||
            cmp(a.id, b.id),
        )
        .slice(0, START_HERE_COUNT);
      return [
        "## Where to start",
        "",
        "These carry the highest severity and weight in the category.",
        "",
        ...top.map(
          (rule) => `- ${ruleLink(model, rule.id)}: ${cell(rule.description)}`,
        ),
      ].join("\n");
    }
    case "hub:rules":
      return [
        "## Rules",
        "",
        "| Rule | What it flags | Severity | Scope |",
        "|---|---|---|---|",
        ...rulesOfHub(model, hubCode).map(
          (rule) =>
            `| ${ruleLink(model, rule.id)} | ${cell(rule.description)} | ${severityLabel(rule.severity)} | ${cell(rule.scope)} |`,
        ),
      ].join("\n");
    case "hub:terms": {
      const terms = termsOfHub(model, hubCode);
      return [
        "## Key terms",
        "",
        ...(terms.length > 0
          ? terms.map((t) => termLine(model, t))
          : ["No glossary term covers this category yet."]),
      ].join("\n");
    }
  }
}

/**
 * The component renders a DefinedTermSet on the index or a DefinedTerm on a
 * term page. Keeping the JSON generation outside the MDX body preserves the
 * schema in rendered HTML without copying raw script text into tangly's
 * agent-facing Markdown outputs.
 */
function renderJsonLd(term: Term | undefined, file: string): string {
  const slug = file === "glossary/index.mdx" ? undefined : term?.slug;
  if (file !== "glossary/index.mdx" && slug === undefined) return "";
  return [
    'import GlossaryJsonLd from "../components/GlossaryJsonLd.astro";',
    "",
    `<GlossaryJsonLd${slug ? ` slug="${slug}"` : ""} />`,
  ].join("\n");
}

function letterOf(term: Term): string {
  const first = sortKey(term.term).charAt(0).toUpperCase();
  return /\p{L}/u.test(first) ? first : "0-9";
}

function renderIndex(model: Model): string {
  const terms = [...model.data.terms].sort(bySortKey);
  const letters = [...new Set(terms.map(letterOf))];
  const out: string[] = [
    letters.map((l) => `[${l}](#${l.toLowerCase()})`).join(" · "),
  ];
  for (const letter of letters) {
    out.push("", `## ${letter}`);
    for (const term of terms.filter((t) => letterOf(t) === letter)) {
      out.push(
        "",
        `### ${cell(term.term)} \\{#${term.slug}\\}`,
        "",
        term.definition,
      );
      if (term.aliases.length > 0)
        out.push("", `Also called: ${term.aliases.map(cell).join(", ")}.`);
      out.push(
        "",
        `Checked by ${term.rules.map((id) => ruleLink(model, id)).join(", ")}.`,
      );
      if (model.written.has(term.slug))
        out.push("", `[Read the full definition](/glossary/${term.slug}).`);
    }
  }
  return out.join("\n");
}

interface NavGroup {
  group: string;
  pages: string[];
}
interface NavTab {
  tab: string;
  icon?: string;
  groups: NavGroup[];
}

/** The Glossary tab docs.json should carry, or null when there is no glossary index yet. */
export function glossaryTab(model: Model): NavTab | null {
  if (!model.hasIndex) return null;
  const groups: NavGroup[] = [
    { group: GLOSSARY_TAB, pages: ["glossary/index"] },
  ];
  for (const group of GROUPS) {
    const pages = model.data.terms
      .filter(
        (t) =>
          model.written.has(t.slug) && model.hubs.get(t.hub)?.group === group,
      )
      .sort(bySortKey)
      .map((t) => `glossary/${t.slug}`);
    if (pages.length > 0) groups.push({ group: GROUP_LABELS[group], pages });
  }
  return { tab: GLOSSARY_TAB, icon: GLOSSARY_ICON, groups };
}

interface DocsConfig {
  navigation?: { tabs?: NavTab[] };
  [key: string]: unknown;
}

/** docs.json with its Glossary tab replaced, added after Rules, or removed. */
export function withGlossaryTab(
  config: DocsConfig,
  tab: NavTab | null,
): DocsConfig {
  const all = config.navigation?.tabs ?? [];
  const at = all.findIndex((t) => t.tab === GLOSSARY_TAB);
  // Every Glossary tab goes, so a duplicate cannot survive a write.
  const tabs = all.filter((t) => t.tab !== GLOSSARY_TAB);
  if (tab) {
    const rules = tabs.findIndex((t) => t.tab === "Rules");
    tabs.splice(at >= 0 ? at : rules >= 0 ? rules + 1 : tabs.length, 0, tab);
  }
  return { ...config, navigation: { ...config.navigation, tabs } };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseJson(
  root: string,
  file: string,
  key: string,
  problems: Problem[],
): { text: string; items: unknown[] } {
  const text = read(root, file);
  if (text === null) {
    if (file !== BASELINE_FILE)
      problems.push({ file, line: 1, message: "missing" });
    return { text: "", items: [] };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const items = parsed[key];
    if (!Array.isArray(items)) {
      problems.push({ file, line: 1, message: `no "${key}" array` });
      return { text, items: [] };
    }
    return { text, items };
  } catch (e) {
    problems.push({
      file,
      line: 1,
      message: `invalid JSON: ${(e as Error).message}`,
    });
    return { text, items: [] };
  }
}

const TERM_STRINGS = [
  "slug",
  "term",
  "hub",
  "primary_query",
  "definition",
  "batch",
] as const;
const TERM_ARRAYS = [
  "aliases",
  "rules",
  "related",
  "learn",
  "tools",
  "authority",
] as const;

function validTerm(item: unknown): item is Term {
  if (typeof item !== "object" || item === null) return false;
  const t = item as Record<string, unknown>;
  return (
    TERM_STRINGS.every((k) => typeof t[k] === "string") &&
    TERM_ARRAYS.every((k) => isStringArray(t[k])) &&
    (t.format === "page" || t.format === "entry") &&
    (t.title === null || typeof t.title === "string") &&
    (t.grounding_note === null || typeof t.grounding_note === "string")
  );
}

function validHub(item: unknown): item is Hub {
  if (typeof item !== "object" || item === null) return false;
  const h = item as Record<string, unknown>;
  return (
    ["code", "category", "sidebarTitle", "title"].every(
      (k) => typeof h[k] === "string",
    ) &&
    GROUPS.includes(h.group as Group) &&
    ["learn", "tools", "related"].every((k) => isStringArray(h[k])) &&
    (h.rule_backlinks === undefined || typeof h.rule_backlinks === "boolean")
  );
}

function validBaseline(item: unknown): item is BaselineEntry {
  if (typeof item !== "object" || item === null) return false;
  const b = item as Record<string, unknown>;
  return ["file", "message", "reason"].every((k) => typeof b[k] === "string");
}

/** Copy rules shared by data and pages: em-dash and banned phrases. */
function copyProblems(text: string): string[] {
  const found: string[] = [];
  if (text.includes(EM_DASH))
    found.push("has an em-dash (use a colon, comma or period)");
  let rest = text;
  for (const allowed of ALLOWED_PHRASES)
    rest = rest.replace(new RegExp(allowed, "gi"), "");
  for (const phrase of BANNED_PHRASES)
    if (rest.toLowerCase().includes(phrase.toLowerCase()))
      found.push(`says "${phrase}"`);
  return found;
}

/** MDX would parse `<` or `{` outside a code span as JSX or an expression. */
function mdxUnsafe(text: string): boolean {
  // An escaped backtick does not open a code span.
  return /[<>{}]/.test(text.replace(/\\`/g, "").replace(CODE_SPAN, ""));
}

function checkData(model: Model, problems: Problem[]): void {
  const { data, termsText, hubsText } = model;
  const termAt = (slug: string) => lineOf(termsText, `"slug": "${slug}"`);
  const hubAt = (code: string) => lineOf(hubsText, `"code": "${code}"`);
  const slugs = new Set<string>();
  // Every slug, name and alias, case-folded, to the term that owns it: an alias
  // may not be another term's slug, name or alias.
  const names = new Map<string, string>();
  for (const term of data.terms)
    if (!names.has(term.slug)) names.set(term.slug, term.slug);
  const titles = new Map<string, string>();
  for (const term of data.terms) {
    const line = termAt(term.slug);
    const bad = (message: string) =>
      problems.push({
        file: TERMS_FILE,
        line,
        message: `term ${term.slug}: ${message}`,
      });
    if (!SLUG.test(term.slug)) bad("slug is not lowercase-hyphenated");
    if (slugs.has(term.slug)) bad("duplicate slug");
    slugs.add(term.slug);
    for (const [label, value] of [
      ["name", term.term],
      ...term.aliases.map((a) => ["alias", a] as const),
    ] as const) {
      const key = value.trim().toLowerCase();
      const owner = names.get(key);
      if (owner !== undefined && owner !== term.slug)
        bad(
          `${label} "${value}" is also the slug, name or alias of term ${owner}`,
        );
      else names.set(key, term.slug);
    }
    if (term.title) {
      const key = term.title.trim().toLowerCase();
      const owner = titles.get(key);
      if (owner !== undefined) bad(`same title as term ${owner}`);
      else titles.set(key, term.slug);
    }
    if (!model.hubs.has(term.hub)) bad(`hub ${term.hub} is not in hubs.json`);
    if (term.format === "page" && !term.title) bad("a page term needs a title");
    if (term.format === "entry" && term.title !== null)
      bad("an index-only entry has no page, so its title must be null");
    if (term.title && term.title.length > TITLE_MAX)
      bad(`title is ${term.title.length} characters (max ${TITLE_MAX})`);
    if (term.definition.trim() === "") bad("empty definition");
    for (const field of ["term", "definition", "title"] as const) {
      const value = term[field];
      if (!value) continue;
      for (const found of copyProblems(value)) bad(`${field} ${found}`);
      if (field !== "title" && mdxUnsafe(value))
        bad(
          `${field} has < > { or } outside a code span, which MDX parses as markup`,
        );
    }
    // Aliases render through cell(), so only the copy rules apply.
    for (const alias of term.aliases)
      for (const found of copyProblems(alias)) bad(`alias "${alias}" ${found}`);
    if (term.rules.length === 0) bad("lists no rules");
    const ruleSet = new Set<string>();
    for (const id of term.rules) {
      if (ruleSet.has(id)) bad(`lists rule ${id} twice`);
      ruleSet.add(id);
      if (!RULE_ID.test(id) || !model.rules.has(id))
        bad(
          `names rule ${id}, which has no docs rule page (no **Rule ID** row names it)`,
        );
    }
    const relatedSet = new Set<string>();
    for (const rel of term.related) {
      if (rel === term.slug) bad("relates to itself");
      else if (!data.terms.some((t) => t.slug === rel))
        bad(`related term ${rel} is not a term`);
      if (relatedSet.has(rel)) bad(`lists related term ${rel} twice`);
      relatedSet.add(rel);
    }
    if (term.authority.length === 0) bad("has no authority URL");
    for (const url of term.authority)
      if (!url.startsWith("https://"))
        bad(`authority ${url} is not an https URL`);
    for (const [field, kind] of [
      ["learn", "learn"],
      ["tools", "tools"],
    ] as const)
      for (const url of term[field])
        if (SITE_LINK.exec(url)?.[1] !== kind)
          bad(`${field} ${url} is not https://squirrelscan.com/${kind}/<slug>`);
  }

  const hubCodes = new Set<string>();
  for (const hub of data.hubs) {
    const line = hubAt(hub.code);
    const bad = (message: string) =>
      problems.push({
        file: HUBS_FILE,
        line,
        message: `hub ${hub.code}: ${message}`,
      });
    if (hubCodes.has(hub.code)) bad("duplicate code");
    hubCodes.add(hub.code);
    if (hub.title.length > TITLE_MAX)
      bad(`title is ${hub.title.length} characters (max ${TITLE_MAX})`);
    for (const found of copyProblems(`${hub.title}\n${hub.sidebarTitle}`))
      bad(`title ${found}`);
    if (!existsSync(join(model.root, `rules/${hub.code}/index.mdx`)))
      bad(`rules/${hub.code}/index.mdx does not exist`);
    for (const rel of hub.related) {
      if (rel === hub.code) bad("relates to itself");
      else if (!data.hubs.some((h) => h.code === rel))
        bad(`related hub ${rel} is not in hubs.json`);
    }
    for (const [field, kind] of [
      ["learn", "learn"],
      ["tools", "tools"],
    ] as const)
      for (const url of hub[field])
        if (SITE_LINK.exec(url)?.[1] !== kind)
          bad(`${field} ${url} is not https://squirrelscan.com/${kind}/<slug>`);
  }
  // Every category a rule page names needs a hub entry.
  const ruleHubs = new Set([...model.rules.values()].map((r) => r.hub));
  for (const code of [...ruleHubs].sort(cmp))
    if (!hubCodes.has(code))
      problems.push({
        file: HUBS_FILE,
        line: 1,
        message: `no hub entry for category ${code} (rules/${code}/index.mdx)`,
      });
}

/**
 * The rule ids a hub links to. Links are read and resolved the way
 * check-links.ts does: inline, reference-style and `href`, absolute or relative
 * to the hub's URL (`/rules/<code>`), with any trailing slash or hash dropped.
 */
function rulesLinkedFrom(source: string, code: string): Set<string> {
  const linked = new Set<string>();
  for (const { target } of linksOf(proseMask(source).join("\n"))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//"))
      continue;
    let route: string;
    try {
      route = normalizeRoute(
        decodeURIComponent(
          new URL(target, `${LINK_ORIGIN}/rules/${code}`).pathname,
        ),
      );
    } catch {
      continue;
    }
    const id = /^\/rules\/([a-z0-9-]+\/[a-z0-9-]+)$/.exec(route)?.[1];
    if (id) linked.add(id);
  }
  return linked;
}

function checkCopy(page: Page, problems: Problem[]): void {
  const title = page.frontmatter.get("title");
  const description = page.frontmatter.get("description");
  if (title && title.value.length > TITLE_MAX)
    problems.push({
      file: page.file,
      line: title.line,
      message: `title is ${title.value.length} characters (max ${TITLE_MAX})`,
    });
  if (description && description.value.length > DESCRIPTION_MAX)
    problems.push({
      file: page.file,
      line: description.line,
      message: `description is ${description.value.length} characters (max ${DESCRIPTION_MAX})`,
    });
  // Code blocks and comments may quote third-party text; prose and frontmatter may not.
  proseMask(page.source).forEach((text, i) => {
    for (const found of copyProblems(text))
      problems.push({ file: page.file, line: i + 1, message: found });
  });
}

/** Guard 5: what makes the private rule-count test read a page as an overview page. */
function checkCategoryHub(page: Page, problems: Problem[]): void {
  // Whole text, not line by line: a Card's attributes and a count's words can wrap.
  const text = countMask(page.source);
  const line = (source: string, index: number) =>
    source.slice(0, index).split("\n").length;
  for (const match of page.source.matchAll(CATEGORY_CARD))
    problems.push({
      file: page.file,
      line: line(page.source, match.index),
      message: `category hub has a category Card (href="/rules/${match[1]}"): the private rule-count test would read it as an overview page; link categories inline`,
    });
  for (const match of text.matchAll(RULE_COUNT))
    problems.push({
      file: page.file,
      line: line(text, match.index),
      message: `category hub states a rule count ("${match[0].replace(/\s+/g, " ")}"): counts here are not kept in sync; let the rule table show the count`,
    });
}

function buildModel(
  root: string,
  problems: Problem[],
): { model: Model; pages: Map<string, Page> } {
  const termsJson = parseJson(root, TERMS_FILE, "terms", problems);
  const hubsJson = parseJson(root, HUBS_FILE, "hubs", problems);
  const baselineJson = parseJson(root, BASELINE_FILE, "entries", problems);
  const terms: Term[] = [];
  termsJson.items.forEach((item, i) => {
    if (validTerm(item)) terms.push(item);
    else
      problems.push({
        file: TERMS_FILE,
        line: 1,
        message: `terms[${i}] is missing a field or has a field of the wrong type`,
      });
  });
  const hubs: Hub[] = [];
  hubsJson.items.forEach((item, i) => {
    if (validHub(item)) hubs.push(item);
    else
      problems.push({
        file: HUBS_FILE,
        line: 1,
        message: `hubs[${i}] is missing a field or has a field of the wrong type`,
      });
  });
  const baseline: BaselineEntry[] = [];
  baselineJson.items.forEach((item, i) => {
    if (validBaseline(item)) baseline.push(item);
    else
      problems.push({
        file: BASELINE_FILE,
        line: 1,
        message: `entries[${i}] needs file, message and reason`,
      });
  });

  const pages = new Map<string, Page>();
  for (const file of [
    ...list(root, "rules/**/*.mdx"),
    ...list(root, "glossary/**/*.mdx"),
  ])
    pages.set(file, loadPage(root, file));

  const rules = new Map<string, RulePage>();
  for (const page of pages.values()) {
    // `/index.mdx`, not `index.mdx`: `rules/a11y/tabindex.mdx` is a rule page.
    if (!page.file.startsWith("rules/") || /(^|\/)index\.mdx$/.test(page.file))
      continue;
    const parsed = parseRulePage(page);
    if ("message" in parsed) problems.push(parsed);
    else if (rules.has(parsed.id))
      problems.push({
        file: page.file,
        line: lineOf(page.source, "**Rule ID**"),
        message: `rule id ${parsed.id} is also documented by ${rules.get(parsed.id)!.file}`,
      });
    else rules.set(parsed.id, parsed);
  }

  const written = new Set<string>();
  for (const term of terms)
    if (term.format === "page" && pages.has(`glossary/${term.slug}.mdx`))
      written.add(term.slug);

  const model: Model = {
    root,
    data: { terms, hubs, baseline },
    termsText: termsJson.text,
    hubsText: hubsJson.text,
    rules,
    hubs: new Map(hubs.map((h) => [h.code, h])),
    terms: new Map(terms.map((t) => [t.slug, t])),
    written,
    hasIndex: pages.has("glossary/index.mdx"),
  };
  return { model, pages };
}

/** A rule page whose category has rule_backlinks on and that a term lists. */
function needsBacklinks(model: Model, file: string): boolean {
  const rule = [...model.rules.values()].find((r) => r.file === file);
  return (
    rule !== undefined &&
    model.hubs.get(rule.hub)?.rule_backlinks === true &&
    model.data.terms.some((t) => t.rules.includes(rule.id))
  );
}

function pageKind(model: Model, file: string): PageKind {
  if (file === "glossary/index.mdx") return "index";
  if (file.startsWith("glossary/")) return "term";
  const hub = /^rules\/([^/]+)\/index\.mdx$/.exec(file)?.[1];
  if (hub) return model.hubs.has(hub) ? "hub" : "other";
  if (file.startsWith("rules/") && file !== "rules/index.mdx") return "rule";
  return "other";
}

interface Plan {
  model: Model;
  problems: Problem[];
  /** file -> the source `--write` produces, for files that would change. */
  writes: Map<string, string>;
  /** Problems that `--write` fixes, reported by `--check`. */
  stale: Problem[];
  /** docs.json as JSON.stringify writes it, now and after `--write`. */
  docsConfig: { current: string; expected: string } | null;
}

function plan(root: string): Plan {
  const problems: Problem[] = [];
  const stale: Problem[] = [];
  const { model, pages } = buildModel(root, problems);
  checkData(model, problems);
  // tangly renders any .md/.mdx it finds as a docs page; `.tanglyignore` only
  // keeps static files out of the copy. Author-only notes under scripts/ must
  // use a non-page extension (.txt), or they ship in the sitemap and llms.txt.
  for (const file of list(root, "scripts/**/*.{md,mdx}")) {
    problems.push({
      file,
      line: 1,
      message:
        "markdown under scripts/ is published as a docs page by tangly: use a non-page extension such as .txt",
    });
  }
  const writes = new Map<string, string>();
  const allTitles = new Map<string, string[]>();

  for (const page of pages.values()) {
    const kind = pageKind(model, page.file);
    let base = page.source;
    const marked = blocksOf(page.file, base, BLOCKS_BY_PAGE[kind]);
    const markerProblems = marked.problems;
    let blocks = marked.blocks;
    problems.push(...markerProblems);
    if (
      (kind === "term" || kind === "index") &&
      markerProblems.length === 0 &&
      !blocks.some((b) => b.kind === "glossary:jsonld")
    )
      problems.push({
        file: page.file,
        line: 1,
        message:
          "glossary page has no glossary:jsonld block (its DefinedTerm JSON-LD): add the start and end markers at the end of the page, then run `bun scripts/glossary.ts --write`",
      });
    // A rule page a term lists, in a category with rule_backlinks on, gets a
    // glossary:backlinks block at the end of its Related rules section.
    const missingBacklinks =
      kind === "rule" &&
      markerProblems.length === 0 &&
      !blocks.some((b) => b.kind === "glossary:backlinks") &&
      needsBacklinks(model, page.file);
    if (missingBacklinks) {
      const inserted = insertBacklinksBlock(base);
      if (!inserted)
        problems.push({
          file: page.file,
          line: 1,
          message:
            "rule page has no ## Related rules section, where its glossary:backlinks block goes: add one",
        });
      else {
        stale.push({
          file: page.file,
          line: inserted.line,
          message:
            "rule page has no glossary:backlinks block, and a term lists it: run `bun scripts/glossary.ts --write`",
        });
        base = inserted.source;
        blocks = blocksOf(page.file, base, BLOCKS_BY_PAGE[kind]).blocks;
      }
    }
    let next =
      markerProblems.length === 0 && blocks.length > 0
        ? applyBlocks(base, blocks, (k) => renderBlock(model, k, page.file))
        : base;
    // A just-inserted block is already reported as missing above; reporting it
    // again as out of date would say the same thing twice.
    if (next !== page.source && base === page.source) {
      for (const block of blocks) {
        const fresh = applyBlocks(page.source, [block], (k) =>
          renderBlock(model, k, page.file),
        );
        if (fresh !== page.source)
          stale.push({
            file: page.file,
            line: block.start + 1,
            message: `generated block ${block.kind} is out of date: run \`bun scripts/glossary.ts --write\``,
          });
      }
    }

    // Frontmatter that comes from the data files.
    let synced: Record<string, string> | null = null;
    const term = model.terms.get(
      /^glossary\/(.+)\.mdx$/.exec(page.file)?.[1] ?? "",
    );
    if (kind === "term") {
      if (!term)
        problems.push({
          file: page.file,
          line: 1,
          message: "glossary page has no term in terms.json",
        });
      else if (term.format === "entry")
        problems.push({
          file: page.file,
          line: 1,
          message: `term ${term.slug} is an index-only entry (format "entry"); make it "page" or remove this file`,
        });
      else synced = { title: term.title ?? "", sidebarTitle: term.term };
    }
    if (kind === "hub" && blocks.some((b) => b.kind.startsWith("hub:"))) {
      const hub = model.hubs.get(/^rules\/([^/]+)\//.exec(page.file)![1]!)!;
      synced = { title: hub.title, sidebarTitle: hub.sidebarTitle };
    }
    if (synced) {
      for (const [key, value] of Object.entries(synced)) {
        const field = page.frontmatter.get(key);
        if (field?.value !== value)
          stale.push({
            file: page.file,
            line: field?.line ?? 1,
            message: `frontmatter ${key} differs from the data file ("${value}"): run \`bun scripts/glossary.ts --write\``,
          });
      }
      next = setFrontmatter(next, synced);
    }
    if (next !== page.source) writes.set(page.file, next);

    // Guard 2: a hub links every rule in its category.
    if (kind === "hub") {
      const code = /^rules\/([^/]+)\//.exec(page.file)![1]!;
      const linked = rulesLinkedFrom(page.source, code);
      for (const rule of rulesOfHub(model, code))
        if (!linked.has(rule.id))
          problems.push({
            file: page.file,
            line: 1,
            message: `hub does not link rule ${rule.id}, whose **Category** is /rules/${code}`,
          });
    }
    // Guard 5: category hubs, i.e. every rules/<dir>/index.mdx but the overview pages.
    const dir = /^rules\/([^/]+)\/index\.mdx$/.exec(page.file)?.[1];
    if (dir && !OVERVIEW_DIRS.has(dir)) checkCategoryHub(page, problems);
    // Guard 6: copy rules on glossary and hub pages.
    if (kind === "index" || kind === "term" || kind === "hub")
      checkCopy(page, problems);
    // Guard 7: titles, across glossary and rules pages.
    const title = page.frontmatter.get("title")?.value;
    if (title) {
      const key = title.trim().toLowerCase();
      allTitles.set(key, [...(allTitles.get(key) ?? []), page.file]);
    }
  }

  for (const [, files] of allTitles)
    for (const file of files)
      if (files.length > 1)
        problems.push({
          file,
          line: pages.get(file)!.frontmatter.get("title")!.line,
          message: `same title as ${files.filter((f) => f !== file).join(", ")}`,
        });
  // A planned term page's title must not take an existing page's title.
  for (const term of model.data.terms) {
    if (!term.title || model.written.has(term.slug)) continue;
    const taken = allTitles.get(term.title.trim().toLowerCase());
    if (taken)
      problems.push({
        file: TERMS_FILE,
        line: lineOf(model.termsText, `"slug": "${term.slug}"`),
        message: `term ${term.slug}: title is already the title of ${taken.join(", ")}`,
      });
  }

  // Guard 3: the Glossary tab in docs.json.
  let docsConfig: Plan["docsConfig"] = null;
  const configText = read(root, "docs.json");
  if (configText !== null) {
    try {
      const config = JSON.parse(configText) as DocsConfig;
      const expected = `${JSON.stringify(withGlossaryTab(config, glossaryTab(model)), null, 2)}\n`;
      const current = `${JSON.stringify(config, null, 2)}\n`;
      docsConfig = { current, expected };
      if (expected !== current)
        stale.push({
          file: "docs.json",
          line: lineOf(configText, `"tab": "${GLOSSARY_TAB}"`),
          message: `the ${GLOSSARY_TAB} tab differs from the generated one: run \`bun scripts/glossary.ts --write\``,
        });
    } catch (e) {
      problems.push({
        file: "docs.json",
        line: 1,
        message: `invalid JSON: ${(e as Error).message}`,
      });
    }
  }

  // Neither generator inputs nor build-only components may be published.
  const ignore = read(root, ".tanglyignore") ?? "";
  const ignored = new Set(ignore.split("\n").map((line) => line.trim()));
  for (const [directory, reason] of [
    ["/scripts/", "the glossary data and scripts"],
    ["/components/", "the build-only components"],
  ])
    if (!ignored.has(directory))
      problems.push({
        file: ".tanglyignore",
        line: 1,
        message: `must list ${directory} so ${reason} are not published`,
      });

  return { model, problems, writes, stale, docsConfig };
}

function sortProblems(problems: Problem[]): Problem[] {
  return problems.sort(
    (a, b) =>
      cmp(a.file, b.file) || a.line - b.line || cmp(a.message, b.message),
  );
}

/** Drop baselined findings; report baseline entries that match nothing. */
function applyBaseline(
  problems: Problem[],
  baseline: BaselineEntry[],
): Problem[] {
  const used = new Set<BaselineEntry>();
  const kept = problems.filter((p) => {
    const entry = baseline.find(
      (b) => b.file === p.file && b.message === p.message,
    );
    if (entry) used.add(entry);
    return !entry;
  });
  for (const entry of baseline)
    if (!used.has(entry))
      kept.push({
        file: BASELINE_FILE,
        line: 1,
        message: `stale entry (${entry.file}: ${entry.message}): it no longer matches a finding, remove it`,
      });
  return kept;
}

export interface Coverage {
  covered: number;
  total: number;
  uncovered: string[];
  pagesWritten: number;
  pageTerms: number;
}

export interface CheckResult {
  problems: Problem[];
  coverage: Coverage;
}

/** Every guard, plus generated content that differs from `--write`. */
export function checkGlossary(root: string): CheckResult {
  const { model, problems, stale } = plan(root);
  const covered = new Set(model.data.terms.flatMap((t) => t.rules));
  const ids = [...model.rules.keys()].sort(cmp);
  return {
    problems: sortProblems(
      applyBaseline([...problems, ...stale], model.data.baseline),
    ),
    coverage: {
      covered: ids.filter((id) => covered.has(id)).length,
      total: ids.length,
      uncovered: ids.filter((id) => !covered.has(id)),
      pagesWritten: model.written.size,
      pageTerms: model.data.terms.filter((t) => t.format === "page").length,
    },
  };
}

/** Regenerate every block, the synced frontmatter and the Glossary tab. Returns the files it changed. */
export function writeGlossary(root: string): string[] {
  const { writes, docsConfig } = plan(root);
  const changed: string[] = [];
  for (const [file, source] of writes) {
    writeFileSync(join(root, file), source);
    changed.push(file);
  }
  // Only when the tab changes, so a docs.json formatted differently is left alone.
  if (docsConfig && docsConfig.expected !== docsConfig.current) {
    writeFileSync(join(root, "docs.json"), docsConfig.expected);
    changed.push("docs.json");
  }
  return changed.sort(cmp);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a === "--check" || a === "--write");
  const root =
    args.find((a) => !a.startsWith("--")) ??
    join(dirname(import.meta.path), "..");
  if (!mode) {
    console.error("usage: bun scripts/glossary.ts --check|--write [docs-root]");
    process.exit(2);
  }
  if (mode === "--write") {
    const changed = writeGlossary(root);
    console.log(
      changed.length > 0
        ? `Wrote ${changed.join(", ")}.`
        : "Glossary: nothing to write.",
    );
  }
  const { problems, coverage } = checkGlossary(root);
  console.log(
    `Glossary coverage: ${coverage.covered}/${coverage.total} rules linked from a term; ${coverage.pagesWritten}/${coverage.pageTerms} term pages written.`,
  );
  if (coverage.uncovered.length > 0)
    console.log(
      `Not linked from any term (not a failure): ${coverage.uncovered.join(", ")}`,
    );
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} glossary problem(s).`);
    process.exit(1);
  }
  console.log("Glossary, hubs and generated blocks: all good.");
}
