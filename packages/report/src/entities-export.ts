// Graph export formats for the entity map (#2092): csv, dot, graphml, mermaid.
//
// These exist so the map leaves squirrelscan: `dot -Tsvg` for a picture, Gephi
// or yEd for the graphml, a spreadsheet for the csv, and mermaid for a README
// or a GitHub comment.
//
// Every name, `@id` and type here comes from an audited page, so each format
// gets the escaping ITS parser needs, and none of them is string concatenation
// with a hopeful `replace`. The four differ in exactly that:
//   csv      RFC 4180 — double the quote, quote any field with a comma,
//            quote or newline, and strip a leading =+-@ so a spreadsheet does
//            not execute it as a formula.
//   dot      C-style backslash escaping inside a double-quoted ID.
//   graphml  XML — five entities, and control characters that XML 1.0 simply
//            cannot represent are dropped rather than emitted.
//   mermaid  the loosest parser of the four; quoted labels with the handful of
//            characters that break it neutralised, and a hard node cap.

import type { EntityMap, EntityMapEdge, EntityMapNode } from "./types";
import { entityLabel, entityPageTotal } from "./entities";

/**
 * Mermaid stops being readable — and GitHub stops rendering it — well before a
 * few hundred nodes, so the export truncates with a note rather than emitting
 * something no viewer will draw.
 */
export const MERMAID_NODE_CAP = 150;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nodes by reach, so a truncated export keeps the entities that matter. */
function byReach(nodes: EntityMapNode[]): EntityMapNode[] {
  return [...nodes].sort(
    (a, b) => b.occurrences - a.occurrences || compareStrings(a.key, b.key),
  );
}

// ── CSV ────────────────────────────────────────────────────────────

/**
 * One RFC 4180 field.
 *
 * The leading-character strip is the part that is not about CSV at all: Excel,
 * Sheets and LibreOffice treat a field starting `=`, `+`, `-` or `@` as a
 * formula, so a site that names an entity `=HYPERLINK(...)` gets it executed
 * when someone opens the export. Prefixing with an apostrophe is the documented
 * neutralisation and survives a round trip as text.
 */
function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(",");
}

/**
 * The map as two CSV tables, nodes then edges, separated by a blank line.
 *
 * One file rather than two because the command writes to one `-o` path; a
 * spreadsheet imports the halves separately, and a `csvkit` user splits on the
 * blank line.
 */
export function renderEntitiesCsv(map: EntityMap): string {
  const lines: string[] = [];

  lines.push(
    csvRow([
      "key",
      "id",
      "types",
      "name",
      "occurrences",
      "pages",
      "conflicts",
      "danglingRefs",
      "pageLocal",
      "url",
      "logo",
      "sameAs",
    ]),
  );
  for (const node of map.nodes) {
    lines.push(
      csvRow([
        node.key,
        node.id,
        node.types.join(" "),
        node.name,
        node.occurrences,
        entityPageTotal(node),
        node.conflicts.length,
        node.danglingRefs,
        node.pageLocal,
        node.properties.url,
        node.properties.logo,
        node.properties.sameAs?.join(" "),
      ]),
    );
  }

  lines.push("");
  lines.push(csvRow(["source", "predicate", "target", "dangling", "occurrences"]));
  for (const edge of map.edges) {
    lines.push(
      csvRow([edge.source, edge.predicate, edge.target, edge.dangling, edge.occurrences]),
    );
  }

  return `${lines.join("\n")}\n`;
}

// ── DOT ────────────────────────────────────────────────────────────

/** A double-quoted DOT ID. Backslash and quote are the only two that matter. */
function dotQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Stable, DOT-safe node id. The key itself is a URL and not usable as one. */
function dotId(index: number): string {
  return `n${index}`;
}

/**
 * Graphviz source. `dot -Tsvg site.dot -o site.svg` renders it.
 *
 * Dangling targets are drawn as their own dashed, red nodes: the whole point of
 * looking at the graph is seeing the reference that points at nothing.
 */
