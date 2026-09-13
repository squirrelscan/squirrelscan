// One test per export format (#2092), and one per format for the escaping its
// own parser needs. Every string in the map comes from an audited page, and the
// four formats fail in four different ways: a comma breaks csv, a quote breaks
// dot, a raw control byte makes graphml unparseable, and a bracket breaks
// mermaid.

import { describe, expect, test } from "bun:test";

import type { EntityMap, EntityMapNode } from "../src/types";
import {
  MERMAID_NODE_CAP,
  renderEntitiesCsv,
  renderEntitiesDot,
  renderEntitiesGraphml,
  renderEntitiesMermaid,
} from "../src/entities-export";

function node(overrides: Partial<EntityMapNode> = {}): EntityMapNode {
  return {
    key: "id:https://example.com/#org",
    id: "https://example.com/#org",
    types: ["Organization"],
    name: "Acme Widgets",
    properties: { name: "Acme Widgets", url: "https://example.com/" },
    occurrences: 12,
    pages: ["https://example.com/a"],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
    ...overrides,
  };
}

function map(nodes: EntityMapNode[], edges: EntityMap["edges"] = []): EntityMap {
  return {
    format: "squirrelscan/entity-map",
    version: 1,
    site: "https://example.com/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((e) => e.dangling).length,
      pagesTotal: 1,
      pagesWithoutEntities: 0,
      nodesWithStableId: nodes.filter((n) => n.id).length,
      stableIdShare: 1,
      pageLocalCount: 0,
      nodesWithoutIdCount: 0,
      conflictCount: 0,
      countsByType: {},
    },
    nodes,
    edges,
    pages: [],
  };
}

const DANGLING: EntityMap["edges"] = [
  {
    source: "id:https://example.com/#org",
    predicate: "publisher",
    target: "id:https://example.com/#missing",
    dangling: true,
    occurrences: 3,
    pages: [],
    morePages: 0,
  },
];

describe("csv", () => {
  test("emits a node table and an edge table", () => {
    const out = renderEntitiesCsv(map([node()], DANGLING));
    const [header, firstRow] = out.split("\n");
    expect(header).toContain("key,id,types,name,occurrences");
    expect(firstRow).toContain("Acme Widgets");
    expect(out).toContain("source,predicate,target,dangling,occurrences");
    expect(out).toContain("publisher");
  });

  test("quotes a field containing a comma, quote or newline", () => {
    const out = renderEntitiesCsv(map([node({ name: 'Acme, "The" Co\nLtd' })]));
    expect(out).toContain('"Acme, ""The"" Co\nLtd"');
  });

  test("neutralises a formula so a spreadsheet cannot execute it", () => {
    // Not a CSV concern at all: Excel, Sheets and LibreOffice run a field that
    // starts =, +, - or @, and the site chooses this string.
    for (const prefix of ["=", "+", "-", "@"]) {
      const out = renderEntitiesCsv(map([node({ name: `${prefix}HYPERLINK("http://evil")` })]));
      expect(out).toContain(`'${prefix}HYPERLINK`);
    }
  });
});

describe("dot", () => {
  test("emits a digraph with a labelled edge", () => {
    const out = renderEntitiesDot(map([node()], DANGLING));
    expect(out).toContain("digraph entities {");
    expect(out).toContain("Acme Widgets");
    expect(out).toContain('[label="publisher", style="dashed"');
    expect(out.trimEnd().endsWith("}")).toBe(true);
  });

  test("escapes a quote and a backslash inside a label", () => {
    const out = renderEntitiesDot(map([node({ name: 'Acme "Quoted" \\ Co' })]));
    expect(out).toContain('Acme \\"Quoted\\" \\\\ Co');
    // Nothing closed the label early.
    const labelLine = out.split("\n").find((line) => line.includes("Acme"))!;
    expect(labelLine.trimEnd().endsWith("];")).toBe(true);
  });

  test("draws a dangling target as its own node", () => {
    const out = renderEntitiesDot(map([node()], DANGLING));
    expect(out).toContain("https://example.com/#missing");
    expect(out).toContain('color="#a32020"');
  });
});

