// Shared helpers for the report-only Entities section (#2091), across all six
// output formats.
//
// The entity map is the site's own JSON-LD collapsed into one graph. Like
// Technologies it is informational: it NEVER affects the health score. Every
// format reads its rows from here so the console, markdown, llm, html, json and
// xml views can never disagree about what the map said.
//
// Names, ids and property values come from audited pages, so every string here
// is untrusted. This module only selects and counts; escaping belongs to each
// renderer.

import type { EntityMap, EntityMapEdge, EntityMapNode } from "./types";

/** Entities listed in a format's entity table. */
export const ENTITY_TABLE_LIMIT = 25;

/** Entities named in the console block, which has one screen to work with. */
export const ENTITY_CONSOLE_LIMIT = 3;

/** Rows listed per findings list before a format says "and N more". */
export const ENTITY_FINDING_LIMIT = 10;

/** Stable, locale-independent ordering. `localeCompare` is not portable. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total pages an entity was declared on, including any past the node's cap. */
export function entityPageTotal(node: EntityMapNode): number {
  return node.pages.length + node.morePages;
}

/** What to call an entity that never declared a name. */
export function entityLabel(node: EntityMapNode): string {
  return node.name ?? `(unnamed ${node.types[0] ?? "entity"})`;
}

/**
 * Entities by reach, most-declared first.
 *
 * The map itself is sorted by key so it stays byte-stable; every format wants
 * the busiest entities instead, and ties break on key so this ordering is just
 * as deterministic.
 */
export function entitiesByReach(map: EntityMap): EntityMapNode[] {
  return [...map.nodes].sort(
    (a, b) => b.occurrences - a.occurrences || byString(a.key, b.key),
  );
}

/**
 * The entities worth leading with: the site's subject matter, not its page
 * furniture. Falls back to the full list when a site declares nothing else, so
 * a docs site whose only markup is BreadcrumbList still shows something.
 */
export function primaryEntities(map: EntityMap): EntityMapNode[] {
  const ranked = entitiesByReach(map);
  const subject = ranked.filter((node) => !node.pageLocal);
  return subject.length > 0 ? subject : ranked;
}

/** Entities that disagree with themselves across pages, widest first. */
export function conflictedEntities(map: EntityMap): EntityMapNode[] {
  return entitiesByReach(map).filter((node) => node.conflicts.length > 0);
}

/** `@id` references no crawled page declares, most-referenced first. */
export function danglingEdges(map: EntityMap): EntityMapEdge[] {
  return map.edges
    .filter((edge) => edge.dangling)
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        byString(a.target, b.target) ||
        byString(a.predicate, b.predicate),
    );
}

/**
 * Entities declared on more than one page with no `@id`.
 *
 * The headline finding: a search engine has no way to tell these are one thing.
 * A single-page entity without an `@id` is ordinary and is not listed.
 */
export function entitiesWithoutId(map: EntityMap): EntityMapNode[] {
  return entitiesByReach(map).filter(
    (node) => node.id === null && entityPageTotal(node) > 1,
  );
}

/** The `@id` a dangling edge pointed at, with the map's key prefix removed. */
export function danglingTargetId(edge: EntityMapEdge): string {
  return edge.target.startsWith("id:") ? edge.target.slice(3) : edge.target;
}

/** `@type` counts, most-declared first. */
export function typeCounts(map: EntityMap): { type: string; count: number }[] {
  return Object.entries(map.summary.countsByType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || byString(a.type, b.type));
}

/** `stableIdShare` as a whole percentage, for display. */
export function stableIdPercent(map: EntityMap): number {
  return Math.round(map.summary.stableIdShare * 100);
}

/**
 * A one-line summary every format can open its section with.
 *
 * Reads the summary's own counters rather than recomputing from the node array,
 * so a map clipped for publishing still reports what the site really declared.
 */
export function entitySummaryLine(map: EntityMap): string {
  const s = map.summary;
  const parts = [
    `${s.nodeCount} ${s.nodeCount === 1 ? "entity" : "entities"}`,
    `${s.edgeCount} reference${s.edgeCount === 1 ? "" : "s"}`,
    `${stableIdPercent(map)}% with a stable @id`,
  ];
  if (s.conflictCount > 0) parts.push(`${s.conflictCount} conflicting`);
  if (s.danglingCount > 0) parts.push(`${s.danglingCount} dangling`);
  return parts.join(" · ");
}

/**
 * True when a report has a map worth rendering.
 *
 * A site that declares no JSON-LD still gets a map, and every format says so in
 * one line rather than printing empty tables.
 */
export function hasEntityMap(map: EntityMap | undefined): map is EntityMap {
  return map !== undefined;
}

/** The sentence a format prints when the site declared no JSON-LD at all. */
export const ENTITY_EMPTY_MESSAGE =
  "This site declares no JSON-LD entities, so search engines have nothing to reconcile it into.";

// ── Markdown section ───────────────────────────────────────────────

/** Longest markdown cell before an ellipsis, so a table stays terminal-readable. */
const MAX_CELL = 90;

/**
 * Make a value safe for a markdown table cell.
 *
 * Clip BEFORE escaping: clipping afterwards can cut an escape pair in half and
 * leave a trailing lone backslash, which would escape the cell's own closing
 * pipe. And escape the backslash BEFORE the pipe, or a site's literal `\|`
 * becomes `\\|`, which markdown reads as an escaped backslash followed by a
 * LIVE pipe and the row gains a column.
 */
