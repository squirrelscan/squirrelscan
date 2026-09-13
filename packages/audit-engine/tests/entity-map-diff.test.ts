// Golden tests for `diffEntityMaps` (#2092, epic section 9), one per change
// kind, plus the real before/after pair from our own docs site.
//
// The property worth most here is the one about coverage: an entity missing
// from the newer map is only `removed` when every page that declared it was
// crawled again. Everything else is set arithmetic; that one is the difference
// between a useful diff and one that cries wolf every time a crawl is smaller.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import {
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_VERSION,
  EntityMapDiffSchema,
  type EntityMap,
  type EntityMapEdge,
  type EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";

import { diffEntityMaps } from "../src/entity-map";

const AT = "2026-01-01T00:00:00.000Z";

function node(overrides: Partial<EntityMapNode> = {}): EntityMapNode {
  return {
    key: "id:https://example.com/#org",
    id: "https://example.com/#org",
    types: ["Organization"],
    name: "Acme",
    properties: { name: "Acme" },
    occurrences: 4,
    pages: ["https://example.com/a"],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
    ...overrides,
  };
}

function edge(overrides: Partial<EntityMapEdge> = {}): EntityMapEdge {
  return {
    source: "id:https://example.com/#org",
    predicate: "publisher",
    target: "id:https://example.com/#missing",
    dangling: true,
    occurrences: 1,
    pages: ["https://example.com/a"],
    morePages: 0,
    ...overrides,
  };
}

function map(nodes: EntityMapNode[], edges: EntityMapEdge[], pageUrls: string[]): EntityMap {
  return {
    format: ENTITY_MAP_FORMAT,
    version: ENTITY_MAP_VERSION,
    site: "https://example.com/",
    generatedAt: AT,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((e) => e.dangling).length,
      pagesTotal: pageUrls.length,
      pagesWithoutEntities: 0,
      nodesWithStableId: nodes.filter((n) => n.id !== null).length,
      stableIdShare: nodes.length === 0 ? 0 : nodes.filter((n) => n.id !== null).length / nodes.length,
      pageLocalCount: nodes.filter((n) => n.pageLocal).length,
      nodesWithoutIdCount: nodes.filter((n) => n.id === null && n.pages.length > 1).length,
      conflictCount: nodes.filter((n) => n.conflicts.length > 0).length,
      countsByType: {},
    },
    nodes,
    edges,
    pages: pageUrls.map((url) => ({ url, declares: [], references: [], entityCount: 0 })),
  };
}

/** A map whose page index is complete, so coverage can actually be proven. */
function mapWith(
  nodes: EntityMapNode[],
  edges: EntityMapEdge[],
  declaresByPage: Record<string, string[]>,
  pagesTotal?: number,
): EntityMap {
  const base = map(nodes, edges, Object.keys(declaresByPage));
  return {
    ...base,
    summary: { ...base.summary, pagesTotal: pagesTotal ?? Object.keys(declaresByPage).length },
    pages: Object.entries(declaresByPage).map(([url, declares]) => ({
      url,
      declares,
      references: [],
      entityCount: declares.length,
    })),
  };
}

const PAGES = ["https://example.com/a", "https://example.com/b"];

function diff(older: EntityMap, newer: EntityMap) {
  return diffEntityMaps(older, newer, { generatedAt: AT });
}

