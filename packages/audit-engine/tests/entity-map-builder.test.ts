// Entity-map builder fixtures (#2061).
//
// The shapes here are the ones that break naive JSON-LD readers: Yoast `@graph`
// with `@id` cross-references, entities inlined as nested objects, the same
// unnamed Organization repeated on every page, an `@id` nothing declares, two
// pages disagreeing on a logo, and a page whose JSON-LD carries an own property
// literally named `__proto__`.

import { describe, expect, test } from "bun:test";

import { entityMapSchema } from "@squirrelscan/core-contracts/entity-map";

import { buildEntityMap, toJsonLd, type EntityMapPageInput } from "../src/entity-map";

const SITE = "https://example.com/";
const AT = "2026-01-01T00:00:00.000Z";

function build(pages: EntityMapPageInput[]) {
  return buildEntityMap(pages, SITE, { generatedAt: AT });
}

function page(url: string, jsonLd: unknown): EntityMapPageInput {
  return { url, raw: JSON.stringify(jsonLd) };
}

function nodeByName(map: ReturnType<typeof build>, name: string) {
  const found = map.nodes.find((node) => node.name === name);
  if (!found) throw new Error(`no node named ${name}: ${map.nodes.map((n) => n.name).join(", ")}`);
  return found;
}

describe("buildEntityMap", () => {
  test("collapses a shared @id declared on several pages", () => {
    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://example.com/#org",
      name: "Acme",
      url: "https://example.com/",
    };
    const map = build([
      page("https://example.com/", organization),
      page("https://example.com/about", organization),
      page("https://example.com/contact", organization),
    ]);

    expect(entityMapSchema.safeParse(map).success).toBe(true);
    expect(map.nodes).toHaveLength(1);
    const node = map.nodes[0]!;
    expect(node.id).toBe("https://example.com/#org");
    expect(node.occurrences).toBe(3);
    expect(node.pages).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/contact",
    ]);
    expect(map.summary.nodesWithStableId).toBe(1);
    expect(map.summary.stableIdShare).toBe(1);
  });

  test("reads a Yoast-style @graph and resolves its @id references", () => {
    const graph = (path: string) => ({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": `https://example.com${path}#webpage`,
          url: `https://example.com${path}`,
          name: `Page ${path}`,
          isPartOf: { "@id": "https://example.com/#website" },
          about: { "@id": "https://example.com/#organization" },
        },
        {
          "@type": "WebSite",
          "@id": "https://example.com/#website",
          name: "Example",
          url: "https://example.com/",
          publisher: { "@id": "https://example.com/#organization" },
        },
        {
          "@type": "Organization",
          "@id": "https://example.com/#organization",
          name: "Example Inc",
          logo: "https://example.com/logo.png",
          sameAs: ["https://x.com/example", "https://example.com/"],
        },
      ],
    });

    const map = build([page("https://example.com/", graph("/")), page("https://example.com/a", graph("/a"))]);

    expect(entityMapSchema.safeParse(map).success).toBe(true);
    // Two WebPages (page-scoped @id) plus one WebSite and one Organization.
    expect(map.nodes).toHaveLength(4);
    expect(map.summary.danglingCount).toBe(0);

    const organization = nodeByName(map, "Example Inc");
    expect(organization.occurrences).toBe(2);
    expect(organization.properties.logo).toBe("https://example.com/logo.png");

    const publisher = map.edges.find((edge) => edge.predicate === "publisher");
    expect(publisher?.source).toBe("id:https://example.com/#website");
    expect(publisher?.target).toBe("id:https://example.com/#organization");
    expect(publisher?.dangling).toBe(false);
    // The WebSite is declared on both pages, so the edge carries both.
    expect(publisher?.occurrences).toBe(2);

    // A `sameAs` string that happens to match a declared @id becomes an edge;
    // the twitter profile, which nothing declares, stays a plain value.
    expect(organization.properties.sameAs).toEqual([
      "https://example.com/",
      "https://x.com/example",
    ]);
  });

  test("registers an entity nested under a followed predicate", () => {
    const map = build([
      page("https://example.com/post", {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "A post",
        author: {
          "@type": "Person",
          name: "Ada Lovelace",
          url: "https://example.com/authors/ada",
        },
      }),
    ]);

    expect(entityMapSchema.safeParse(map).success).toBe(true);
    const author = nodeByName(map, "Ada Lovelace");
    expect(author.types).toEqual(["Person"]);
    expect(author.id).toBeNull();

    const edge = map.edges.find((e) => e.predicate === "author");
    expect(edge?.target).toBe(author.key);
    expect(edge?.dangling).toBe(false);

    const pageRow = map.pages[0]!;
    expect(pageRow.entityCount).toBe(2);
    expect(pageRow.declares).toContain(author.key);
  });

  test("collapses the same unnamed-@id Organization across pages", () => {
    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme Widgets",
      url: "https://example.com/",
    };
    const map = build([
      page("https://example.com/a", organization),
      page("https://example.com/b", organization),
      page("https://example.com/c", organization),
    ]);

    expect(map.nodes).toHaveLength(1);
    const node = map.nodes[0]!;
    expect(node.id).toBeNull();
    expect(node.key).toBe("syn:Organization|name:acme widgets");
    expect(node.occurrences).toBe(3);
    expect(node.pages).toHaveLength(3);
    expect(map.summary.nodesWithStableId).toBe(0);
    expect(map.summary.stableIdShare).toBe(0);
  });

  test("keeps an @id reference nothing declares as a dangling edge", () => {
    const map = build([
      page("https://example.com/post", {
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": "https://example.com/post#article",
        headline: "A post",
        publisher: { "@id": "https://example.com/#organization" },
      }),
    ]);

    expect(map.summary.danglingCount).toBe(1);
    const edge = map.edges.find((e) => e.dangling);
    expect(edge?.predicate).toBe("publisher");
    expect(edge?.target).toBe("id:https://example.com/#organization");
    // The dangling target is deliberately not a node — nothing declares it.
    expect(map.nodes.map((n) => n.key)).not.toContain("id:https://example.com/#organization");
    expect(nodeByName(map, "A post").danglingRefs).toBe(1);
    expect(map.pages[0]!.references).toContain("id:https://example.com/#organization");
  });

  test("reports a property two pages disagree on", () => {
    const organization = (logo: string) => ({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://example.com/#org",
      name: "Acme",
      logo,
    });
    const map = build([
      page("https://example.com/a", organization("https://example.com/logo-a.png")),
      page("https://example.com/b", organization("https://example.com/logo-b.png")),
    ]);

    const node = map.nodes[0]!;
    expect(node.conflicts).toHaveLength(1);
    const conflict = node.conflicts[0]!;
    expect(conflict.property).toBe("logo");
    expect(conflict.values.map((v) => v.value)).toEqual([
      "https://example.com/logo-a.png",
      "https://example.com/logo-b.png",
    ]);
    expect(conflict.values[0]!.pages).toEqual(["https://example.com/a"]);
    // Canonical value is the first in page order, not the last writer.
    expect(node.properties.logo).toBe("https://example.com/logo-a.png");
  });

  test("survives a JSON-LD object with a __proto__ own property", () => {
    const raw = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme",
      __proto__: { polluted: true },
      constructor: { name: "nope" },
    });
    const map = build([{ url: "https://example.com/", raw }]);

    expect(entityMapSchema.safeParse(map).success).toBe(true);
    expect(map.nodes).toHaveLength(1);
    expect(map.nodes[0]!.name).toBe("Acme");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(map.summary.countsByType, "Organization")).toBe(
      true,
    );
  });

  test("a __proto__ type name lands as an own property of countsByType", () => {
    const raw = '{"@context":"https://schema.org","@type":"__proto__","name":"Weird"}';
    const map = build([{ url: "https://example.com/", raw }]);

    expect(map.nodes).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(map.summary.countsByType, "__proto__")).toBe(true);
    expect(entityMapSchema.safeParse(map).success).toBe(true);
  });

  test("counts pages that declare no entities", () => {
    const map = build([
      page("https://example.com/", { "@context": "https://schema.org", "@type": "WebSite", name: "S" }),
      { url: "https://example.com/empty", raw: null },
      { url: "https://example.com/broken", raw: "{not json" },
    ]);

    expect(map.summary.pagesTotal).toBe(3);
    expect(map.summary.pagesWithoutEntities).toBe(2);
  });

  test("unwraps breadcrumb ListItems to their item instead of minting crumb nodes", () => {
    const map = build([
      page("https://example.com/a", {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BreadcrumbList",
            "@id": "https://example.com/a#breadcrumb",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: { "@id": "https://example.com/#home" } },
              { "@type": "ListItem", position: 2, name: "A" },
            ],
          },
        ],
      }),
    ]);

    expect(map.nodes.map((n) => n.types.join())).toEqual(["BreadcrumbList"]);
    const edge = map.edges[0]!;
    expect(edge.predicate).toBe("itemListElement");
    expect(edge.target).toBe("id:https://example.com/#home");
    expect(edge.dangling).toBe(true);
  });

  test("is deterministic across two builds and independent of page order", () => {
    const pages = [
      page("https://example.com/b", {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": "https://example.com/#org",
        name: "Acme",
        logo: "https://example.com/b.png",
      }),
      page("https://example.com/a", {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": "https://example.com/#org",
        name: "Acme",
        logo: "https://example.com/a.png",
      }),
    ];

    const first = JSON.stringify(build(pages));
    const second = JSON.stringify(build(pages));
    const reversed = JSON.stringify(build([...pages].reverse()));

    expect(second).toBe(first);
    expect(reversed).toBe(first);
  });
});

