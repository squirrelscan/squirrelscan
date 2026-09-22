// The viewer's data block is inlined into an HTML page, and the browser parses
// all of it before the graph appears. It is BOUNDED, and these pin why.
//
// The document itself grows linearly with the crawl: a 5,000-page store
// declaring four entities per page measures 20,001 nodes and 15.3MB of inline
// JSON — to draw 400 nodes and show 25 table rows. What the viewer never reads
// (`pages`) must not travel, and what it cannot draw must not be free.

import { describe, expect, test } from "bun:test";

import {
  ENTITY_MAP_VIEWER_LIMITS,
  type EntityMapPage,
} from "@squirrelscan/core-contracts/entity-map";

import { entityViewerData } from "../src/entities-viewer";
import type { EntityMap, EntityMapNode } from "../src/types";

function node(key: string, occurrences: number): EntityMapNode {
  return {
    key,
    id: null,
    types: ["Product"],
    name: key,
    properties: {},
    occurrences,
    pages: [],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
  };
}

function page(i: number): EntityMapPage {
  return {
    url: `https://example.com/products/item-${i}`,
    declares: [`n${String(i).padStart(5, "0")}`],
    references: [`id:https://example.com/#organization`],
    entityCount: 4,
  };
}

function map(nodeCount: number, pageCount: number): EntityMap {
  const nodes = Array.from({ length: nodeCount }, (_, i) =>
    node(`n${String(i).padStart(5, "0")}`, (i % 40) + 1),
  );
  return {
    format: "squirrelscan/entity-map",
    version: 1,
    site: "https://example.com/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount,
      edgeCount: 0,
      danglingCount: 0,
      pagesTotal: pageCount,
      pagesWithoutEntities: 0,
      nodesWithStableId: 0,
      stableIdShare: 0,
      pageLocalCount: 0,
      nodesWithoutIdCount: 0,
      conflictCount: 0,
      countsByType: { Product: nodeCount },
    },
    nodes,
    edges: [],
    pages: Array.from({ length: pageCount }, (_, i) => page(i)),
  } as EntityMap;
}

/** The data block, back through the `\uXXXX` escaping it goes out with. */
function parse(json: string): EntityMap {
  return JSON.parse(json) as EntityMap;
}

describe("entityViewerData", () => {
  test("drops `pages`, which nothing in the viewer reads", () => {
    const payload = parse(entityViewerData(map(5, 500)));
    expect(payload.pages).toEqual([]);
    // The count a reader actually needs survives in the summary.
    expect(payload.summary.pagesTotal).toBe(500);
    expect(payload.truncated!.pages).toBe(500);
  });

  test("caps the node count a 5,000-page crawl would otherwise inline", () => {
    const full = map(20_001, 5_000);
    const payload = parse(entityViewerData(full));

    expect(payload.nodes).toHaveLength(ENTITY_MAP_VIEWER_LIMITS.maxNodes);
    expect(payload.truncated).toMatchObject({
      reason: "viewer",
      nodes: 20_001 - ENTITY_MAP_VIEWER_LIMITS.maxNodes,
      pages: 5_000,
    });
  });

  test("shrinks the serialized block by an order of magnitude", () => {
    const full = map(20_001, 5_000);
    const bounded = entityViewerData(full).length;
    const unbounded = JSON.stringify(full).length;

    expect(bounded).toBeLessThanOrEqual(ENTITY_MAP_VIEWER_LIMITS.maxBytes);
    expect(bounded).toBeLessThan(unbounded / 5);
  });

  test("leaves a small site's map alone apart from the page array", () => {
    const small = map(12, 4);
    const payload = parse(entityViewerData(small));

    expect(payload.nodes).toHaveLength(12);
    expect(payload.truncated).toEqual({ reason: "viewer", nodes: 0, edges: 0, pages: 4 });
    // Every entity a small site declares still reaches the table.
    expect(payload.nodes.map((n) => n.key)).toEqual(small.nodes.map((n) => n.key));
  });

  test("keeps the entities with the most reach", () => {
    const nodes = Array.from({ length: ENTITY_MAP_VIEWER_LIMITS.maxNodes + 3 }, (_, i) =>
      node(`n${String(i).padStart(5, "0")}`, i),
    );
    const full = { ...map(0, 0), nodes, summary: { ...map(0, 0).summary, nodeCount: nodes.length } };
    const payload = parse(entityViewerData(full));

    const keys = new Set(payload.nodes.map((n) => n.key));
    expect(keys.has("n00000")).toBe(false);
    expect(keys.has(`n${String(nodes.length - 1).padStart(5, "0")}`)).toBe(true);
  });

  test("still escapes what would close the script block", () => {
    const nodes = [node("</script><img src=x onerror=alert(1)>", 3)];
    const full = { ...map(0, 0), nodes, summary: { ...map(0, 0).summary, nodeCount: 1 } };
    const json = entityViewerData(full);

    expect(json).not.toContain("</script");
    expect(json).not.toContain("<img");
    // And it is still valid JSON carrying the real value.
    expect(parse(json).nodes[0]!.key).toBe("</script><img src=x onerror=alert(1)>");
  });
});
