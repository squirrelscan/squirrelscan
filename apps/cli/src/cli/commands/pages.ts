// `squirrel pages` (#701): the pages of a stored audit as a table.
//
// Shaped like `squirrel entities`: the same project-scoped store access, `--crawl`, `-f` and `-o`.
// Every column is data the crawl already stored, so it fetches nothing and costs no credit. Exit
// code is 0 on every path that is an answer (no audit yet, no page matches); only a usage mistake
// or an unreadable store exits 1.

import {
  PAGE_MAP_DUPLICATE,
  PAGE_MAP_MISSING,
  cleanText,
  diffPageMaps,
  filterPageMap,
  hasPageMapFilters,
  pageMapMeta,
  renderPageMapCsv,
  renderPageMapDiffCsv,
  renderPageMapDiffJson,
  renderPageMapDiffMarkdown,
  renderPageMapHtml,
  renderPageMapJson,
  renderPageMapMarkdown,
  type PageMapDuplicate,
  type PageMapFilters,
  type PageMapMissing,
  type PageMapRow,
} from "@squirrelscan/report";
import { defineCommand } from "citty";
import { writeFileSync } from "node:fs";

import { loadPageMap, loadPageMapPair } from "@/controllers/pages";
import { ErrorCodes } from "@/controllers/types";
import { splitListFlag } from "@/entities/filters";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";

import { fmt } from "../format";

/** Every `-f` value this command accepts. */
export const PAGES_FORMATS = ["json", "csv", "markdown", "html"] as const;
export type PagesFormat = (typeof PAGES_FORMATS)[number];

export function isPagesFormat(value: string): value is PagesFormat {
  return (PAGES_FORMATS as readonly string[]).includes(value);
}

/** `--diff` formats: prose, a change set a CI job can parse, or a sheet. */
const DIFF_FORMATS = ["markdown", "json", "csv"] as const;

/** Rows the console table prints before pointing at the file formats. */
const CONSOLE_ROWS = 50;

/** Terminal colour sequences, stripped on the way to a file (see `squirrel entities`). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function emit(content: string, outputPath: string | undefined): void {
  if (outputPath) {
    try {
      writeFileSync(outputPath, content.replace(ANSI, ""));
    } catch (error) {
      // A bad path is a usage mistake, not a crash: name the path and the reason.
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Could not write ${outputPath}: ${reason}`);
      safeExit(1);
      return;
    }
    console.error(`Wrote ${outputPath}`);
    return;
  }
  process.stdout.write(content);
}

/** The path and query of a page URL as one terminal-safe string: every value here comes from the audited site. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return cleanText(`${parsed.pathname}${parsed.search}`);
  } catch {
    return cleanText(url);
  }
}

function clip(value: string, width: number): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/** The console view: path, status, title and description length, links, flags. */
export function printTable(
  rows: readonly PageMapRow[],
  total: number,
  label: string
): void {
  console.log("");
  console.log(fmt.bold("PAGES"));
  console.log(fmt.dim(cleanText(label)));
  console.log("");
  const shown = rows.slice(0, CONSOLE_ROWS);
  const pathWidth = Math.min(
    48,
    Math.max(4, ...shown.map((row) => pathOf(row.url).length))
  );
  console.log(
    fmt.dim(`${"URL".padEnd(pathWidth)}  STATUS  TITLE  DESC  IN  OUT  FLAGS`)
  );
  for (const row of shown) {
    console.log(
      `${clip(pathOf(row.url), pathWidth).padEnd(pathWidth)}  ${String(row.status).padEnd(6)}  ${String(row.titleLength).padEnd(5)}  ${String(row.descriptionLength).padEnd(4)}  ${String(row.inlinks).padEnd(2)}  ${String(row.internalOutlinks).padEnd(3)}  ${row.flags.join(", ")}`
    );
  }
  console.log("");
  const more = rows.length - shown.length;
  console.log(
    fmt.dim(
      rows.length === total
        ? `${total} pages.`
        : `${rows.length} of ${total} pages match.`
    ) +
      (more > 0
        ? fmt.dim(
            ` ${more} more not shown: use -f csv, -f json or -f markdown for all of them.`
          )
        : "")
  );
}

