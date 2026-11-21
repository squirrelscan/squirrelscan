// #407: the publish projection summarizes structurally identical entities
// instead of sampling them, and states the true count of each group.

import { Value } from "@sinclair/typebox/value";
import {
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_PUBLISH_LIMITS,
  ENTITY_MAP_VERSION,
  EntityMapSchema,
  type EntityMap,
  type EntityMapEdge,
  type EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";
import { entityMarkdownSection } from "@squirrelscan/report/entities";
import { describe, expect, test } from "bun:test";

import { projectEntityMap, slimEntityMapForPublish } from "../src/entity-map";

function node(
  key: string,
  types: string[],
  extra: Partial<EntityMapNode> = {}
): EntityMapNode {
  return {
    key,
    id: null,
    types,
    name: key,
    properties: {},
    occurrences: 1,
    pages: [],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
    ...extra,
  };
}

function edge(
  source: string,
  target: string,
  predicate = "brand"
): EntityMapEdge {
  return {
    source,
    predicate,
    target,
    dangling: false,
    occurrences: 1,
    pages: [],
    morePages: 0,
  };
}

function catalogue(products: number): EntityMap {
  const nodes: EntityMapNode[] = [
    node("id:org", ["Organization"], { occurrences: 5 }),
  ];
  const edges: EntityMapEdge[] = [];
  for (let i = 0; i < products; i++) {
    const key = `id:p${String(i).padStart(4, "0")}`;
    nodes.push(node(key, ["Product"]));
    edges.push(edge(key, "id:org"));
  }
  nodes.sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    format: ENTITY_MAP_FORMAT,
    version: ENTITY_MAP_VERSION,
    site: "https://shop.test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: 0,
      pagesTotal: products,
      pagesWithoutEntities: 0,
      nodesWithStableId: nodes.length,
      stableIdShare: 1,
      pageLocalCount: 0,
      nodesWithoutIdCount: 0,
      conflictCount: 0,
      countsByType: { Organization: 1, Product: products },
    },
    nodes,
    edges,
    pages: [],
  };
}

describe("entity map summarization (#407)", () => {
  test("a large single-type catalogue states the true count of its group", () => {
    const out = slimEntityMapForPublish(catalogue(1000));
    const group = out.groups?.find((g) => g.types.join() === "Product");
    expect(group?.count).toBe(1000);
    expect(group?.exemplars).toHaveLength(3);
    expect(group?.omitted).toBe(997);
    expect(group?.predicates).toEqual(["brand"]);
    // Few entries, not a 750-node sample.
    expect(out.nodes.length).toBeLessThan(10);
    expect(Value.Check(EntityMapSchema, out)).toBe(true);
  });

  test("a group is never a node: exemplars are real nodes, groups are separate", () => {
    const out = slimEntityMapForPublish(catalogue(100));
    const keys = new Set(out.nodes.map((n) => n.key));
    for (const group of out.groups ?? []) {
      expect(group.kind).toBe("group");
      for (const key of group.exemplars) expect(keys.has(key)).toBe(true);
      expect(group.count).toBe(group.exemplars.length + group.omitted);
    }
  });

  test("truncated still reports what the projection left out", () => {
    const out = slimEntityMapForPublish(catalogue(100));
    expect(out.truncated?.nodes).toBe(101 - out.nodes.length);
    expect(out.summary.nodeCount).toBe(101);
  });

  test("the byte budget still applies to the summarized projection", () => {
    const tiny = {
      ...ENTITY_MAP_PUBLISH_LIMITS,
      maxBytes: 1500,
      maxPageIndexBytes: 0,
    };
    const out = projectEntityMap(catalogue(100), tiny, "publish");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1500);
    expect(out.truncated).toBeDefined();
  });

  test("small groups and unsummarized limits keep plain sampling", () => {
    const small = slimEntityMapForPublish(catalogue(5));
    expect(small.groups).toBeUndefined();
    expect(small.nodes).toHaveLength(6);
    const { summarize: _s, ...plain } = ENTITY_MAP_PUBLISH_LIMITS;
    expect(
      projectEntityMap(catalogue(100), plain, "publish").groups
    ).toBeUndefined();
  });

  test("a node with a conflict stays published even inside a large group", () => {
    const map = catalogue(50);
    const bad = map.nodes.find((n) => n.key === "id:p0049")!;
    bad.conflicts = [
      {
        property: "name",
        values: [
          { value: "a", pages: ["https://shop.test/a"], morePages: 0 },
          { value: "b", pages: ["https://shop.test/b"], morePages: 0 },
        ],
      },
    ];
    const out = slimEntityMapForPublish(map);
    expect(out.nodes.some((n) => n.key === "id:p0049")).toBe(true);
    expect(out.groups?.find((g) => g.types[0] === "Product")?.count).toBe(50);
  });

  test("the markdown section renders a group as a count, not an entity", () => {
    const text = entityMarkdownSection(
      slimEntityMapForPublish(catalogue(1000))
    ).join("\n");
    expect(text).toContain("Entity groups (1)");
    expect(text).toContain("| Product | 1000 | 3 | 997 |");
  });

  test("the full map is untouched: rules keep reading every node", () => {
    const full = catalogue(100);
    slimEntityMapForPublish(full);
    expect(full.nodes).toHaveLength(101);
    expect(full.groups).toBeUndefined();
  });
});
