// The hosted copy of the map rides the publish body, which is measured against
// a hard size gate. What it drops, and what it must never drop, is the contract
// with the cloud side.

import { describe, expect, test } from "bun:test";

import {
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_PUBLISH_LIMITS,
  ENTITY_MAP_VERSION,
  ENTITY_MAP_VIEWER_LIMITS,
  type EntityMap,
  type EntityMapEdge,
  type EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";

import { createEntityMapBuilder } from "../src/entity-map/build";
import { slimEntityMapForPublish, slimEntityMapForViewer } from "../src/entity-map";

function node(
  key: string,
  occurrences: number,
  extra: Partial<EntityMapNode> = {},
): EntityMapNode {
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
    pageLocal: false,
    ...extra,
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
  test("leaves a small map's content alone", () => {
    const small = map([node("a", 3)], [], 0);
    const slim = slimEntityMapForPublish(small);
    // A fresh object every time — the projection always clamps strings, so it
    // can never hand back the caller's own map to be mutated downstream.
    expect(slim).not.toBe(small);
    expect(slim.nodes).toEqual(small.nodes);
    expect(slim.edges).toEqual(small.edges);
    expect(slim.summary).toEqual(small.summary);
  });

  test("clamps a site-controlled string that no count would bound", () => {
    const huge = node("a", 3);
    huge.name = "x".repeat(50_000);
    huge.properties = { name: huge.name, description: "y".repeat(50_000) };
    const slim = slimEntityMapForPublish(map([huge], []));

    expect(slim.nodes[0]!.name!.length).toBeLessThanOrEqual(
      ENTITY_MAP_PUBLISH_LIMITS.maxStringLength,
    );
    expect(slim.nodes[0]!.properties.description!.length).toBeLessThanOrEqual(
      ENTITY_MAP_PUBLISH_LIMITS.maxStringLength,
    );
  });

  test("drops nodes until the serialized map fits the byte budget", () => {
    // Node and edge counts alone do NOT bound bytes: these are all under the
    // node cap and still enormous, which is the case that blew the publish gate.
    // Sized against what SURVIVES clamping, not against raw input: each node
    // keeps 5 conflicts x 5 values x ~512 chars ≈ 18KB, so 400 of them is ~7MB
    // against a 512KB budget and the loop has to drop most of them.
    const fat: EntityMapNode[] = [];
    for (let i = 0; i < 400; i += 1) {
      const n = node(`n${String(i).padStart(4, "0")}`, i);
      n.conflicts = Array.from({ length: 5 }, (_, c) => ({
        property: `p${c}`,
        values: Array.from({ length: 8 }, (_, v) => ({
          value: "z".repeat(4000),
          pages: Array.from({ length: 20 }, (_, p) => `https://example.com/${v}/${p}`),
          morePages: 0,
        })),
      }));
      fat.push(n);
    }
    const slim = slimEntityMapForPublish(map(fat, []));

    expect(JSON.stringify(slim).length).toBeLessThanOrEqual(
      ENTITY_MAP_PUBLISH_LIMITS.maxBytes,
    );
    // The busiest entities are the ones that survived.
    expect(slim.nodes.length).toBeGreaterThan(0);
    expect(slim.summary.nodeCount).toBe(400);
  });

  test("counts the pages it dropped rather than losing them", () => {
    const wide = node("a", 60);
    wide.pages = Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`);
    wide.morePages = 10;
    const slim = slimEntityMapForPublish(map([wide], []));

    expect(slim.nodes[0]!.pages).toHaveLength(ENTITY_MAP_PUBLISH_LIMITS.maxPages);
    // 10 already beyond the document cap, plus the 45 this projection dropped.
    expect(slim.nodes[0]!.morePages).toBe(10 + 50 - ENTITY_MAP_PUBLISH_LIMITS.maxPages);
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

// Every projection states what it dropped. The alternative is a consumer
// inferring it from `summary.nodeCount` against `nodes.length`, which is an
// inference each one has to make separately and any one of them can forget.
describe("projection truncation", () => {
  test("reports the nodes, edges and pages it dropped", () => {
    const many: EntityMapNode[] = [];
    for (let i = 0; i < ENTITY_MAP_PUBLISH_LIMITS.maxNodes + 40; i += 1) {
      many.push(node(`n${String(i).padStart(4, "0")}`, i));
    }
    // An edge between two clipped nodes, so edges are dropped as well.
    const edges = [edge("n0000", "n0001")];
    const slim = slimEntityMapForPublish(map(many, edges, 7));

    expect(slim.truncated).toEqual({
      reason: "publish",
      nodes: 40,
      edges: 1,
      pages: 7,
    });
    // And the counts really do reconcile against the full document.
    expect(slim.nodes.length + slim.truncated!.nodes).toBe(many.length);
    expect(slim.edges.length + slim.truncated!.edges).toBe(edges.length);
  });

  test("still marks a map that lost only its pages", () => {
    // Nothing clipped but `pages`, which both projections always drop. Zero
    // node loss must not read as "nothing was dropped".
    const slim = slimEntityMapForPublish(map([node("a", 1)], [], 3));
    expect(slim.pages).toEqual([]);
    expect(slim.truncated).toEqual({ reason: "publish", nodes: 0, edges: 0, pages: 3 });
  });

  test("names which projection clipped it", () => {
    const small = map([node("a", 1)], [], 0);
    expect(slimEntityMapForPublish(small).truncated!.reason).toBe("publish");
    expect(slimEntityMapForViewer(small).truncated!.reason).toBe("viewer");
  });
});

describe("slimEntityMapForViewer", () => {
  test("bounds the payload a browser has to parse", () => {
    // The shape that made a 5,000-page crawl a 15.3MB inline blob: four
    // entities per page, every one of them carried into the HTML.
    const many: EntityMapNode[] = [];
    for (let i = 0; i < 20_001; i += 1) {
      many.push(node(`n${String(i).padStart(5, "0")}`, (i % 40) + 1));
    }
    const full = map(many, []);
    const viewer = slimEntityMapForViewer(full);

    expect(viewer.nodes).toHaveLength(ENTITY_MAP_VIEWER_LIMITS.maxNodes);
    expect(viewer.truncated!.nodes).toBe(20_001 - ENTITY_MAP_VIEWER_LIMITS.maxNodes);
    expect(JSON.stringify(viewer).length).toBeLessThanOrEqual(
      ENTITY_MAP_VIEWER_LIMITS.maxBytes,
    );
    // An order of magnitude, not a few percent — the point of the projection.
    expect(JSON.stringify(viewer).length).toBeLessThan(
      JSON.stringify(full).length / 5,
    );
  });

  test("keeps more per node than the publish copy, because this one is read", () => {
    const wide = node("a", 3);
    wide.pages = Array.from({ length: 50 }, (_, i) => `https://example.com/p${i}`);
    wide.morePages = 10;
    wide.properties = { description: "d".repeat(1500) };

    const viewer = slimEntityMapForViewer(map([wide], []));
    const published = slimEntityMapForPublish(map([wide], []));

    // The detail panel lists twelve pages; the publish copy keeps five.
    expect(viewer.nodes[0]!.pages).toHaveLength(ENTITY_MAP_VIEWER_LIMITS.maxPages);
    expect(published.nodes[0]!.pages).toHaveLength(ENTITY_MAP_PUBLISH_LIMITS.maxPages);
    // Both still account for every page they did not list.
    expect(viewer.nodes[0]!.pages.length + viewer.nodes[0]!.morePages).toBe(60);
    expect(published.nodes[0]!.pages.length + published.nodes[0]!.morePages).toBe(60);
    // A description survives at viewer width and is cut at publish width.
    expect(viewer.nodes[0]!.properties.description).toHaveLength(1500);
    expect(published.nodes[0]!.properties.description).toHaveLength(
      ENTITY_MAP_PUBLISH_LIMITS.maxStringLength,
    );
  });

  test("leaves the summary describing the site, not the projection", () => {
    const many: EntityMapNode[] = [];
    for (let i = 0; i < ENTITY_MAP_VIEWER_LIMITS.maxNodes + 500; i += 1) {
      many.push(node(`n${String(i).padStart(5, "0")}`, i));
    }
    const viewer = slimEntityMapForViewer(map(many, [], 5_000));
    expect(viewer.summary.nodeCount).toBe(many.length);
    expect(viewer.summary.pagesTotal).toBe(5_000);
  });

  test("is deterministic", () => {
    const many: EntityMapNode[] = [];
    for (let i = 0; i < ENTITY_MAP_VIEWER_LIMITS.maxNodes + 30; i += 1) {
      many.push(node(`n${String(i).padStart(5, "0")}`, i % 7));
    }
    const source = map(many, []);
    expect(JSON.stringify(slimEntityMapForViewer(source))).toBe(
      JSON.stringify(slimEntityMapForViewer(source)),
    );
  });
});