export function entityCell(value: string | null | undefined): string {
  if (!value) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  const clipped = flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
  return clipped.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function tail(shown: number, total: number, noun: string): string[] {
  return total > shown ? ["", `…and ${total - shown} more ${noun}.`] : [];
}

/**
 * The Entities section as markdown lines, shared by the markdown report format
 * and by the engine's standalone entity-map document so the two can never
 * disagree.
 *
 * `heading` is the marker for the section title ("##" inside a report, "#" for
 * a standalone document); sub-headings nest one level below it.
 */
export function entityMarkdownSection(map: EntityMap, heading = "##"): string[] {
  const sub = `${heading}#`;
  const lines: string[] = [`${heading} Entities`, ""];

  if (map.summary.nodeCount === 0) {
    lines.push(ENTITY_EMPTY_MESSAGE, "");
    return lines;
  }

  lines.push(
    `_The site's own JSON-LD, collapsed into one graph. Informational, not part of the score._`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Entities | ${map.summary.nodeCount} |`,
    `| References | ${map.summary.edgeCount} |`,
    `| Dangling references | ${map.summary.danglingCount} |`,
    `| Pages crawled | ${map.summary.pagesTotal} |`,
    `| Pages with no entities | ${map.summary.pagesWithoutEntities} |`,
    `| Entities with a stable @id | ${map.summary.nodesWithStableId} (${stableIdPercent(map)}%) |`,
    "",
  );

  const ranked = primaryEntities(map);
  lines.push(
    `${sub} Largest entities`,
    "",
    "| Type | Name | @id | Occurrences | Pages |",
    "| --- | --- | --- | ---: | ---: |",
  );
  for (const node of ranked.slice(0, ENTITY_TABLE_LIMIT)) {
    lines.push(
      `| ${entityCell(node.types.join(", "))} | ${entityCell(entityLabel(node))} | ${entityCell(node.id) || "_none_"} | ${node.occurrences} | ${entityPageTotal(node)} |`,
    );
  }
  lines.push(...tail(Math.min(ranked.length, ENTITY_TABLE_LIMIT), ranked.length, "entities"));
  lines.push("");

  const conflicted = conflictedEntities(map);
  lines.push(`${sub} Conflicting properties (${conflicted.length})`, "");
  if (conflicted.length === 0) {
    lines.push("No entity disagrees with itself across pages.", "");
  } else {
    lines.push(
      "The same entity declares different values on different pages. Pick one and make every page agree.",
      "",
    );
    for (const node of conflicted.slice(0, ENTITY_FINDING_LIMIT)) {
      lines.push(
        `- **${entityCell(entityLabel(node))}** (${entityCell(node.types.join(", "))}, ${node.occurrences}x)`,
      );
      for (const conflict of node.conflicts) {
        lines.push(
          `  - \`${entityCell(conflict.property)}\` has ${conflict.values.length} values:`,
        );
        for (const value of conflict.values) {
          const pages = value.pages.length + value.morePages;
          lines.push(
            `    - ${entityCell(value.value) || "_empty_"} on ${pages} page(s), e.g. ${entityCell(value.pages[0])}`,
          );
        }
      }
    }
    lines.push(
      ...tail(Math.min(conflicted.length, ENTITY_FINDING_LIMIT), conflicted.length, "entities"),
      "",
    );
  }

  const dangling = danglingEdges(map);
  lines.push(`${sub} Dangling references (${dangling.length})`, "");
  if (dangling.length === 0) {
    lines.push("Every `@id` reference points at an entity some page declares.", "");
  } else {
    lines.push(
      "A page references an entity by `@id` that no crawled page declares. Declare it, or drop the reference.",
      "",
      "| Predicate | Missing @id | Occurrences | Example page |",
      "| --- | --- | ---: | --- |",
    );
    for (const edge of dangling.slice(0, ENTITY_FINDING_LIMIT)) {
      lines.push(
        `| ${entityCell(edge.predicate)} | ${entityCell(danglingTargetId(edge))} | ${edge.occurrences} | ${entityCell(edge.pages[0])} |`,
      );
    }
    lines.push(
      ...tail(Math.min(dangling.length, ENTITY_FINDING_LIMIT), dangling.length, "references"),
      "",
    );
  }

  const unstable = entitiesWithoutId(map);
  lines.push(`${sub} Entities without an @id (${unstable.length})`, "");
  if (unstable.length === 0) {
    lines.push("Every entity declared on more than one page carries an `@id`.", "");
  } else {
    lines.push(
      "Declared on several pages with no `@id`, so a search engine has no way to tell they are one thing. Give each a stable `@id` such as `https://your.site/#organization` and reference that id everywhere else.",
      "",
      "| Type | Name | Occurrences | Pages |",
      "| --- | --- | ---: | ---: |",
    );
    for (const node of unstable.slice(0, ENTITY_FINDING_LIMIT)) {
      lines.push(
        `| ${entityCell(node.types.join(", "))} | ${entityCell(entityLabel(node))} | ${node.occurrences} | ${entityPageTotal(node)} |`,
      );
    }
    lines.push(
      ...tail(Math.min(unstable.length, ENTITY_FINDING_LIMIT), unstable.length, "entities"),
      "",
    );
  }

  return lines;
}
