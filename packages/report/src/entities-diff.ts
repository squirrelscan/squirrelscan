// Markdown rendering for the entity-map change set (#2092).
//
// Shared by `squirrel entities --diff` and, later, the cloud history view, so
// the two describe a change the same way.
//
// The section that earns its place is "not crawled". Every other list is a
// difference between two sets; that one is the reason the reader can trust the
// rest, because it is where an entity goes when the newer audit simply did not
// visit the pages that declared it. Without it, a smaller crawl reads as the
// site having deleted its structured data.

import type { EntityMapDiff } from "./types";
import { entityCell } from "./entities";

/** Rows listed per section before the renderer says "and N more". */
export const ENTITY_DIFF_ROW_LIMIT = 25;

/** Page URLs listed per side before the renderer says "and N more". */
export const ENTITY_DIFF_PAGE_LIMIT = 10;

function tail(shown: number, total: number, noun: string): string[] {
  return total > shown ? ["", `…and ${total - shown} more ${noun}.`] : [];
}

function label(name: string | null, types: string[]): string {
  return entityCell(name ?? `(unnamed ${types[0] ?? "entity"})`);
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

/** True when nothing at all changed between the two maps. */
export function entityDiffIsEmpty(diff: EntityMapDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.notCrawled.length === 0 &&
    diff.gainedId.length === 0 &&
    diff.lostId.length === 0 &&
    diff.occurrenceDeltas.length === 0 &&
    diff.newConflicts.length === 0 &&
    diff.resolvedConflicts.length === 0 &&
    diff.newDangling.length === 0 &&
    diff.resolvedDangling.length === 0
  );
}

function nodeTable(
  heading: string,
  blurb: string,
  rows: EntityMapDiff["added"],
): string[] {
  const lines = [`## ${heading} (${rows.length})`, ""];
  if (rows.length === 0) return [...lines, "None.", ""];
  lines.push(blurb, "", "| Type | Name | @id | Occurrences |", "| --- | --- | --- | ---: |");
  for (const row of rows.slice(0, ENTITY_DIFF_ROW_LIMIT)) {
    lines.push(
      `| ${entityCell(row.types.join(", "))} | ${label(row.name, row.types)} | ${entityCell(row.id) || "_none_"} | ${row.occurrences} |`,
    );
  }
  lines.push(...tail(Math.min(rows.length, ENTITY_DIFF_ROW_LIMIT), rows.length, "entities"), "");
  return lines;
}

/**
 * Render an entity-map change set as markdown.
 *
 * Deterministic for a given diff: every list arrives sorted, and `generatedAt`
 * is the only varying input.
 */