describe("diffEntityMaps", () => {
  test("the result validates against the shared schema", () => {
    const result = diff(map([node()], [], PAGES), map([node()], [], PAGES));
    expect(Value.Check(EntityMapDiffSchema, result)).toBe(true);
    expect(result.format).toBe("squirrelscan/entity-map-diff");
    expect(result.version).toBe(1);
  });

  test("added: declared in the newer map only", () => {
    const extra = node({ key: "id:https://example.com/#person", id: "https://example.com/#person", types: ["Person"], name: "Ada" });
    const result = diff(map([node()], [], PAGES), map([node(), extra], [], PAGES));

    expect(result.added.map((n) => n.key)).toEqual(["id:https://example.com/#person"]);
    expect(result.removed).toHaveLength(0);
    expect(result.notCrawled).toHaveLength(0);
  });

  test("removed: gone, and every declaring page was crawled again", () => {
    const gone = node({ key: "id:https://example.com/#gone", id: "https://example.com/#gone", name: "Gone", pages: ["https://example.com/a"] });
    const result = diff(map([node(), gone], [], PAGES), map([node()], [], PAGES));

    expect(result.removed.map((n) => n.key)).toEqual(["id:https://example.com/#gone"]);
    expect(result.notCrawled).toHaveLength(0);
  });

  test("notCrawled: gone, but a declaring page was not visited again", () => {
    // The case that makes a naive diff lie. The newer audit never looked at /b,
    // so an entity declared only there has NOT been shown to be removed.
    const onlyOnB = node({
      key: "id:https://example.com/#onb",
      id: "https://example.com/#onb",
      name: "On B",
      pages: ["https://example.com/b"],
    });
    const result = diff(
      map([node(), onlyOnB], [], PAGES),
      map([node()], [], ["https://example.com/a"]),
    );

    expect(result.notCrawled.map((n) => n.key)).toEqual(["id:https://example.com/#onb"]);
    expect(result.removed).toHaveLength(0);
    expect(result.pagesOnlyInOlder).toEqual(["https://example.com/b"]);
  });

  test("a page the newer crawl visited that now declares nothing IS a removal", () => {
    // The mirror of the test above, and the reason the page set comes from the
    // crawl rather than from the entities: /b was visited and simply lost its
    // markup, which is a real finding and must not hide in notCrawled.
    const onlyOnB = node({
      key: "id:https://example.com/#onb",
      id: "https://example.com/#onb",
      name: "On B",
      pages: ["https://example.com/b"],
    });
    const result = diff(map([node(), onlyOnB], [], PAGES), map([node()], [], PAGES));

    expect(result.removed.map((n) => n.key)).toEqual(["id:https://example.com/#onb"]);
    expect(result.notCrawled).toHaveLength(0);
  });

  test("gainedId: matched across the key change, and not double-counted", () => {
    const before = node({ key: "syn:Organization|name:acme", id: null, name: "Acme" });
    const after = node({ key: "id:https://example.com/#org", id: "https://example.com/#org", name: "Acme" });
    const result = diff(map([before], [], PAGES), map([after], [], PAGES));

    expect(result.gainedId).toHaveLength(1);
    expect(result.gainedId[0]!.beforeKey).toBe("syn:Organization|name:acme");
    expect(result.gainedId[0]!.afterKey).toBe("id:https://example.com/#org");
    expect(result.gainedId[0]!.id).toBe("https://example.com/#org");
    // The whole point: not an add plus a remove.
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    // /a is the only page that declared the id-less version, and the newer
    // crawl visited it, so the fix is proven across the whole site.
    expect(result.gainedId[0]!.coverage).toBe("proven");
  });

  test("gainedId on pages the newer crawl never visited is reported as partial", () => {
    // The failure this field exists for. An agent fixes an entity, re-audits a
    // narrower slice of the site, and asks whether the fix landed. Identity
    // matching says yes — it IS the same entity — but the pages that were
    // broken were never looked at again, so "yes" would be a guess dressed as
    // a verification.
    const before = node({
      key: "syn:Organization|name:acme",
      id: null,
      name: "Acme",
      pages: ["https://example.com/a", "https://example.com/b"],
    });
    const after = node({
      key: "id:https://example.com/#org",
      id: "https://example.com/#org",
      name: "Acme",
      pages: ["https://example.com/c", "https://example.com/d"],
    });
    const result = diff(
      map([before], [], ["https://example.com/a", "https://example.com/b"]),
      map([after], [], ["https://example.com/c", "https://example.com/d"]),
    );

    expect(result.gainedId).toHaveLength(1);
    expect(result.gainedId[0]!.coverage).toBe("partial");
    // Still one change rather than an add plus a remove: the pairing is
    // correct, only the claim about reach is weaker.
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.notCrawled).toHaveLength(0);
  });

  test("markup deleted from the broken pages is not a proven fix", () => {
    // Recrawling the broken pages is necessary and NOT sufficient. Here /a and
    // /b were both visited again and the anonymous entity really is gone from
    // them — because the markup was deleted, not fixed — while an identified
    // entity of the same name turned up on /c. Coverage-by-recrawl alone calls
    // that proven. It is a regression on /a and /b plus an addition on /c.
    const before = node({
      key: "syn:Organization|name:acme",
      id: null,
      name: "Acme",
      pages: ["https://example.com/a", "https://example.com/b"],
    });
    const after = node({
      key: "id:https://example.com/#org",
      id: "https://example.com/#org",
      name: "Acme",
      pages: ["https://example.com/c"],
    });
    const result = diff(
      mapWith([before], [], {
        "https://example.com/a": ["syn:Organization|name:acme"],
        "https://example.com/b": ["syn:Organization|name:acme"],
      }),
      mapWith([after], [], {
        "https://example.com/a": [],
        "https://example.com/b": [],
        "https://example.com/c": ["id:https://example.com/#org"],
      })
    );

    expect(result.gainedId).toHaveLength(1);
    expect(result.gainedId[0]!.coverage).toBe("partial");
  });

  test("the replacement on every page the original had IS proven", () => {
    // The mirror: same pages, markup actually fixed in place.
    const before = node({
      key: "syn:Organization|name:acme",
      id: null,
      name: "Acme",
      pages: ["https://example.com/a", "https://example.com/b"],
    });
    const after = node({
      key: "id:https://example.com/#org",
      id: "https://example.com/#org",
      name: "Acme",
      pages: ["https://example.com/a", "https://example.com/b"],
    });
    const declares = {
      "https://example.com/a": ["syn:Organization|name:acme"],
      "https://example.com/b": ["syn:Organization|name:acme"],
    };
    const fixed = {
      "https://example.com/a": ["id:https://example.com/#org"],
      "https://example.com/b": ["id:https://example.com/#org"],
    };
    const result = diff(mapWith([before], [], declares), mapWith([after], [], fixed));

    expect(result.gainedId).toHaveLength(1);
    expect(result.gainedId[0]!.coverage).toBe("proven");
  });

  test("a capped page list can never prove coverage", () => {
    // `morePages > 0` means the node carries a SAMPLE of its pages, so
    // recrawling every page it lists proves nothing about the rest.
    const before = node({
      key: "syn:Organization|name:acme",
      id: null,
      name: "Acme",
      pages: ["https://example.com/a"],
      morePages: 40,
    });
    const after = node({
      key: "id:https://example.com/#org",
      id: "https://example.com/#org",
      name: "Acme",
    });
    const result = diff(map([before], [], PAGES), map([after], [], PAGES));

    expect(result.gainedId[0]!.coverage).toBe("partial");
  });

  test("lostId: the same match in reverse", () => {
    const before = node({ key: "id:https://example.com/#org", id: "https://example.com/#org", name: "Acme" });
    const after = node({ key: "syn:Organization|name:acme", id: null, name: "Acme" });
    const result = diff(map([before], [], PAGES), map([after], [], PAGES));

    expect(result.lostId).toHaveLength(1);
    expect(result.lostId[0]!.id).toBe("https://example.com/#org");
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  test("occurrenceDeltas honour the threshold", () => {
    const older = map([node({ occurrences: 4 })], [], PAGES);
    const newer = map([node({ occurrences: 9 })], [], PAGES);

    expect(diff(older, newer).occurrenceDeltas).toEqual([
      {
        key: "id:https://example.com/#org",
        name: "Acme",
        types: ["Organization"],
        before: 4,
        after: 9,
        delta: 5,
      },
    ]);
    expect(
      diffEntityMaps(older, newer, { generatedAt: AT, occurrenceThreshold: 6 }).occurrenceDeltas,
    ).toHaveLength(0);
  });

  test("conflicts: new and resolved, per property", () => {
    const conflict = (property: string) => ({
      property,
      values: [
        { value: "a", pages: ["https://example.com/a"], morePages: 0 },
        { value: "b", pages: ["https://example.com/b"], morePages: 0 },
      ],
    });
    const older = map([node({ conflicts: [conflict("logo")] })], [], PAGES);
    const newer = map([node({ conflicts: [conflict("url")] })], [], PAGES);
    const result = diff(older, newer);

    // A swap is BOTH a fix and a regression; collapsing it to "still
    // conflicted" would hide each behind the other.
    expect(result.newConflicts).toEqual([
      { key: "id:https://example.com/#org", name: "Acme", property: "url" },
    ]);
    expect(result.resolvedConflicts).toEqual([
      { key: "id:https://example.com/#org", name: "Acme", property: "logo" },
    ]);
  });

  test("a conflict on an entity that vanished is not a resolution", () => {
    const gone = node({
      key: "id:https://example.com/#gone",
      id: "https://example.com/#gone",
      conflicts: [
        {
          property: "logo",
          values: [
            { value: "a", pages: ["https://example.com/a"], morePages: 0 },
            { value: "b", pages: ["https://example.com/a"], morePages: 0 },
          ],
        },
      ],
    });
    const result = diff(map([gone], [], PAGES), map([], [], PAGES));
    expect(result.resolvedConflicts).toHaveLength(0);
  });

  test("dangling: new and resolved", () => {
    const older = map([node()], [edge()], PAGES);
    const newer = map([node()], [], PAGES);
    expect(diff(older, newer).resolvedDangling).toEqual([
      {
        source: "id:https://example.com/#org",
        predicate: "publisher",
        target: "id:https://example.com/#missing",
      },
    ]);
    expect(diff(newer, older).newDangling).toHaveLength(1);
  });

  test("summaryDelta carries every numeric metric", () => {
    const result = diff(map([node()], [], PAGES), map([node(), node({ key: "b", id: null })], [], PAGES));
    expect(result.summaryDelta.nodeCount).toEqual({ before: 1, after: 2, delta: 1 });
    expect(result.summaryDelta.countsByType).toBeUndefined();
    expect(typeof result.summaryDelta.stableIdShare?.delta).toBe("number");
  });

  test("is deterministic", () => {
    const older = map([node(), node({ key: "b", id: null, name: "B" })], [edge()], PAGES);
    const newer = map([node({ occurrences: 9 })], [], ["https://example.com/a"]);
    expect(JSON.stringify(diff(older, newer))).toBe(JSON.stringify(diff(older, newer)));
  });
});

describe("coverage is proven, not sampled", () => {
  // `node.pages` is capped at 50 in the document and `morePages` counts the
  // rest, so an entity on 101 pages carries a 50-page sample. Deciding removal
  // on the sample is how "we recrawled the first 50" becomes "the site deleted
  // its structured data".
  const WIDE = node({
    key: "id:https://example.com/#wide",
    id: "https://example.com/#wide",
    name: "Wide",
    pages: ["https://example.com/a"],
    morePages: 1,
  });

  test("a page beyond the node's sample still blocks a removal", () => {
    // /a is in the sample and was recrawled; /b is only in the page index and
    // was not. Sampling says removed; the index says we cannot know.
    const older = mapWith([WIDE], [], {
      "https://example.com/a": ["id:https://example.com/#wide"],
      "https://example.com/b": ["id:https://example.com/#wide"],
    });
    const newer = mapWith([], [], { "https://example.com/a": [] });

    const result = diff(older, newer);
    expect(result.notCrawled.map((n) => n.key)).toEqual(["id:https://example.com/#wide"]);
    expect(result.removed).toHaveLength(0);
  });

  test("recrawling every indexed page does make it a removal", () => {
    const older = mapWith([WIDE], [], {
      "https://example.com/a": ["id:https://example.com/#wide"],
      "https://example.com/b": ["id:https://example.com/#wide"],
    });
    const newer = mapWith([], [], {
      "https://example.com/a": [],
      "https://example.com/b": [],
    });

    expect(diff(older, newer).removed.map((n) => n.key)).toEqual([
      "id:https://example.com/#wide",
    ]);
  });

  test("a trimmed page list with no index refuses to decide", () => {
    // No usable index at all, and `morePages` says the node's own list is
    // partial. Neither source can prove coverage, so it stays notCrawled.
    const older = map([WIDE], [], PAGES);
    const newer = map([], [], PAGES);

    expect(diff(older, newer).notCrawled).toHaveLength(1);
    expect(diff(older, newer).removed).toHaveLength(0);
  });

  test("a CLIPPED page index is not mistaken for a complete one", () => {
    // A publish projection caps `pages`. It looks exactly like a full list, so
    // the crawl's own page count is what distinguishes them.
    // The clipped index lists only /a, and /a was recrawled. Trusting it would
    // read as full coverage of an entity the crawl saw on 40 pages.
    const older = mapWith([WIDE], [], { "https://example.com/a": ["id:https://example.com/#wide"] }, 40);
    const newer = mapWith([], [], { "https://example.com/a": [] }, 40);

    expect(diff(older, newer).notCrawled).toHaveLength(1);
    expect(diff(older, newer).removed).toHaveLength(0);
  });

  test("an index that contradicts the node's own count is not trusted", () => {
    // The index claims one declaring page; the node claims two. They can only
    // disagree in a hand-assembled document, and there the conservative answer
    // is the right one: do not call it removed on the smaller number.
    const older = mapWith([WIDE], [], {
      "https://example.com/a": ["id:https://example.com/#wide"],
      "https://example.com/b": [],
    });
    const newer = mapWith([], [], {
      "https://example.com/a": [],
      "https://example.com/b": [],
    });

    expect(diff(older, newer).notCrawled).toHaveLength(1);
    expect(diff(older, newer).removed).toHaveLength(0);
  });

  test("a conflict is only resolved when its evidence pages were revisited", () => {
    // A conflict needs two declarations. Surviving on one of its two pages
    // says nothing about whether the other still disagrees.
    const conflicted = node({
      conflicts: [
        {
          property: "logo",
          values: [
            { value: "a", pages: ["https://example.com/a"], morePages: 0 },
            { value: "b", pages: ["https://example.com/b"], morePages: 0 },
          ],
        },
      ],
    });
    const older = mapWith([conflicted], [], {
      "https://example.com/a": ["id:https://example.com/#org"],
      "https://example.com/b": ["id:https://example.com/#org"],
    });
    const partial = mapWith([node()], [], {
      "https://example.com/a": ["id:https://example.com/#org"],
    });
    const full = mapWith([node()], [], {
      "https://example.com/a": ["id:https://example.com/#org"],
      "https://example.com/b": ["id:https://example.com/#org"],
    });

    expect(diff(older, partial).resolvedConflicts).toHaveLength(0);
    expect(diff(older, full).resolvedConflicts).toHaveLength(1);
  });

  test("a dangling reference is only resolved on the same terms", () => {
    const older = mapWith([node()], [edge()], {
      "https://example.com/a": ["id:https://example.com/#org"],
      "https://example.com/b": ["id:https://example.com/#org"],
    });
    const partial = mapWith([node()], [], {
      "https://example.com/a": ["id:https://example.com/#org"],
    });
    const full = mapWith([node()], [], {
      "https://example.com/a": ["id:https://example.com/#org"],
      "https://example.com/b": ["id:https://example.com/#org"],
    });

    expect(diff(older, partial).resolvedDangling).toHaveLength(0);
    expect(diff(older, full).resolvedDangling).toHaveLength(1);
  });
});

describe("identity matching is one-to-one", () => {
  test("two same-named candidates stay unmatched rather than guess", () => {
    // One anonymous "Acme" and two new "Acme"s with ids. Any pairing is a
    // guess, and a wrong one invents a rename AND a deletion at once.
    const before = node({ key: "syn:Organization|name:acme", id: null, name: "Acme" });
    const afterA = node({ key: "id:https://example.com/#a", id: "https://example.com/#a", name: "Acme" });
    const afterB = node({ key: "id:https://example.com/#b", id: "https://example.com/#b", name: "Acme" });
    const result = diff(map([before], [], PAGES), map([afterA, afterB], [], PAGES));

    expect(result.gainedId).toHaveLength(0);
    expect(result.added.map((n) => n.key)).toEqual([
      "id:https://example.com/#a",
      "id:https://example.com/#b",
    ]);
    expect(result.removed.map((n) => n.key)).toEqual(["syn:Organization|name:acme"]);
  });

  test("an entity that survived under its own key is never consumed as a match", () => {
    // The unchanged `id:…#org` shares a name with the entity that gained an id.
    // Pairing against it would report a change that did not happen.
    const survivor = node({ key: "id:https://example.com/#org", name: "Acme" });
    const before = node({ key: "syn:Organization|name:acme", id: null, name: "Acme" });
    const result = diff(map([survivor, before], [], PAGES), map([survivor], [], PAGES));

    expect(result.gainedId).toHaveLength(0);
    expect(result.lostId).toHaveLength(0);
    expect(result.removed.map((n) => n.key)).toEqual(["syn:Organization|name:acme"]);
  });

  test("a type set cannot be forged with a separator", () => {
    // `@type` is site-controlled. Joining the sorted set with "+" makes
    // ["A+B"] and ["A","B"] the same signature and pairs two unrelated things.
    const before = node({ key: "syn:x", id: null, types: ["A+B"], name: "Acme" });
    const after = node({ key: "id:https://example.com/#z", id: "https://example.com/#z", types: ["A", "B"], name: "Acme" });
    const result = diff(map([before], [], PAGES), map([after], [], PAGES));

    expect(result.gainedId).toHaveLength(0);
    expect(result.added).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
  });
});

describe("the docs.squirrelscan.com before/after", () => {
  // A real pair: the docs site before and after tangly 0.5.0 added JSON-LD.
  // The `before` document predates three summary counters that were added to
  // v1, so it is committed exactly as exported and the counters are derived
  // here — which is also what `squirrel entities --input` does.
  const load = async (name: string): Promise<EntityMap> => {
    const raw = (await Bun.file(
      `${import.meta.dir}/fixtures/entity-map/${name}.json`,
    ).json()) as EntityMap;
    return {
      ...raw,
      summary: {
        ...raw.summary,
        pageLocalCount: raw.summary.pageLocalCount ?? 0,
        nodesWithoutIdCount: raw.summary.nodesWithoutIdCount ?? 0,
        conflictCount: raw.summary.conflictCount ?? 0,
      },
      nodes: raw.nodes.map((n) => ({ ...n, pageLocal: n.pageLocal ?? false })),
    };
  };

  test("reports 183 additions and nothing removed", async () => {
    const result = diff(await load("docs-before-jsonld"), await load("docs-after-jsonld"));

    expect(result.older.nodeCount).toBe(0);
    expect(result.newer.nodeCount).toBe(183);
    expect(result.added).toHaveLength(183);
    expect(result.removed).toHaveLength(0);
    expect(result.notCrawled).toHaveLength(0);
    expect(result.summaryDelta.nodeCount).toEqual({ before: 0, after: 183, delta: 183 });
    // The site went from nothing to every entity carrying a stable `@id`.
    expect(result.summaryDelta.stableIdShare!.after).toBe(1);
    expect(Value.Check(EntityMapDiffSchema, result)).toBe(true);
  });

  test("the reverse reads as a total loss, not a coverage gap", async () => {
    // Both audits covered the same 60 pages, so dropping every entity IS a
    // removal and must not be softened into notCrawled.
    const before = await load("docs-before-jsonld");
    const after = await load("docs-after-jsonld");
    const result = diff(after, { ...before, pages: after.pages });

    expect(result.removed.length + result.notCrawled.length).toBe(183);
    expect(result.added).toHaveLength(0);
  });
});
