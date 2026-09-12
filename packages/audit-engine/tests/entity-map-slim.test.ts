// The hosted copy of the map rides the publish body, which is measured against
// a hard size gate. What it drops, and what it must never drop, is the contract
// with the cloud side.

import { describe, expect, test } from "bun:test";

import {
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_PUBLISH_LIMITS,
  ENTITY_MAP_VERSION,
  type EntityMap,
  type EntityMapEdge,
  type EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";

import { slimEntityMapForPublish } from "../src/entity-map";

function node(key: string, occurrences: number): EntityMapNode {
  return {
    key,
    id: null,
    types: ["Thing"],
    name: key,
    properties: {},
    occurrences,
    pages: [],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
  };
}

function edge(source: string, target: string, dangling = false): EntityMapEdge {
  return {
    source,
    predicate: "about",
    target,
    dangling,
    occurrences: 1,
    pages: [],
    morePages: 0,
  };
}

function map(nodes: EntityMapNode[], edges: EntityMapEdge[], pageCount = 0): EntityMap {
  return {
    format: ENTITY_MAP_FORMAT,
    version: ENTITY_MAP_VERSION,
    site: "https://example.com/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((e) => e.dangling).length,
      pagesTotal: pageCount,
      pagesWithoutEntities: 0,
      nodesWithStableId: 0,
      stableIdShare: 0,
      countsByType: { Thing: nodes.length },
    },
    nodes,
    edges,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      url: `https://example.com/${i}`,
      declares: [],
      references: [],
      entityCount: 0,
    })),
  };
}

describe("slimEntityMapForPublish", () => {
  test("returns a small map untouched", () => {
    const small = map([node("a", 3)], [], 0);
    expect(slimEntityMapForPublish(small)).toBe(small);
  });

  test("always drops pages, even when nothing else is over the limit", () => {
    const withPages = map([node("a", 3)], [], 4);
    const slim = slimEntityMapForPublish(withPages);
    expect(slim.pages).toEqual([]);
    // The summary still describes the site, not the projection.
    expect(slim.summary.pagesTotal).toBe(4);
  });

  test("keeps the most-declared entities when over the node cap", () => {
    const many: EntityMapNode[] = [];
    for (let i = 0; i < ENTITY_MAP_PUBLISH_LIMITS.maxNodes + 50; i += 1) {
      many.push(node(`n${String(i).padStart(4, "0")}`, i));
    }
    const slim = slimEntityMapForPublish(map(many, []));

    expect(slim.nodes).toHaveLength(ENTITY_MAP_PUBLISH_LIMITS.maxNodes);
    // The 50 least-declared went, the busiest stayed.
    const keys = new Set(slim.nodes.map((n) => n.key));
    expect(keys.has("n0000")).toBe(false);
    expect(keys.has(`n${String(many.length - 1).padStart(4, "0")}`)).toBe(true);
    // Still sorted by key, like the document it came from.
    expect(slim.nodes.map((n) => n.key)).toEqual([...slim.nodes.map((n) => n.key)].sort());
    // And the true totals survive so a reader can see it was clipped.
    expect(slim.summary.nodeCount).toBe(many.length);
  });

  test("drops an edge whose endpoint was clipped but keeps a dangling one", () => {
    const many: EntityMapNode[] = [];
    for (let i = 0; i < ENTITY_MAP_PUBLISH_LIMITS.maxNodes + 2; i += 1) {
      many.push(node(`n${String(i).padStart(4, "0")}`, i));
    }
    const busiest = `n${String(many.length - 1).padStart(4, "0")}`;
    const clipped = "n0000";
    const edges = [
      edge(busiest, clipped),
      edge(busiest, "id:https://example.com/#missing", true),
    ];
    const slim = slimEntityMapForPublish(map(many, edges));

    expect(slim.edges).toHaveLength(1);
    expect(slim.edges[0]!.dangling).toBe(true);
  });

  test("is deterministic", () => {
    const many: EntityMapNode[] = [];
    for (let i = 0; i < ENTITY_MAP_PUBLISH_LIMITS.maxNodes + 30; i += 1) {
      many.push(node(`n${String(i).padStart(4, "0")}`, i % 7));
    }
    const source = map(many, []);
    expect(JSON.stringify(slimEntityMapForPublish(source))).toBe(
      JSON.stringify(slimEntityMapForPublish(source)),
    );
  });
});