export function renderEntityDiffMarkdown(diff: EntityMapDiff): string {
  const lines: string[] = ["# Entity map changes", ""];

  lines.push(
    `**Site:** ${entityCell(diff.newer.site)}  `,
    `**From:** ${diff.older.generatedAt} (${diff.older.nodeCount} entities, ${diff.older.pagesTotal} pages)  `,
    `**To:** ${diff.newer.generatedAt} (${diff.newer.nodeCount} entities, ${diff.newer.pagesTotal} pages)`,
    "",
  );

  if (entityDiffIsEmpty(diff)) {
    lines.push("No entity changed between these two audits.", "");
    return `${lines.join("\n")}\n`;
  }

  // Headline first: the counts a reader scans before deciding to read on.
  lines.push(
    "| Change | Count |",
    "| --- | ---: |",
    `| Added | ${diff.added.length} |`,
    `| Removed | ${diff.removed.length} |`,
    `| Not crawled again | ${diff.notCrawled.length} |`,
    `| Gained an @id | ${diff.gainedId.length} |`,
    `| Lost an @id | ${diff.lostId.length} |`,
    `| Occurrence changes | ${diff.occurrenceDeltas.length} |`,
    `| New conflicts | ${diff.newConflicts.length} |`,
    `| Resolved conflicts | ${diff.resolvedConflicts.length} |`,
    `| New dangling refs | ${diff.newDangling.length} |`,
    `| Resolved dangling refs | ${diff.resolvedDangling.length} |`,
    "",
  );

  lines.push(...nodeTable("Added", "Declared in the newer audit and not the older one.", diff.added));
  lines.push(
    ...nodeTable(
      "Removed",
      "Gone from the newer audit, and every page that declared them WAS crawled again — so this is a real removal, not a coverage gap.",
      diff.removed,
    ),
  );
  lines.push(
    ...nodeTable(
      "Not crawled again",
      "Absent from the newer audit, but at least one page that declared them was not visited. These are NOT removals: re-audit those pages before treating them as one.",
      diff.notCrawled,
    ),
  );

  // The identity fix, and its regression.
  lines.push(`## Gained an @id (${diff.gainedId.length})`, "");
  if (diff.gainedId.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "These entities now carry a stable `@id`, so a search engine can reconcile them across pages.",
      "",
      "| Type | Name | New @id |",
      "| --- | --- | --- |",
    );
    for (const row of diff.gainedId.slice(0, ENTITY_DIFF_ROW_LIMIT)) {
      lines.push(
        `| ${entityCell(row.types.join(", "))} | ${label(row.name, row.types)} | ${entityCell(row.id)} |`,
      );
    }
    lines.push(
      ...tail(Math.min(diff.gainedId.length, ENTITY_DIFF_ROW_LIMIT), diff.gainedId.length, "entities"),
      "",
    );
  }

  lines.push(`## Lost an @id (${diff.lostId.length})`, "");
  if (diff.lostId.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "These entities no longer carry the `@id` they had. A search engine can no longer tell they are the same thing across pages.",
      "",
      "| Type | Name | Former @id |",
      "| --- | --- | --- |",
    );
    for (const row of diff.lostId.slice(0, ENTITY_DIFF_ROW_LIMIT)) {
      lines.push(
        `| ${entityCell(row.types.join(", "))} | ${label(row.name, row.types)} | ${entityCell(row.id)} |`,
      );
    }
    lines.push(
      ...tail(Math.min(diff.lostId.length, ENTITY_DIFF_ROW_LIMIT), diff.lostId.length, "entities"),
      "",
    );
  }

  lines.push(`## Occurrence changes (${diff.occurrenceDeltas.length})`, "");
  if (diff.occurrenceDeltas.length === 0) {
    lines.push("No entity is declared more or less often than before.", "");
  } else {
    lines.push("| Type | Name | Before | After | Change |", "| --- | --- | ---: | ---: | ---: |");
    for (const row of diff.occurrenceDeltas.slice(0, ENTITY_DIFF_ROW_LIMIT)) {
      lines.push(
        `| ${entityCell(row.types.join(", "))} | ${label(row.name, row.types)} | ${row.before} | ${row.after} | ${signed(row.delta)} |`,
      );
    }
    lines.push(
      ...tail(
        Math.min(diff.occurrenceDeltas.length, ENTITY_DIFF_ROW_LIMIT),
        diff.occurrenceDeltas.length,
        "entities",
      ),
      "",
    );
  }

  for (const [heading, rows, blurb] of [
    ["New conflicts", diff.newConflicts, "These entities now disagree with themselves across pages."],
    ["Resolved conflicts", diff.resolvedConflicts, "These entities now agree with themselves."],
  ] as const) {
    lines.push(`## ${heading} (${rows.length})`, "");
    if (rows.length === 0) {
      lines.push("None.", "");
      continue;
    }
    lines.push(blurb, "", "| Entity | Property |", "| --- | --- |");
    for (const row of rows.slice(0, ENTITY_DIFF_ROW_LIMIT)) {
      lines.push(`| ${entityCell(row.name ?? row.key)} | \`${entityCell(row.property)}\` |`);
    }
    lines.push(...tail(Math.min(rows.length, ENTITY_DIFF_ROW_LIMIT), rows.length, "conflicts"), "");
  }

  for (const [heading, rows, blurb] of [
    [
      "New dangling references",
      diff.newDangling,
      "These reference an entity by `@id` that no crawled page declares.",
    ],
    ["Resolved dangling references", diff.resolvedDangling, "These now point at something real."],
  ] as const) {
    lines.push(`## ${heading} (${rows.length})`, "");
    if (rows.length === 0) {
      lines.push("None.", "");
      continue;
    }
    lines.push(blurb, "", "| Source | Predicate | Target |", "| --- | --- | --- |");
    for (const row of rows.slice(0, ENTITY_DIFF_ROW_LIMIT)) {
      const target = row.target.startsWith("id:") ? row.target.slice(3) : row.target;
      lines.push(
        `| ${entityCell(row.source)} | ${entityCell(row.predicate)} | ${entityCell(target)} |`,
      );
    }
    lines.push(...tail(Math.min(rows.length, ENTITY_DIFF_ROW_LIMIT), rows.length, "references"), "");
  }

  // Coverage last, because it qualifies everything above it.
  const changedPages = diff.pagesOnlyInOlder.length + diff.pagesOnlyInNewer.length;
  lines.push(`## Crawl coverage (${changedPages})`, "");
  if (changedPages === 0) {
    lines.push("Both audits covered exactly the same pages.", "");
  } else {
    lines.push(
      "The two audits did not cover the same pages, so read the lists above with that in mind.",
      "",
    );
    if (diff.pagesOnlyInOlder.length > 0) {
      lines.push(`**Only in the older audit (${diff.pagesOnlyInOlder.length}):**`, "");
      for (const url of diff.pagesOnlyInOlder.slice(0, ENTITY_DIFF_PAGE_LIMIT)) {
        lines.push(`- ${entityCell(url)}`);
      }
      lines.push(
        ...tail(
          Math.min(diff.pagesOnlyInOlder.length, ENTITY_DIFF_PAGE_LIMIT),
          diff.pagesOnlyInOlder.length,
          "pages",
        ),
        "",
      );
    }
    if (diff.pagesOnlyInNewer.length > 0) {
      lines.push(`**Only in the newer audit (${diff.pagesOnlyInNewer.length}):**`, "");
      for (const url of diff.pagesOnlyInNewer.slice(0, ENTITY_DIFF_PAGE_LIMIT)) {
        lines.push(`- ${entityCell(url)}`);
      }
      lines.push(
        ...tail(
          Math.min(diff.pagesOnlyInNewer.length, ENTITY_DIFF_PAGE_LIMIT),
          diff.pagesOnlyInNewer.length,
          "pages",
        ),
        "",
      );
    }
  }

  // Every summary metric, so a reader can see a movement no list above names.
  const metrics = Object.entries(diff.summaryDelta).filter(([, m]) => m.delta !== 0);
  lines.push(`## Summary changes (${metrics.length})`, "");
  if (metrics.length === 0) {
    lines.push("No summary metric moved.", "");
  } else {
    lines.push("| Metric | Before | After | Change |", "| --- | ---: | ---: | ---: |");
    for (const [name, m] of metrics) {
      const before = Number.isInteger(m.before) ? m.before : m.before.toFixed(3);
      const after = Number.isInteger(m.after) ? m.after : m.after.toFixed(3);
      const delta = Number.isInteger(m.delta) ? signed(m.delta) : signed(Number(m.delta.toFixed(3)));
      lines.push(`| ${entityCell(name)} | ${before} | ${after} | ${delta} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