describe("toJsonLd", () => {
  test("emits one @graph member per node with references as @id objects", () => {
    const map = build([
      page("https://example.com/post", {
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": "https://example.com/post#article",
        headline: "A post",
        author: { "@type": "Person", name: "Ada Lovelace" },
        publisher: { "@id": "https://example.com/#organization" },
      }),
    ]);

    const jsonLd = toJsonLd(map);
    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@graph"]).toHaveLength(map.nodes.length);

    const article = jsonLd["@graph"].find((member) => member["@id"] === "https://example.com/post#article");
    expect(article?.["@type"]).toBe("Article");
    expect(article?.publisher).toEqual({ "@id": "https://example.com/#organization" });

    // The inline Person had no @id, so the export mints a stable one.
    const person = jsonLd["@graph"].find((member) => member.name === "Ada Lovelace");
    expect(typeof person?.["@id"]).toBe("string");
    expect(String(person?.["@id"])).toContain("#entity-ada-lovelace-");
    expect(article?.author).toEqual({ "@id": person?.["@id"] });

    // Round-trips as JSON.
    expect(() => JSON.parse(JSON.stringify(jsonLd))).not.toThrow();
  });

  test("a punctuation-only name still gets a usable generated id", () => {
    const map = build([
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "---",
      }),
    ]);
    const jsonLd = toJsonLd(map);
    const id = String(jsonLd["@graph"][0]?.["@id"]);
    expect(id).toContain("#entity-");
    // No empty or dash-edged slug: `#entity--<hash>` reads as a broken id.
    expect(id).not.toContain("#entity--");
  });

  test("a long punctuation-heavy name slugifies in linear time", () => {
    // js/polynomial-redos: the trim used to be `/^-+|-+$/`, which backtracks on
    // a site-controlled name. 200k separators must stay instant.
    const started = Date.now();
    const map = build([
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "-".repeat(200_000),
      }),
    ]);
    expect(toJsonLd(map)["@graph"]).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("generated ids are stable across builds", () => {
    const input = [
      page("https://example.com/", {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "Ada Lovelace",
      }),
    ];
    expect(JSON.stringify(toJsonLd(build(input)))).toBe(JSON.stringify(toJsonLd(build(input))));
  });
});