// The published body is a SAMPLE of the map, and a sample that misrepresents the
// site is worse than a smaller one: it still validates, still carries true
// totals in `summary`, and quietly describes a different store.
//
// The shape that broke it is the ordinary one. A Shopify or WooCommerce store
// declares its entities per page, so Product, Offer, BreadcrumbList and WebPage
// all occur exactly once and a ranking on occurrences alone falls through to its
// tie-break. Alphabetical on `key` groups a page's entities together, so the
// budget walked the catalogue from item-0 and stopped — 125 of each of the three
// types whose keys sort first, and not one Offer at any crawl size.
describe("publish sample composition", () => {
  const SITE = "https://shop.test";

  /** One page of a per-page-entity store, the shape the sampler has to survive. */
  function storePageJsonLd(i: number): string {
    const url = `${SITE}/products/item-${i}`;
    return JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Product",
          "@id": `${url}#product`,
          name: `Product ${i}`,
          url,
          description: `Synthetic product ${i}. `.repeat(3),
          image: Array.from({ length: 5 }, (_, k) => `${SITE}/cdn/${i}-${k}.jpg`),
          brand: { "@id": `${SITE}/#brand` },
          offers: {
            "@type": "Offer",
            price: String(10 + (i % 90)),
            priceCurrency: "USD",
            url,
          },
        },
        {
          "@type": "Organization",
          "@id": `${SITE}/#organization`,
          name: "Shop Co",
          url: SITE,
          logo: `${SITE}/cdn/logo.png`,
          sameAs: ["https://example.com/shopco"],
        },
        { "@type": "Brand", "@id": `${SITE}/#brand`, name: "Shop Brand" },
        {
          "@type": "BreadcrumbList",
          "@id": `${url}#breadcrumb`,
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: SITE },
            { "@type": "ListItem", position: 2, name: `Item ${i}`, item: url },
          ],
        },
        {
          "@type": "WebPage",
          "@id": `${url}#webpage`,
          url,
          name: `Item ${i}`,
          publisher: { "@id": `${SITE}/#organization` },
        },
      ],
    });
  }

  function storeMap(pages: number): EntityMap {
    const builder = createEntityMapBuilder();
    for (let i = 0; i < pages; i += 1) {
      builder.addPage(`${SITE}/products/item-${i}`, storePageJsonLd(i));
    }
    return builder.finish(SITE, { generatedAt: "2026-01-01T00:00:00.000Z" });
  }

  function countsByType(nodes: EntityMapNode[]): Record<string, number> {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.types[0]!, (counts.get(n.types[0]!) ?? 0) + 1);
    return Object.fromEntries(counts);
  }

  // Built once: 1,000 pages of JSON-LD is the fixture, not the thing measured.
  const thousand = storeMap(1_000);
  const published = slimEntityMapForPublish(thousand);
  const counts = countsByType(published.nodes);

  test("the fixture really is the degenerate case", () => {
    // Every assertion below is only interesting because these hold: one entity
    // of each type per page, all of them occurring exactly once.
    expect(thousand.nodes.length).toBe(4_002);
    const perPage = thousand.nodes.filter((n) => n.occurrences === 1);
    expect(perPage.length).toBe(4_000);
  });

  test("publishes every entity type, not the ones whose keys sort first", () => {
    // Offer is the one the alphabetical slab lost completely: revert the ranking
    // to `occurrences || key` and this line fails with `undefined`.
    for (const type of ["Product", "Offer", "Organization", "Brand", "BreadcrumbList"]) {
      expect(counts[type]).toBeGreaterThan(0);
    }
    expect(Object.keys(counts).length).toBe(6);
  });

  test("no type takes more than its quota of the sample", () => {
    // Equal shares with redistribution, so no type may hold more than a
    // round-robin over the types present could have handed it. The tier of
    // one-off subjects is where the old ranking collapsed: it gave one type a
    // third of the entire body and another type nothing.
    const oneOff = published.nodes.filter((n) => !n.pageLocal && n.occurrences === 1);
    const types = new Set(oneOff.map((n) => n.types[0]!));
    const quota = Math.ceil(oneOff.length / types.size);
    expect(types.size).toBe(2);
    for (const count of Object.values(countsByType(oneOff))) {
      expect(count).toBeLessThanOrEqual(quota);
    }
  });

  test("the site-wide subjects always survive", () => {
    // Declared on all 1,000 pages: whatever else is clipped, these are the
    // entities the map exists to show.
    const keys = new Set(published.nodes.map((n) => n.key));
    expect(keys.has(`id:${SITE}/#organization`)).toBe(true);
    expect(keys.has(`id:${SITE}/#brand`)).toBe(true);
  });

  test("page-local entities are capped, not ranked alongside subjects", () => {
    const pageLocal = published.nodes.filter((n) => n.pageLocal);
    expect(pageLocal.length).toBeGreaterThan(0);
    expect(pageLocal.length).toBeLessThanOrEqual(
      Math.ceil(published.nodes.length * ENTITY_MAP_PUBLISH_LIMITS.maxPageLocalShare),
    );
    // Both page-local types are represented inside that slice.
    const localTypes = countsByType(pageLocal);
    expect(localTypes.BreadcrumbList).toBeGreaterThan(0);
    expect(localTypes.WebPage).toBeGreaterThan(0);
  });

  test("spends the whole node budget on a store this size", () => {
    // 4,002 entities to choose 750 from, and the clamped sample fits the gate on
    // the first attempt, so nothing here is decided by the byte loop.
    expect(published.nodes).toHaveLength(ENTITY_MAP_PUBLISH_LIMITS.maxNodes);
    expect(JSON.stringify(published).length).toBeLessThanOrEqual(
      ENTITY_MAP_PUBLISH_LIMITS.maxBytes,
    );
  });

  test("keeps the edges self-consistent with the sample", () => {
    const keys = new Set(published.nodes.map((n) => n.key));
    for (const e of published.edges) {
      expect(keys.has(e.source)).toBe(true);
      if (!e.dangling) expect(keys.has(e.target)).toBe(true);
    }
    expect(published.summary.nodeCount).toBe(thousand.nodes.length);
    expect(published.nodes.length + published.truncated!.nodes).toBe(
      thousand.nodes.length,
    );
  });

  test("does not get less representative as the crawl grows", () => {
    // The old sampler published the same 375 alphabetical nodes at 500 pages and
    // at 5,000, so the map stopped describing the store somewhere around 500.
    const small = slimEntityMapForPublish(storeMap(200));
    const large = slimEntityMapForPublish(storeMap(2_000));
    for (const slim of [small, large]) {
      const types = countsByType(slim.nodes);
      expect(types.Offer).toBeGreaterThan(0);
      expect(types.Organization).toBe(1);
      expect(JSON.stringify(slim).length).toBeLessThanOrEqual(
        ENTITY_MAP_PUBLISH_LIMITS.maxBytes,
      );
    }
  }, 30_000);

  test("is deterministic", () => {
    expect(JSON.stringify(slimEntityMapForPublish(thousand))).toBe(
      JSON.stringify(published),
    );
  });
});

