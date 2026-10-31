// Comparing two page maps (#701): which pages came, which went, and what changed on the ones that
// stayed. The use is checking a fix: "did the title rewrite land, did the 404 go away, did a page
// lose its schema". Pages are matched by URL.

import { csvField } from "./entities-export";
import { escapeMarkdownCell, escapeMarkdownText, markdownCodeSpan } from "./output/markdown-escape";
import { cleanText, csvSafeText, escapeJsonUnsafe, urlCell, type PageMapMeta, type PageMapRow } from "./page-map";

/** The fields a change is reported for. Counts that move with every crawl (links, word count, load time) are not among them. */
export const PAGE_MAP_DIFF_FIELDS = [
  "status",
  "finalUrl",
  "canonical",
  "noindex",
  "title",
  "description",
  "h1Count",
  "h1",
  "schemaTypes",
  "schemaIds",
  "flags",
] as const satisfies readonly (keyof PageMapRow)[];

export type PageMapDiffField = (typeof PAGE_MAP_DIFF_FIELDS)[number];

export interface PageMapChange {
  field: PageMapDiffField;
  before: string;
  after: string;
}

export interface PageMapDiff {
  /** On the newer audit only. */
  added: PageMapRow[];
  /** On the older audit only. */
  removed: PageMapRow[];
  /** On both, with at least one field that differs. */
  changed: Array<{ url: string; changes: PageMapChange[] }>;
  /** On both and identical in every compared field. */
  unchanged: number;
}

/** A field's value as a comparable, printable string; lists compare as sets. */
function show(row: PageMapRow, field: PageMapDiffField): string {
  const value = row[field];
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return [...value].sort().join(", ");
  return String(value);
}

/** Compare two page maps. Both lists come back sorted by URL. */
export function diffPageMaps(
  older: readonly PageMapRow[],
  newer: readonly PageMapRow[],
): PageMapDiff {
  const before = new Map(older.map((row) => [row.url, row]));
  const after = new Map(newer.map((row) => [row.url, row]));
  const byUrl = (a: { url: string }, b: { url: string }) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);

  const added = newer.filter((row) => !before.has(row.url)).sort(byUrl);
  const removed = older.filter((row) => !after.has(row.url)).sort(byUrl);
  const changed: PageMapDiff["changed"] = [];
  let unchanged = 0;
  for (const row of [...newer].sort(byUrl)) {
    const was = before.get(row.url);
    if (!was) continue;
    const changes: PageMapChange[] = [];
    for (const field of PAGE_MAP_DIFF_FIELDS) {
      const b = show(was, field);
      const a = show(row, field);
      if (b !== a) changes.push({ field, before: b, after: a });
    }
    if (changes.length > 0) changed.push({ url: row.url, changes });
    else unchanged++;
  }
  return { added, removed, changed, unchanged };
}

export interface PageMapDiffMeta {
  site: string;
  older: Pick<PageMapMeta, "crawlId" | "startedAt"> & { pages?: number };
  newer: Pick<PageMapMeta, "crawlId" | "startedAt"> & { pages?: number };
}

/**
 * A sentence when the two audits crawled clearly different numbers of pages (a quick audit against a
 * full one), because then pages come and go with the crawl's scope and not with the site. Null when
 * the counts are close or unknown.
 */
export function pageMapDiffScopeNote(meta: PageMapDiffMeta): string | null {
  const a = meta.older.pages;
  const b = meta.newer.pages;
  if (a === undefined || b === undefined || Math.max(a, b) === 0) return null;
  if (Math.abs(a - b) / Math.max(a, b) <= 0.2) return null;
  return `The audits crawled different numbers of pages (${a} and ${b}), so some pages below may be added or removed because of the crawl's scope, not a change to the site.`;
}

/** The diff as JSON: both audits, the counts, and the three lists. */
export function renderPageMapDiffJson(diff: PageMapDiff, meta: PageMapDiffMeta): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const note = pageMapDiffScopeNote(meta);
  return `${escapeJsonUnsafe(JSON.stringify(
    {
      site: meta.site,
      older: { crawlId: meta.older.crawlId, startedAt: iso(meta.older.startedAt) },
      newer: { crawlId: meta.newer.crawlId, startedAt: iso(meta.newer.startedAt) },
      ...(note ? { scopeNote: note } : {}),
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged,
      },
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    },
    null,
    2,
  ))}\n`;
}

/** A value from an audited page, as one short markdown-table-safe cell. */
function cell(value: string, max = 90): string {
  const flat = cleanText(value).replace(/\s+/g, " ").trim();
  return escapeMarkdownCell(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

/** The diff as markdown: counts, then one table per list. */
export function renderPageMapDiffMarkdown(diff: PageMapDiff, meta: PageMapDiffMeta): string {
  const id = (crawlId: string) => markdownCodeSpan(crawlId.slice(0, 8));
  const out = [`# Page map diff: ${escapeMarkdownText(cleanText(meta.site))}`, ""];
  out.push(
    `Audit ${id(meta.older.crawlId)} (${new Date(meta.older.startedAt).toISOString().slice(0, 10)}) to ${id(meta.newer.crawlId)} (${new Date(meta.newer.startedAt).toISOString().slice(0, 10)}): ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.unchanged} unchanged.`,
  );
  out.push("");
  const scope = pageMapDiffScopeNote(meta);
  if (scope) out.push(`> ${scope}`, "");
  if (diff.changed.length > 0) {
    out.push("## Changed", "", "| URL | Field | Before | After |", "|---|---|---|---|");
    for (const page of diff.changed) {
      for (const change of page.changes) {
        out.push(`| ${urlCell(page.url)} | ${change.field} | ${cell(change.before)} | ${cell(change.after)} |`);
      }
    }
    out.push("");
  }
  for (const [heading, rows] of [
    ["Added", diff.added],
    ["Removed", diff.removed],
  ] as const) {
    if (rows.length === 0) continue;
    out.push(`## ${heading}`, "", "| URL | Status | Title |", "|---|---|---|");
    for (const row of rows) out.push(`| ${urlCell(row.url)} | ${row.status} | ${cell(row.title ?? "")} |`);
    out.push("");
  }
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    out.push("No page was added, removed or changed.", "");
  }
  return `${out.join("\n")}`;
}

/** The diff as CSV: one row per change, and one per added or removed page. */
export function renderPageMapDiffCsv(diff: PageMapDiff): string {
  const line = (cols: (string | number)[]) =>
    cols.map((c) => csvField(typeof c === "string" ? csvSafeText(c) : c)).join(",");
  const lines = [line(["kind", "url", "field", "before", "after"])];
  for (const page of diff.changed) {
    for (const change of page.changes) lines.push(line(["changed", page.url, change.field, change.before, change.after]));
  }
  for (const row of diff.added) lines.push(line(["added", row.url, "", "", ""]));
  for (const row of diff.removed) lines.push(line(["removed", row.url, "", "", ""]));
  return `${lines.join("\n")}\n`;
}