describe("graphml", () => {
  test("emits a well-formed graph with typed keys", () => {
    const out = renderEntitiesGraphml(map([node()], DANGLING));
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain("http://graphml.graphdrawing.org/xmlns");
    expect(out).toContain('<data key="label">Acme Widgets</data>');
    expect(out).toContain('<data key="occurrences">12</data>');
    expect(out).toContain('<data key="predicate">publisher</data>');
    expect(out.trimEnd().endsWith("</graphml>")).toBe(true);
  });

  test("escapes the five XML entities", () => {
    const out = renderEntitiesGraphml(map([node({ name: `A & B < C > D " E ' F` })]));
    expect(out).toContain("A &amp; B &lt; C &gt; D &quot; E &apos; F");
  });

  test("drops non-characters and unpaired surrogates too", () => {
    // U+FFFE/U+FFFF are permanently unassigned and an unpaired surrogate is
    // not a character at all: xmllint rejects a document containing any of
    // them exactly as it rejects a control byte.
    const hostile =
      "A" + String.fromCharCode(0xfffe) + "B" + String.fromCharCode(0xffff) + "C" +
      String.fromCharCode(0xd800) + "D";
    const out = renderEntitiesGraphml(map([node({ name: hostile })]));
    expect(out).toContain("ABCD");
    for (const code of [0xfffe, 0xffff, 0xd800]) {
      expect(out).not.toContain(String.fromCharCode(code));
    }
  });

  test("drops control characters XML 1.0 cannot represent", () => {
    // `&#x1;` is itself invalid in XML 1.0, so escaping is not an option: a
    // parser rejects the whole document. Dropping keeps the file openable.
    const hostile = `Acme${String.fromCharCode(1)}${String.fromCharCode(31)}Co`;
    const out = renderEntitiesGraphml(map([node({ name: hostile })]));
    expect(out).toContain("AcmeCo");
    expect(out).not.toContain(String.fromCharCode(1));
    expect(out).not.toContain(String.fromCharCode(31));
  });
});

describe("mermaid", () => {
  test("emits a graph with labelled edges", () => {
    const out = renderEntitiesMermaid(map([node()], DANGLING));
    expect(out).toContain("graph LR");
    expect(out).toContain("Acme Widgets");
    expect(out).toContain('-.->|"publisher"|');
  });

  test("an emptied predicate still yields a parseable edge", () => {
    // The label sits between bare pipes, so a predicate that escaping empties
    // would leave `||` and the grammar rejects the whole graph.
    const out = renderEntitiesMermaid(map([node()], [{ ...DANGLING[0]!, predicate: "|;|" }]));
    expect(out).toContain('|"unnamed"|');
    expect(out).not.toContain("||");
  });

  test("strips a backtick, which opens a code span in the flow grammar", () => {
    const hostile = "`code` Corp";
    const out = renderEntitiesMermaid(map([node({ name: hostile })]));
    expect(out).not.toContain("`");
    expect(out).toContain("code Corp");
  });

  test("strips the characters that end a mermaid label", () => {
    const out = renderEntitiesMermaid(map([node({ name: "Acme [Inc] (Ltd) {x} |y| ;z" })]));
    expect(out).toContain("Acme Inc Ltd x y z");
    expect(out).not.toContain("[Inc]");
  });

  test(`caps at ${MERMAID_NODE_CAP} nodes and says so`, () => {
    const many = Array.from({ length: MERMAID_NODE_CAP + 40 }, (_, i) =>
      node({ key: `k${i}`, id: `https://example.com/#${i}`, name: `E${i}`, occurrences: i }),
    );
    const out = renderEntitiesMermaid(map(many));

    expect(out).toContain(`%% Showing the ${MERMAID_NODE_CAP} most-declared of ${many.length}`);
    expect(out).toContain("-f dot or -f graphml");
    // The busiest survived, the quietest did not.
    expect(out).toContain(`E${MERMAID_NODE_CAP + 39}`);
    expect(out).not.toContain("E0[");
  });

  test("an empty map still renders something a viewer can draw", () => {
    const out = renderEntitiesMermaid(map([]));
    expect(out).toContain("graph LR");
    expect(out).toContain("declares no JSON-LD entities");
  });
});
