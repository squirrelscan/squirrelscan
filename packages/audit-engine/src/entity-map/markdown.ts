// Markdown view of an entity map (#2061).
//
// The format an agent reads. The HTML page is for a person with a mouse; this
// is the same map as text a coding agent can act on, so it leads with the
// findings (conflicts, dangling references, entities with no `@id`) rather than
// with a dump of every node.
//
// Every value here comes from an audited page. Markdown has no script vector,
// but a pipe or a newline inside a name would break the tables, so cell text is
// escaped and clipped.

import type {
  EntityMap,
  EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";

/** Entities listed in the "largest entities" table. */
const TOP_ENTITIES = 25;

/** Rows listed in each findings section before it says "and N more". */
const MAX_FINDING_ROWS = 25;

/** Longest cell before an ellipsis. Keeps a table readable in a terminal. */
const MAX_CELL = 90;

/**
 * Make a value safe for a markdown table cell: no pipes, no line breaks, and
 * short enough to read. Site content decides this string, so nothing is assumed
 * about it.
 */
function cell(value: string | null | undefined): string {
  if (!value) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  // Clip BEFORE escaping. Clipping afterwards can cut an escape pair in half
  // and leave a trailing lone backslash, which would then escape the cell's
  // own closing pipe.
  const clipped =
    flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
  // Backslash first, then pipe. The other order turns a site's literal `\|`
  // into `\\|`, which markdown reads as an escaped backslash followed by a
  // LIVE pipe, and the row gains a column.
  return clipped.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Total pages a node was declared on, including the ones past the cap. */
function pageTotal(node: EntityMapNode): number {
  return node.pages.length + node.morePages;
}

function label(node: EntityMapNode): string {
  return node.name ?? `(unnamed ${node.types[0] ?? "entity"})`;
}

function tail(shown: number, total: number, noun: string): string[] {
  return total > shown ? ["", `…and ${total - shown} more ${noun}.`] : [];
}

/**
 * Render an entity map as markdown.
 *
 * Deterministic for a given map: every section reads the map's own sorted
 * arrays, and the only varying input is `generatedAt`.
 */
export function renderEntityMapMarkdown(map: EntityMap): string {
  const lines: string[] = [];
  const summary = map.summary;

  lines.push("# Entity map", "", `**Site:** ${cell(map.site)}  `);
  lines.push(`**Generated:** ${map.generatedAt}  `);
  lines.push(`**Format:** ${map.format} v${map.version}`, "");

  lines.push("## Summary", "");
  lines.push("| Metric | Value |", "| --- | ---: |");
  lines.push(`| Entities | ${summary.nodeCount} |`);
  lines.push(`| References | ${summary.edgeCount} |`);
  lines.push(`| Dangling references | ${summary.danglingCount} |`);
  lines.push(`| Pages crawled | ${summary.pagesTotal} |`);
  lines.push(`| Pages with no entities | ${summary.pagesWithoutEntities} |`);
  lines.push(
    `| Entities with a stable @id | ${summary.nodesWithStableId} (${percent(summary.stableIdShare)}) |`,
  );
  lines.push("");

  if (summary.nodeCount === 0) {
    lines.push(
      "This site declares no JSON-LD entities on any crawled page, so there is no",
      "graph to read. Search engines have nothing to reconcile the site into.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }

  // Types, most declared first.
  const types = Object.entries(summary.countsByType).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  if (types.length > 0) {
    lines.push("## Types", "");
    lines.push("| Type | Occurrences |", "| --- | ---: |");
    for (const [type, count] of types.slice(0, TOP_ENTITIES)) {
      lines.push(`| ${cell(type)} | ${count} |`);
    }
    lines.push(...tail(Math.min(types.length, TOP_ENTITIES), types.length, "types"));
    lines.push("");
  }

  // Largest entities. The map sorts by key, so sort a copy by occurrences and
  // break ties on key to stay deterministic.
  const byOccurrence = [...map.nodes].sort(
    (a, b) => b.occurrences - a.occurrences || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  lines.push("## Largest entities", "");
  lines.push(
    "| Type | Name | @id | Occurrences | Pages |",
    "| --- | --- | --- | ---: | ---: |",
  );
  for (const node of byOccurrence.slice(0, TOP_ENTITIES)) {
    lines.push(
      `| ${cell(node.types.join(", "))} | ${cell(label(node))} | ${cell(node.id) || "_none_"} | ${node.occurrences} | ${pageTotal(node)} |`,
    );
  }
  lines.push(...tail(Math.min(map.nodes.length, TOP_ENTITIES), map.nodes.length, "entities"));
  lines.push("");

  // ── Findings ─────────────────────────────────────────────────────

  lines.push("## Findings", "");

  const conflicted = byOccurrence.filter((node) => node.conflicts.length > 0);
  lines.push(`### Conflicting properties (${conflicted.length})`, "");
  if (conflicted.length === 0) {
    lines.push("No entity disagrees with itself across pages.", "");
  } else {
    lines.push(
      "The same entity declares different values for a property on different pages.",
      "Pick one and make every page agree.",
      "",
    );
    for (const node of conflicted.slice(0, MAX_FINDING_ROWS)) {
      lines.push(`- **${cell(label(node))}** (${cell(node.types.join(", "))}, ${node.occurrences}x)`);
      for (const conflict of node.conflicts) {
        lines.push(`  - \`${cell(conflict.property)}\` has ${conflict.values.length} values:`);
        for (const value of conflict.values) {
          const pages = value.pages.length + value.morePages;
          lines.push(`    - ${cell(value.value) || "_empty_"} on ${pages} page(s), e.g. ${cell(value.pages[0])}`);
        }
      }
    }
    lines.push(
      ...tail(Math.min(conflicted.length, MAX_FINDING_ROWS), conflicted.length, "entities"),
    );
    lines.push("");
  }

  const dangling = map.edges.filter((edge) => edge.dangling);
  lines.push(`### Dangling references (${dangling.length})`, "");
  if (dangling.length === 0) {
    lines.push("Every `@id` reference points at an entity some page declares.", "");
  } else {
    lines.push(
      "A page references an entity by `@id` that no crawled page declares. Declare it,",
      "or drop the reference.",
      "",
    );
    lines.push("| Predicate | Missing @id | Occurrences | Example page |", "| --- | --- | ---: | --- |");
    for (const edge of dangling.slice(0, MAX_FINDING_ROWS)) {
      const target = edge.target.startsWith("id:") ? edge.target.slice(3) : edge.target;
      lines.push(
        `| ${cell(edge.predicate)} | ${cell(target)} | ${edge.occurrences} | ${cell(edge.pages[0])} |`,
      );
    }
    lines.push(...tail(Math.min(dangling.length, MAX_FINDING_ROWS), dangling.length, "references"));
    lines.push("");
  }

  // The headline finding: an entity repeated across pages with nothing to
  // reconcile it by. A one-page entity with no @id is normal, so rank by reach.
  const unstable = byOccurrence.filter((node) => node.id === null && pageTotal(node) > 1);
  lines.push(`### Entities without an @id (${unstable.length})`, "");
  if (unstable.length === 0) {
    lines.push("Every entity declared on more than one page carries an `@id`.", "");
  } else {
    lines.push(
      "These are declared on several pages with no `@id`, so a search engine has no way",
      "to tell they are one thing. Give each a stable `@id` such as",
      "`https://your.site/#organization` and reference that id everywhere else.",
      "",
    );
    lines.push("| Type | Name | Occurrences | Pages |", "| --- | --- | ---: | ---: |");
    for (const node of unstable.slice(0, MAX_FINDING_ROWS)) {
      lines.push(
        `| ${cell(node.types.join(", "))} | ${cell(label(node))} | ${node.occurrences} | ${pageTotal(node)} |`,
      );
    }
    lines.push(...tail(Math.min(unstable.length, MAX_FINDING_ROWS), unstable.length, "entities"));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