export const pages = defineCommand({
  meta: {
    name: "pages",
    description:
      "List the pages of a stored audit with their titles, descriptions, links and flags",
  },
  args: {
    crawl: {
      type: "string",
      description:
        "Crawl ID (or 8-char prefix) to read (defaults to the latest audit); repeat twice with --diff",
    },
    diff: {
      type: "boolean",
      description:
        "Compare two audits of the site: pages added, removed and changed (the previous and latest by default)",
    },
    format: {
      type: "string",
      alias: "f",
      description: `Output format: ${PAGES_FORMATS.join(", ")} (default: a console table, or markdown when piped)`,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Write to a file instead of stdout",
    },
    missing: {
      type: "string",
      description: `Only pages missing: ${PAGE_MAP_MISSING.join(", ")} (repeatable or comma-separated)`,
    },
    duplicate: {
      type: "string",
      description: `Only pages the audit flags as duplicate: ${PAGE_MAP_DUPLICATE.join(", ")} (repeatable or comma-separated)`,
    },
    "too-long": {
      type: "boolean",
      description:
        "Only pages with a title over 75 or a description over 160 characters",
    },
    orphan: {
      type: "boolean",
      description:
        "Only pages the audit flags as orphans (fewer internal links to them than the orphan rule's minimum, 2 by default; nothing is flagged on a crawl the rule skipped)",
    },
    section: {
      type: "string",
      description: "Only pages under this URL path, e.g. /blog",
    },
    page: {
      type: "string",
      description: "Only pages whose URL contains this text (repeatable)",
    },
  },
  async run({ args }) {
    warnIfSessionUnreadable();

    const filters: PageMapFilters = {};
    const missing = splitListFlag(
      args.missing as string | string[] | undefined
    );
    const unknownMissing = missing.filter(
      (value) => !(PAGE_MAP_MISSING as readonly string[]).includes(value)
    );
    if (unknownMissing.length > 0) {
      console.error(
        `--missing: unknown value ${unknownMissing.join(", ")} (expected ${PAGE_MAP_MISSING.join(", ")})`
      );
      return safeExit(1);
    }
    if (missing.length > 0) filters.missing = missing as PageMapMissing[];

    const duplicate = splitListFlag(
      args.duplicate as string | string[] | undefined
    );
    const unknownDuplicate = duplicate.filter(
      (value) => !(PAGE_MAP_DUPLICATE as readonly string[]).includes(value)
    );
    if (unknownDuplicate.length > 0) {
      console.error(
        `--duplicate: unknown value ${unknownDuplicate.join(", ")} (expected ${PAGE_MAP_DUPLICATE.join(", ")})`
      );
      return safeExit(1);
    }
    if (duplicate.length > 0)
      filters.duplicate = duplicate as PageMapDuplicate[];

    if (args["too-long"]) filters.tooLong = true;
    if (args.orphan) filters.orphan = true;
    if (typeof args.section === "string" && args.section.length > 0) {
      filters.section = args.section;
    }
    const pageText = splitListFlag(args.page as string | string[] | undefined);
    if (pageText.length > 0) filters.page = pageText;

    if (args.format !== undefined && !isPagesFormat(args.format)) {
      console.error(
        `--format: unknown value "${args.format}" (expected ${PAGES_FORMATS.join(", ")})`
      );
      return safeExit(1);
    }

    // ── --diff ───────────────────────────────────────────────────────
    if (args.diff) {
      const diffFormat = args.format ?? "markdown";
      if (!(DIFF_FORMATS as readonly string[]).includes(diffFormat)) {
        console.error(
          `--diff supports ${DIFF_FORMATS.join(", ")}, got --format ${diffFormat}`
        );
        return safeExit(1);
      }
      if (
        filters.missing ||
        filters.duplicate ||
        filters.tooLong ||
        filters.orphan
      ) {
        // A filter on what a page IS breaks exactly the transitions a diff exists to show: a
        // page whose title was fixed stops matching --missing title on the newer side, so the
        // older row would be reported as removed.
        console.error(
          "--missing, --duplicate, --too-long and --orphan cannot be combined with --diff: they select on the state a diff compares, so a fixed page would be reported as removed. Use --section or --page instead."
        );
        return safeExit(1);
      }
      const ids = splitListFlag(args.crawl as string | string[] | undefined);
      const pair = await loadPageMapPair(ids);
      if (!pair.ok) {
        if (pair.error.code === ErrorCodes.CRAWL_NOT_FOUND) {
          console.log(pair.error.message);
          return;
        }
        console.error(pair.error.message);
        return safeExit(1);
      }
      for (const warning of pair.data.warnings) {
        console.error(
          `Warning: a project store could not be read (${warning})`
        );
      }
      const scoped = (rows: readonly PageMapRow[]) =>
        hasPageMapFilters(filters) ? filterPageMap(rows, filters) : rows;
      const { older, newer } = pair.data;
      const result = diffPageMaps(scoped(older.rows), scoped(newer.rows));
      const diffMeta = {
        site: newer.crawl.baseUrl,
        older: { crawlId: older.crawl.id, startedAt: older.crawl.startedAt },
        newer: { crawlId: newer.crawl.id, startedAt: newer.crawl.startedAt },
      };
      emit(
        diffFormat === "json"
          ? renderPageMapDiffJson(result, diffMeta)
          : diffFormat === "csv"
            ? renderPageMapDiffCsv(result)
            : renderPageMapDiffMarkdown(result, diffMeta),
        args.output
      );
      return;
    }


    const crawlIds = splitListFlag(args.crawl as string | string[] | undefined);
    if (crawlIds.length > 1) {
      console.error("--crawl takes one audit, or two with --diff");
      return safeExit(1);
    }
    const loaded = await loadPageMap(crawlIds[0]);
    if (!loaded.ok) {
      // Nothing stored is an ANSWER; a store that could not be read is a FAILURE.
      if (loaded.error.code === ErrorCodes.CRAWL_NOT_FOUND) {
        console.log(loaded.error.message);
        return;
      }
      console.error(loaded.error.message);
      return safeExit(1);
    }
    for (const warning of loaded.data.warnings) {
      console.error(`Warning: a project store could not be read (${warning})`);
    }

    const { crawl } = loaded.data;
    const all = loaded.data.rows;
    const rows = hasPageMapFilters(filters) ? filterPageMap(all, filters) : all;
    const meta = pageMapMeta(crawl, all.length);

    const format: PagesFormat | undefined = args.format as
      | PagesFormat
      | undefined;
    if (format) {
      emit(
        format === "json"
          ? renderPageMapJson(rows, meta)
          : format === "csv"
            ? renderPageMapCsv(rows)
            : format === "html"
              ? renderPageMapHtml(rows, meta)
              : renderPageMapMarkdown(rows, meta),
        args.output
      );
      return;
    }
    if (args.output || !process.stdout.isTTY) {
      emit(renderPageMapMarkdown(rows, meta), args.output);
      return;
    }
    printTable(
      rows,
      all.length,
      `${crawl.baseUrl} · ${crawl.id.slice(0, 8)} · ${new Date(crawl.startedAt).toLocaleString()}`
    );
  },
});
