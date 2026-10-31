// The page map (#701): one row per crawled page of a stored audit, as a table.
//
// A failing-rule list only shows the pages that break a rule. This lists every page, so a
// site's titles, descriptions, links and schema can be read side by side. Everything in a row is
// already stored by the crawl (page features, the link graph, the pages themselves), so
// building it costs no request and no credit. The `flags` column comes from the audit's own
// rule results, so the table and the issue list agree.

import { csvRow } from "./entities-export";
import { escapeMarkdownCell, escapeMarkdownText, markdownCodeSpan } from "./output/markdown-escape";

/** One crawled page. Every field is data the crawl stored; nothing here reads the page again. */
export interface PageMapRow {
  /** The URL the crawl requested, as stored. */
  url: string;
  /** Where it was served from after redirects (`url` when it did not redirect). */
  finalUrl: string;
  status: number;
  /** Clicks from the start URL. */
  depth: number;
  canonical: string | null;
  /** The page asks not to be indexed (meta robots or X-Robots-Tag). */
  noindex: boolean;
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  /** Number of `<h1>` elements; null when the crawl stored none for the page. */
  h1Count: number | null;
  wordCount: number | null;
  /** schema.org `@type`s declared on the page. */
  schemaTypes: string[];
  /** Distinct crawled pages linking here (self links excluded). */
  inlinks: number;
  internalOutlinks: number;
  externalOutlinks: number;
  /** Hosts the external links point at, sorted. */
  externalDomains: string[];
  loadTimeMs: number | null;
  lastModified: string | null;
  /** Rule results that fired on the page, as {@link PAGE_MAP_FLAG_RULES} names them, plus `no-schema` and `noindex`. */
  flags: string[];
}

/**
 * Rules whose failures and warnings become a flag, by flag name. The names are what
 * `--duplicate` and `--orphan` filter on, and each rule is read from the audit's own results.
 */
export const PAGE_MAP_FLAG_RULES: Readonly<Record<string, string>> = {
  "core/meta-title": "title",
  "core/meta-description": "description",
  "core/h1": "h1",
  "core/title-unique": "title-not-unique",
  "content/duplicate-title": "duplicate-title",
  "content/duplicate-description": "duplicate-description",
  "links/orphan-pages": "orphan",
  "core/canonical": "canonical",
  "core/robots-meta": "robots",
  "content/word-count": "thin-content",
};

/** The rule ids {@link PAGE_MAP_FLAG_RULES} reads. */
export const PAGE_MAP_RULE_IDS: readonly string[] = Object.keys(PAGE_MAP_FLAG_RULES);

/**
 * Where `--too-long` draws the line: the defaults of `core/meta-title` (`max_length` 75) and
 * `core/meta-description` (`max_length` 160). A site that changed them in its config sees the
 * rule's flag for its own limits in `flags`.
 */
export const PAGE_MAP_TOO_LONG = { title: 75, description: 160 } as const;

export const PAGE_MAP_MISSING = ["title", "description", "h1", "schema"] as const;
export type PageMapMissing = (typeof PAGE_MAP_MISSING)[number];
export const PAGE_MAP_DUPLICATE = ["title", "description"] as const;
export type PageMapDuplicate = (typeof PAGE_MAP_DUPLICATE)[number];

export interface PageMapFilters {
  missing?: readonly PageMapMissing[];
  duplicate?: readonly PageMapDuplicate[];
  tooLong?: boolean;
  orphan?: boolean;
  /** URL path prefix, `/blog`. */
  section?: string;
  /** Substring of the URL. Any of several matches. */
  page?: readonly string[];
}

