// `squirrel entities` filters (#2092).
//
// The property these pin is that a filter produces a MAP, not a view: `-f
// graphml --type Organization` has to hand Gephi the filtered graph, and the
// summary has to describe what survived. A filtered map that kept the whole
// site's counts would be actively misleading, since the first thing a reader
// does with `--problem conflict` is look at the conflict count.

import type {
  EntityMap,
  EntityMapEdge,
  EntityMapNode,
} from "@squirrelscan/audit-engine/entity-map";

import { describe, expect, test } from "bun:test";

import {
  ENTITY_PROBLEMS,
  filterEntityMap,
  findEntity,
  hasEntityFilters,
  isEntityProblem,
  splitListFlag,
} from "@/entities/filters";

function node(overrides: Partial<EntityMapNode> = {}): EntityMapNode {
  return {
    key: "id:https://example.com/#org",
    id: "https://example.com/#org",
    types: ["Organization"],
    name: "Acme",
    properties: {},
    occurrences: 4,
    pages: ["https://example.com/a"],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
    ...overrides,
  };
}

const CONFLICT = {
  property: "logo",
  values: [
    { value: "a", pages: ["https://example.com/a"], morePages: 0 },
    { value: "b", pages: ["https://example.com/b"], morePages: 0 },
  ],
};

const NODES: EntityMapNode[] = [
  node(),
  node({
    key: "syn:Person|name:ada",
    id: null,
    types: ["Person"],
    name: "Ada Lovelace",
    pages: ["https://example.com/blog/one", "https://example.com/blog/two"],
  }),
  node({
    key: "id:https://example.com/#conflicted",
    id: "https://example.com/#conflicted",
    types: ["Product"],
    name: "Widget",
    conflicts: [CONFLICT],
  }),
  node({
    key: "id:https://example.com/#dangly",
    id: "https://example.com/#dangly",
    types: ["Article"],
    name: "A post",
    danglingRefs: 2,
  }),
  // Same type set and name as the first, under a different id: the
  // split-identity finding.
  node({
    key: "id:http://other.example/#org",
    id: "http://other.example/#org",
    types: ["Organization"],
    name: "Acme",
  }),
];

const EDGES: EntityMapEdge[] = [
  {
    source: "id:https://example.com/#org",
    predicate: "author",
    target: "syn:Person|name:ada",
    dangling: false,
    occurrences: 2,
    pages: [],
    morePages: 0,
  },
  {
    source: "id:https://example.com/#dangly",
    predicate: "publisher",
    target: "id:https://example.com/#missing",
    dangling: true,
    occurrences: 1,
    pages: [],
    morePages: 0,
  },
];

const MAP: EntityMap = {
  format: "squirrelscan/entity-map",
  version: 1,
  site: "https://example.com/",
  generatedAt: "2026-01-01T00:00:00.000Z",
  summary: {
    nodeCount: NODES.length,
    edgeCount: EDGES.length,
    danglingCount: 1,
    pagesTotal: 4,
    pagesWithoutEntities: 1,
    nodesWithStableId: 4,
    stableIdShare: 4 / 5,
    pageLocalCount: 0,
    nodesWithoutIdCount: 1,
    conflictCount: 1,
    countsByType: { Organization: 8 },
  },
  nodes: NODES,
  edges: EDGES,
  pages: [],
};

describe("splitListFlag", () => {
  test("accepts a comma-separated value, a repeated flag, and both", () => {
    expect(splitListFlag("a,b")).toEqual(["a", "b"]);
    expect(splitListFlag(["a", "b"])).toEqual(["a", "b"]);
    expect(splitListFlag([" a , b ", "c"])).toEqual(["a", "b", "c"]);
    expect(splitListFlag(undefined)).toEqual([]);
    expect(splitListFlag("")).toEqual([]);
  });
});

describe("isEntityProblem", () => {
  test("accepts every documented value and nothing else", () => {
    for (const problem of ENTITY_PROBLEMS)
      expect(isEntityProblem(problem)).toBe(true);
    expect(isEntityProblem("no-ids")).toBe(false);
    expect(isEntityProblem("")).toBe(false);
  });
});