export function renderEntitiesDot(map: EntityMap): string {
  const ids = new Map<string, string>();
  map.nodes.forEach((node, index) => ids.set(node.key, dotId(index)));

  const lines: string[] = [
    "digraph entities {",
    "  graph [rankdir=LR, overlap=false, splines=true];",
    '  node [shape=box, style="rounded,filled", fillcolor="#eef2f7", fontname="Helvetica"];',
    '  edge [fontname="Helvetica", fontsize=9, color="#888888"];',
    "",
  ];

  for (const node of map.nodes) {
    const label = `${entityLabel(node)}\n${node.types.join(", ")} · ${node.occurrences}x`;
    const shape = node.pageLocal ? ', fillcolor="#f3f3ef"' : "";
    lines.push(`  ${ids.get(node.key)} [label=${dotQuote(label)}${shape}];`);
  }

  // Placeholders for references nothing declares.
  let danglingIndex = 0;
  const danglingIds = new Map<string, string>();
  for (const edge of map.edges) {
    if (!edge.dangling || danglingIds.has(edge.target)) continue;
    const id = `d${danglingIndex++}`;
    danglingIds.set(edge.target, id);
    const label = edge.target.startsWith("id:") ? edge.target.slice(3) : edge.target;
    lines.push(
      `  ${id} [label=${dotQuote(label)}, style="dashed", fillcolor="#ffffff", color="#a32020", fontcolor="#a32020"];`,
    );
  }

  lines.push("");
  for (const edge of map.edges) {
    const source = ids.get(edge.source);
    const target = edge.dangling ? danglingIds.get(edge.target) : ids.get(edge.target);
    if (!source || !target) continue;
    const style = edge.dangling ? ', style="dashed", color="#a32020"' : "";
    lines.push(`  ${source} -> ${target} [label=${dotQuote(edge.predicate)}${style}];`);
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

// ── GraphML ────────────────────────────────────────────────────────

/**
 * XML text, with the characters XML 1.0 cannot represent dropped.
 *
 * A page can put a raw control byte in a name. Escaping it is not possible:
 * `&#x1;` is itself invalid in XML 1.0, so a parser rejects the whole document.
 * Dropping is the only option that keeps the file openable.
 */
function xmlText(value: string): string {
  return value
    // XML 1.0 has no representation for these at all, not even as a numeric
    // reference, so a parser rejects the whole document. Dropping is the only
    // option that keeps the file openable.
    // Not just the C0 controls: U+FFFE and U+FFFF are permanently unassigned
    // non-characters, and an unpaired surrogate is not a character at all, so a
    // parser rejects all three the same way a control byte is rejected.
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      ""
    )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** GraphML for Gephi, yEd and networkx. */
export function renderEntitiesGraphml(map: EntityMap): string {
  const ids = new Map<string, string>();
  map.nodes.forEach((node, index) => ids.set(node.key, `n${index}`));

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns',
    '         http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="entityId" for="node" attr.name="entityId" attr.type="string"/>',
    '  <key id="types" for="node" attr.name="types" attr.type="string"/>',
    '  <key id="occurrences" for="node" attr.name="occurrences" attr.type="int"/>',
    '  <key id="pages" for="node" attr.name="pages" attr.type="int"/>',
    '  <key id="conflicts" for="node" attr.name="conflicts" attr.type="int"/>',
    '  <key id="pageLocal" for="node" attr.name="pageLocal" attr.type="boolean"/>',
    '  <key id="predicate" for="edge" attr.name="predicate" attr.type="string"/>',
    '  <key id="dangling" for="edge" attr.name="dangling" attr.type="boolean"/>',
    '  <graph id="entities" edgedefault="directed">',
  ];

  for (const node of map.nodes) {
    const id = ids.get(node.key)!;
    lines.push(`    <node id="${id}">`);
    lines.push(`      <data key="label">${xmlText(entityLabel(node))}</data>`);
    lines.push(`      <data key="entityId">${xmlText(node.id ?? "")}</data>`);
    lines.push(`      <data key="types">${xmlText(node.types.join(", "))}</data>`);
    lines.push(`      <data key="occurrences">${node.occurrences}</data>`);
    lines.push(`      <data key="pages">${entityPageTotal(node)}</data>`);
    lines.push(`      <data key="conflicts">${node.conflicts.length}</data>`);
    lines.push(`      <data key="pageLocal">${node.pageLocal}</data>`);
    lines.push("    </node>");
  }

  let danglingIndex = 0;
  const danglingIds = new Map<string, string>();
  for (const edge of map.edges) {
    if (!edge.dangling || danglingIds.has(edge.target)) continue;
    const id = `d${danglingIndex++}`;
    danglingIds.set(edge.target, id);
    const label = edge.target.startsWith("id:") ? edge.target.slice(3) : edge.target;
    lines.push(`    <node id="${id}">`);
    lines.push(`      <data key="label">${xmlText(label)}</data>`);
    lines.push(`      <data key="entityId">${xmlText(label)}</data>`);
    lines.push('      <data key="types">(undeclared)</data>');
    lines.push('      <data key="occurrences">0</data>');
    lines.push('      <data key="pages">0</data>');
    lines.push('      <data key="conflicts">0</data>');
    lines.push('      <data key="pageLocal">false</data>');
    lines.push("    </node>");
  }

  map.edges.forEach((edge: EntityMapEdge, index: number) => {
    const source = ids.get(edge.source);
    const target = edge.dangling ? danglingIds.get(edge.target) : ids.get(edge.target);
    if (!source || !target) return;
    lines.push(`    <edge id="e${index}" source="${source}" target="${target}">`);
    lines.push(`      <data key="predicate">${xmlText(edge.predicate)}</data>`);
    lines.push(`      <data key="dangling">${edge.dangling}</data>`);
    lines.push("    </edge>");
  });

  lines.push("  </graph>", "</graphml>");
  return `${lines.join("\n")}\n`;
}

// ── Mermaid ────────────────────────────────────────────────────────

/**
 * A mermaid node label.
 *
 * Mermaid's parser is the loosest of the four and the least specified. Quoting
 * handles most of it; the characters left are the ones that end a label or a
 * statement even inside quotes.
 */
function mermaidLabel(value: string): string {
  const flat = value
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    // A backtick opens a code span in the flow grammar, and these end a label
    // or a statement even inside quotes.
    .replace(/[[\]{}()<>|;`#]/g, "")
    .trim();
  const clipped = flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
  return clipped || "unnamed";
}

/**
 * A mermaid `graph LR`, capped at {@link MERMAID_NODE_CAP} nodes.
 *
 * Over the cap it keeps the most-declared entities and says so in a comment, so
 * a reader knows the picture is partial rather than wondering why their biggest
 * site renders as thirty boxes.
 */
export function renderEntitiesMermaid(map: EntityMap): string {
  const ranked = byReach(map.nodes);
  const kept = ranked.slice(0, MERMAID_NODE_CAP);
  const keptKeys = new Set(kept.map((node) => node.key));
  const ids = new Map<string, string>();
  // Document order for the ids, so the same map always yields the same source.
  map.nodes.filter((node) => keptKeys.has(node.key)).forEach((node, index) => {
    ids.set(node.key, `n${index}`);
  });

  const lines: string[] = [];
  if (map.nodes.length > MERMAID_NODE_CAP) {
    lines.push(
      `%% Showing the ${MERMAID_NODE_CAP} most-declared of ${map.nodes.length} entities.`,
      "%% Mermaid stops rendering well beyond this; use -f dot or -f graphml for the whole graph.",
    );
  }
  lines.push("graph LR");

  if (kept.length === 0) {
    lines.push("  empty[This site declares no JSON-LD entities]");
    return `${lines.join("\n")}\n`;
  }

  for (const node of kept) {
    const id = ids.get(node.key)!;
    const label = `${mermaidLabel(entityLabel(node))}<br/>${mermaidLabel(node.types.join(", "))}`;
    lines.push(`  ${id}["${label}"]`);
  }

  let danglingIndex = 0;
  const danglingIds = new Map<string, string>();
  for (const edge of map.edges) {
    if (!edge.dangling || !keptKeys.has(edge.source) || danglingIds.has(edge.target)) continue;
    const id = `d${danglingIndex++}`;
    danglingIds.set(edge.target, id);
    const label = edge.target.startsWith("id:") ? edge.target.slice(3) : edge.target;
    lines.push(`  ${id}(["${mermaidLabel(label)}"])`);
  }

  for (const edge of map.edges) {
    const source = ids.get(edge.source);
    const target = edge.dangling ? danglingIds.get(edge.target) : ids.get(edge.target);
    if (!source || !target) continue;
    const arrow = edge.dangling ? "-.->" : "-->";
    // Quoted: the edge label sits between bare pipes, so a predicate that
    // escaping emptied would leave `||` and the grammar rejects it.
    lines.push(`  ${source} ${arrow}|"${mermaidLabel(edge.predicate)}"| ${target}`);
  }

  return `${lines.join("\n")}\n`;
}