export function hasPageMapFilters(filters: PageMapFilters): boolean {
  return Boolean(
    filters.missing?.length ||
      filters.duplicate?.length ||
      filters.tooLong ||
      filters.orphan ||
      filters.section ||
      filters.page?.length,
  );
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

/** Whether `path` is `section` or under it (`/blog` matches `/blog` and `/blog/a`, not `/blogger`). */
function inSection(path: string, section: string): boolean {
  const base = section.startsWith("/") ? section : `/${section}`;
  const trimmed = base.length > 1 ? base.replace(/\/+$/, "") : base;
  return trimmed === "/" || path === trimmed || path.startsWith(`${trimmed}/`);
}

/**
 * Rows that match every filter group. Within `missing`, `duplicate` and `page`, any value
 * matches; across groups, all must. `--duplicate` and `--orphan` read the flags the audit's
 * own rules set, so they select exactly the pages the issue list names.
 */
export function filterPageMap(rows: readonly PageMapRow[], filters: PageMapFilters): PageMapRow[] {
  return rows.filter((row) => {
    if (filters.missing?.length) {
      const hit = filters.missing.some((field) => {
        switch (field) {
          case "title":
            return !row.title?.trim();
          case "description":
            return !row.description?.trim();
          case "h1":
            return row.h1Count === 0;
          case "schema":
            return row.schemaTypes.length === 0;
        }
      });
      if (!hit) return false;
    }
    if (filters.duplicate?.length) {
      if (!filters.duplicate.some((field) => row.flags.includes(`duplicate-${field}`))) return false;
    }
    if (filters.tooLong) {
      if (
        row.titleLength <= PAGE_MAP_TOO_LONG.title &&
        row.descriptionLength <= PAGE_MAP_TOO_LONG.description
      ) {
        return false;
      }
    }
    if (filters.orphan && !row.flags.includes("orphan")) return false;
    if (filters.section && !inSection(pathOf(row.url), filters.section)) return false;
    if (filters.page?.length && !filters.page.some((text) => row.url.includes(text))) return false;
    return true;
  });
}

/** The columns of the CSV, in order. */
export const PAGE_MAP_COLUMNS = [
  "url",
  "finalUrl",
  "status",
  "depth",
  "canonical",
  "noindex",
  "title",
  "titleLength",
  "description",
  "descriptionLength",
  "h1Count",
  "wordCount",
  "schemaTypes",
  "inlinks",
  "internalOutlinks",
  "externalOutlinks",
  "externalDomains",
  "loadTimeMs",
  "lastModified",
  "flags",
] as const satisfies readonly (keyof PageMapRow)[];

export interface PageMapMeta {
  /** The audited site. */
  site: string;
  crawlId: string;
  startedAt: number;
  /** Pages in the audit, before any filter. */
  total: number;
}

/** The audit that produced a map, as {@link PageMapMeta}. */
export function pageMapMeta(crawl: { id: string; baseUrl: string; startedAt: number }, total: number): PageMapMeta {
  return { site: crawl.baseUrl, crawlId: crawl.id, startedAt: crawl.startedAt, total };
}

export function renderPageMapJson(rows: readonly PageMapRow[], meta: PageMapMeta): string {
  return `${JSON.stringify(
    { site: meta.site, crawlId: meta.crawlId, startedAt: new Date(meta.startedAt).toISOString(), total: meta.total, filtered: rows.length, pages: rows },
    null,
    2,
  )}\n`;
}

/** One RFC 4180 table with a header row. List cells join with a space; every cell is spreadsheet-safe. */
export function renderPageMapCsv(rows: readonly PageMapRow[]): string {
  const lines = [csvRow([...PAGE_MAP_COLUMNS])];
  for (const row of rows) {
    lines.push(
      csvRow(
        PAGE_MAP_COLUMNS.map((column) => {
          const value = row[column];
          return Array.isArray(value) ? value.join(" ") : value;
        }),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A cell of prose from an audited page: markdown-escaped, one line, cut at `max` characters. */
function cell(value: string | null | undefined, max = 80): string {
  if (!value) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return escapeMarkdownCell(cut);
}

/** The pages as a markdown table: the columns a person scans, the rest in the JSON and CSV. */
export function renderPageMapMarkdown(rows: readonly PageMapRow[], meta: PageMapMeta): string {
  const out = [`# Page map: ${escapeMarkdownText(meta.site)}`, ""];
  out.push(
    rows.length === meta.total
      ? `${meta.total} pages, from audit ${markdownCodeSpan(meta.crawlId.slice(0, 8))}.`
      : `${rows.length} of ${meta.total} pages match, from audit ${markdownCodeSpan(meta.crawlId.slice(0, 8))}.`,
  );
  out.push("");
  out.push("| URL | Status | Title | Len | Description | Len | H1 | Words | Schema | In | Out | Flags |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    out.push(
      `| ${markdownCodeSpan(row.url)} | ${row.status} | ${cell(row.title)} | ${row.titleLength} | ${cell(row.description)} | ${row.descriptionLength} | ${row.h1Count ?? ""} | ${row.wordCount ?? ""} | ${cell(row.schemaTypes.join(", "), 40)} | ${row.inlinks} | ${row.internalOutlinks} | ${cell(row.flags.join(", "), 60)} |`,
    );
  }
  return `${out.join("\n")}\n`;
}