describe("filterEntityMap", () => {
  test("no filter returns the map untouched", () => {
    expect(hasEntityFilters({})).toBe(false);
    expect(filterEntityMap(MAP, {})).toBe(MAP);
  });

  test("--type matches case-insensitively and accepts several", () => {
    expect(
      filterEntityMap(MAP, { types: ["organization"] }).nodes
    ).toHaveLength(2);
    expect(
      filterEntityMap(MAP, { types: ["Person", "Product"] }).nodes.map(
        (n) => n.name
      )
    ).toEqual(["Ada Lovelace", "Widget"]);
  });

  test("--page matches an exact URL or a prefix", () => {
    expect(
      filterEntityMap(MAP, { pages: ["https://example.com/a"] }).nodes
    ).toHaveLength(4);
    expect(
      filterEntityMap(MAP, { pages: ["/blog/"] }).nodes.map((n) => n.name)
    ).toEqual(["Ada Lovelace"]);
  });

  test("--page uses the uncapped page index, not the node's sample", () => {
    // `node.pages` is capped in the document; `map.pages[].declares` is not. An
    // entity declared past the cap must still match a query for that page.
    const wide = node({
      key: "id:https://example.com/#wide",
      id: "https://example.com/#wide",
      name: "Wide",
      pages: ["https://example.com/a"],
      morePages: 1,
    });
    const withIndex: EntityMap = {
      ...MAP,
      nodes: [...NODES, wide],
      pages: [
        {
          url: "https://example.com/a",
          declares: [],
          references: [],
          entityCount: 0,
        },
        {
          url: "https://example.com/beyond-the-cap",
          declares: ["id:https://example.com/#wide"],
          references: [],
          entityCount: 1,
        },
      ],
    };

    expect(
      filterEntityMap(withIndex, { pages: ["/beyond-the-cap"] }).nodes.map(
        (n) => n.key
      )
    ).toEqual(["id:https://example.com/#wide"]);
  });

  test("--page falls back to the node's own list when there is no index", () => {
    // A map clipped for a publish payload carries no pages. Filtering
    // everything out would be worse than using the sample it does have.
    expect(
      filterEntityMap(MAP, { pages: ["/blog/"] }).nodes.map((n) => n.name)
    ).toEqual(["Ada Lovelace"]);
  });

  test("--page takes the UNION of the two records, not one or the other", () => {
    // A partial index is the dangerous middle case: present, so a naive
    // implementation trusts it, but missing the page this entity is on. The
    // node's own list still has it, and the union keeps it.
    const partialIndex: EntityMap = {
      ...MAP,
      pages: [
        {
          url: "https://example.com/somewhere-else",
          declares: [],
          references: [],
          entityCount: 0,
        },
      ],
    };
    expect(
      filterEntityMap(partialIndex, { pages: ["/blog/"] }).nodes.map(
        (n) => n.name
      )
    ).toEqual(["Ada Lovelace"]);
  });

  test("--problem split-identity cannot be forged with a separator in a type", () => {
    // `@type` is site-controlled: joining the sorted set with "+" makes
    // ["Organization+X"] and ["Organization","X"] the same signature.
    const forged: EntityMap = {
      ...MAP,
      nodes: [
        node({ key: "a", types: ["Organization+X"], name: "Acme Two" }),
        node({ key: "b", types: ["Organization", "X"], name: "Acme Two" }),
      ],
    };
    expect(
      filterEntityMap(forged, { problems: ["split-identity"] }).nodes
    ).toHaveLength(0);
  });

  test("--problem no-id finds only multi-page entities without one", () => {
    const out = filterEntityMap(MAP, { problems: ["no-id"] });
    // A one-page entity with no `@id` is ordinary and must not be flagged.
    expect(out.nodes.map((n) => n.name)).toEqual(["Ada Lovelace"]);
  });

  test("--problem conflict, dangling and single-page each select their own", () => {
    expect(
      filterEntityMap(MAP, { problems: ["conflict"] }).nodes.map((n) => n.name)
    ).toEqual(["Widget"]);
    expect(
      filterEntityMap(MAP, { problems: ["dangling"] }).nodes.map((n) => n.name)
    ).toEqual(["A post"]);
    expect(
      filterEntityMap(MAP, { problems: ["single-page"] }).nodes
    ).toHaveLength(4);
  });

  test("--problem split-identity finds one thing under two identities", () => {
    const out = filterEntityMap(MAP, { problems: ["split-identity"] });
    expect(out.nodes.map((n) => n.key).sort()).toEqual([
      "id:http://other.example/#org",
      "id:https://example.com/#org",
    ]);
  });

  test("filters combine as AND", () => {
    expect(
      filterEntityMap(MAP, {
        types: ["Organization"],
        problems: ["split-identity"],
      }).nodes
    ).toHaveLength(2);
    expect(
      filterEntityMap(MAP, { types: ["Person"], problems: ["conflict"] }).nodes
    ).toHaveLength(0);
  });

  test("the summary describes what survived, not the whole site", () => {
    const out = filterEntityMap(MAP, { problems: ["conflict"] });
    expect(out.summary.nodeCount).toBe(1);
    expect(out.summary.conflictCount).toBe(1);
    expect(out.summary.danglingCount).toBe(0);
    // `pages` describes the crawl, not the selection, so it is left whole.
    expect(out.summary.pagesTotal).toBe(4);
  });

  test("edges follow their endpoints, and a dangling edge follows its source", () => {
    expect(
      filterEntityMap(MAP, { types: ["Organization"] }).edges
    ).toHaveLength(0);
    const dangly = filterEntityMap(MAP, { types: ["Article"] });
    // Requiring both ends would drop every dangling edge, since the target is
    // not a node by definition — which is the one thing worth seeing.
    expect(dangly.edges).toHaveLength(1);
    expect(dangly.edges[0]!.dangling).toBe(true);
  });
});

describe("findEntity", () => {
  test("matches @id, key, bare id, exact name and partial name in that order", () => {
    expect(findEntity(MAP, "https://example.com/#org")?.key).toBe(
      "id:https://example.com/#org"
    );
    expect(findEntity(MAP, "syn:Person|name:ada")?.name).toBe("Ada Lovelace");
    expect(findEntity(MAP, "Widget")?.key).toBe(
      "id:https://example.com/#conflicted"
    );
    expect(findEntity(MAP, "ada lovelace")?.name).toBe("Ada Lovelace");
    expect(findEntity(MAP, "lovelace")?.name).toBe("Ada Lovelace");
  });

  test("an @id wins over an entity merely named after it", () => {
    const shadow = node({
      key: "syn:Thing|name:x",
      id: null,
      types: ["Thing"],
      name: "https://example.com/#org",
    });
    const withShadow: EntityMap = { ...MAP, nodes: [shadow, ...NODES] };
    expect(findEntity(withShadow, "https://example.com/#org")?.key).toBe(
      "id:https://example.com/#org"
    );
  });

  test("returns null for no match and for an empty query", () => {
    expect(findEntity(MAP, "nothing here")).toBeNull();
    expect(findEntity(MAP, "   ")).toBeNull();
  });
});