describe("publish sample tiers", () => {
  test("gives a type-poor map's unused page-local slice back to the subjects", () => {
    // The reserve is a cap on page-local entities, not a floor under them: a map
    // with almost nothing but page-local nodes still publishes a full budget.
    const nodes = [
      node("subject", 40),
      ...Array.from({ length: 2_000 }, (_, i) =>
        node(`local:${String(i).padStart(4, "0")}`, 1, {
          types: ["WebPage"],
          pageLocal: true,
        }),
      ),
    ];
    const slim = slimEntityMapForPublish(map(nodes, []));
    expect(slim.nodes).toHaveLength(ENTITY_MAP_PUBLISH_LIMITS.maxNodes);
    expect(slim.nodes.filter((n) => n.pageLocal)).toHaveLength(
      ENTITY_MAP_PUBLISH_LIMITS.maxNodes - 1,
    );
  });

  test("scales the sample to a byte overshoot instead of halving it", () => {
    // Every node the same size, so what survives is decided by the byte loop and
    // nothing else: 750 of them clear the gate by a little, and halving the
    // budget at the first overshoot threw away half the map to shed that little.
    const heavy = Array.from({ length: 1_000 }, (_, i) => {
      const n = node(`n${String(i).padStart(4, "0")}`, 1_000 - i);
      n.properties = { description: "d".repeat(600) };
      n.pages = Array.from({ length: 5 }, (_, p) => `https://example.com/page-${p}`);
      return n;
    });
    const slim = slimEntityMapForPublish(map(heavy, []));
    const bytes = JSON.stringify(slim).length;

    expect(bytes).toBeLessThanOrEqual(ENTITY_MAP_PUBLISH_LIMITS.maxBytes);
    // Halving lands on 375 nodes and roughly 265KB of a 512KB gate.
    expect(slim.nodes.length).toBeGreaterThan(450);
    expect(bytes).toBeGreaterThan(ENTITY_MAP_PUBLISH_LIMITS.maxBytes * 0.9);
  });

  test("a one-off entity's inbound edges decide which of its type survives", () => {
    // Degree counts BOTH directions: an Offer is only ever pointed AT, so
    // ranking on outbound edges alone would leave every one of them at zero.
    const nodes = [
      node("hub", 5),
      ...Array.from({ length: 1_000 }, (_, i) =>
        node(`off:${String(i).padStart(4, "0")}`, 1, { types: ["Offer"] }),
      ),
    ];
    // Only the LAST of them is referenced, so alphabetical order would drop it.
    const referenced = "off:0999";
    const slim = slimEntityMapForPublish(map(nodes, [edge("hub", referenced)]));
    expect(slim.nodes.map((n) => n.key)).toContain(referenced);
    expect(slim.edges).toHaveLength(1);
  });
});
