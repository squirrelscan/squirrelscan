// The thirteen `schema/entity-*` rules over maps the REAL builder produced
// (#2093, epic section 6).
//
// Their unit tests in `packages/rules` construct `EntityMap` objects by hand,
// because the rules package cannot import this one. That is a genuine gap: a
// hand-made map can be a shape the builder never emits, and a rule tested only
// against those is tested against a fiction.
//
// So this file starts from HTML, runs the real collector, and feeds the result
// to the real rules through the same `ctx.entityMap` the runner uses. Every
// fixture here is markup a real generator emits — the Yoast `@graph`, the
// WordLift/Yoast split, the per-page LocalBusiness that every page builder
// produces — rather than the minimum that makes a rule fire.
//
// It also pins the two real sites named in the issue's acceptance criteria, so
// a change that stops `entity-identity` firing on squirrelscan.com fails here
// rather than in someone's report six months later.

import { describe, expect, test } from "bun:test";

import type { CheckResult, EntityMap } from "@squirrelscan/core-contracts";
import { loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, RuleContext } from "@squirrelscan/rules";

import { createEntityMapCollector } from "../src/entity-map/collect";

const RULES = loadAllRules();
const rule = (id: string) => {
  const found = RULES.get(id);
  if (!found) throw new Error(`rule not registered: ${id}`);
  return found;
};

const BASE = "https://example.com/";

/** Wrap JSON-LD in a page, the way a generator emits it. */
function page(url: string, jsonLd: unknown): { url: string; raw: string } {
  return { url, raw: JSON.stringify(jsonLd) };
}

/** Run the real collector over the pages and return the finished map. */
function mapOf(pages: Array<{ url: string; raw: string | null }>, site = BASE): EntityMap {
  const collector = createEntityMapCollector();
  collector.absorb(
    pages.map((p) => ({
      page: { url: p.url, finalUrl: p.url, status: 200 },
      parsed: { schemas: { raw: p.raw } },
    }))
  );
  return collector.build(site, { generatedAt: "2026-01-01T00:00:00.000Z" });
}

function ctx(entityMap: EntityMap): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
    entityMap,
    options: {},
  };
}

async function check(id: string, entityMap: EntityMap): Promise<CheckResult> {
  const result = await Promise.resolve(rule(id).run(ctx(entityMap)));
  expect(result.checks).toHaveLength(1);
  return result.checks[0]!;
}

// ── Fixtures, as generators emit them ──────────────────────────────

/** Yoast: one script, one `@graph`, everything referenced by `@id`. */
function yoastPage(url: string, title: string) {
  return page(url, {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: title,
        isPartOf: { "@id": `${BASE}#website` },
      },
      {
        "@type": "WebSite",
        "@id": `${BASE}#website`,
        url: BASE,
        name: "Example",
        publisher: { "@id": `${BASE}#organization` },
      },
      {
        "@type": "Organization",
        "@id": `${BASE}#organization`,
        name: "Example Ltd",
        url: BASE,
        logo: `${BASE}logo.png`,
        sameAs: ["https://x.com/example"],
      },
    ],
  });
}

/** The same site with no `@id` anywhere — the default of a hand-rolled block. */
function anonymousPage(url: string, title: string) {
  return page(url, {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    publisher: {
      "@type": "Organization",
      name: "Example Ltd",
      url: BASE,
    },
  });
}

const THREE = [BASE, `${BASE}about`, `${BASE}contact`];

describe("a correctly marked-up Yoast site", () => {
  const map = mapOf(THREE.map((url, i) => yoastPage(url, `Page ${i}`)));

  test("the builder read the @graph", () => {
    // If this fails, nothing below means anything: every rule would be
    // reporting on an empty map.
    expect(map.nodes.length).toBeGreaterThan(0);
    expect(map.nodes.some((n) => n.types.includes("Organization"))).toBe(true);
    expect(map.nodes.some((n) => n.types.includes("WebSite"))).toBe(true);
  });

  test.each([
    "schema/entity-identity",
    "schema/entity-split-identity",
    "schema/entity-conflicts",
    "schema/entity-dangling",
    "schema/entity-id-format",
    "schema/entity-type-drift",
    "schema/entity-website-missing",
    "schema/entity-sameas-missing",
    "schema/entity-orphan",
  ])("%s is silent", async (id) => {
    const result = await check(id, map);
    expect(result.status).not.toBe("fail");
    expect(result.status).not.toBe("warn");
  });
});

describe("the same site with no @id anywhere", () => {
  const map = mapOf(THREE.map((url, i) => anonymousPage(url, `Page ${i}`)));

  test("schema/entity-identity fires on the repeated Organization", async () => {
    const result = await check("schema/entity-identity", map);
    expect(result.status).toBe("fail");
    expect(result.items?.some((item) => item.label?.includes("Example Ltd"))).toBe(true);
  });

  test("schema/entity-website-missing reports the absent WebSite", async () => {
    const result = await check("schema/entity-website-missing", map);
    expect(result.status).toBe("info");
    expect(result.message).toContain("no WebSite entity");
  });
});

describe("a Yoast and WordLift split identity", () => {
  const map = mapOf(
    THREE.map((url) =>
      page(url, {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            "@id": `${BASE}#organization`,
            name: "Example Ltd",
            url: BASE,
          },
          {
            "@type": "Organization",
            "@id": "http://data.wordlift.io/wl1/entity/example-ltd",
            name: "Example Ltd",
            url: BASE,
          },
        ],
      })
    )
  );

  test("schema/entity-split-identity names both ids", async () => {
    const result = await check("schema/entity-split-identity", map);
    expect(result.status).toBe("fail");
    expect(result.value).toContain(`${BASE}#organization`);
    expect(result.value).toContain("data.wordlift.io");
  });
});

describe("a publisher only the homepage declares", () => {
  // The single most common dangling shape: the organization lives in the
  // homepage's @graph and every article points at it by id.
  const map = mapOf([
    page(BASE, {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", "@id": `${BASE}#organization`, name: "Example Ltd" },
      ],
    }),
    page(`${BASE}post-1`, {
      "@context": "https://schema.org",
      "@type": "Article",
      "@id": `${BASE}post-1#article`,
      headline: "Post one",
      publisher: { "@id": `${BASE}#organization` },
    }),
    page(`${BASE}post-2`, {
      "@context": "https://schema.org",
      "@type": "Article",
      "@id": `${BASE}post-2#article`,
      headline: "Post two",
      publisher: { "@id": `${BASE}#organization` },
    }),
  ]);

  test("schema/entity-dangling does NOT fire: the homepage declares it", async () => {
    // The rule's contract is "declared on no crawled page", not "declared on
    // the page that references it". The homepage is in the crawl, so the
    // reference resolves and reporting it would be a false error.
    const result = await check("schema/entity-dangling", map);
    expect(result.status).toBe("pass");
  });

  test("it DOES fire when nothing in the crawl declares the target", async () => {
    const orphaned = mapOf([
      page(`${BASE}post-1`, {
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": `${BASE}post-1#article`,
        headline: "Post one",
        publisher: { "@id": `${BASE}#organization` },
      }),
    ]);
    const result = await check("schema/entity-dangling", orphaned);
    expect(result.status).toBe("fail");
    expect(result.items?.[0]?.meta?.target).toBe(`${BASE}#organization`);
  });
});

describe("a LocalBusiness on every page", () => {
  const urls = Array.from({ length: 12 }, (_, i) => (i === 0 ? BASE : `${BASE}p${i}`));
  const map = mapOf(
    urls.map((url) =>
      page(url, {
        "@context": "https://schema.org",
        "@type": "Plumber",
        "@id": `${BASE}#business`,
        name: "Example Plumbing",
        telephone: "+61 2 1234 5678",
      })
    )
  );

  test("schema/entity-local-business-per-page fires", async () => {
    const result = await check("schema/entity-local-business-per-page", map);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("12 of 12 crawled pages");
  });

  test("schema/entity-identity does not: it carries an @id", async () => {
    // The two rules describe the same markup from different angles, and only
    // one of them is true here. Declaring it everywhere is wasteful; declaring
    // it everywhere WITHOUT an id is what breaks identity.
    expect((await check("schema/entity-identity", map)).status).toBe("pass");
  });
});

describe("type drift across pages", () => {
  const map = mapOf([
    page(BASE, {
      "@context": "https://schema.org",
      "@type": ["Organization", "LocalBusiness"],
      "@id": `${BASE}#organization`,
      name: "Example Ltd",
    }),
    page(`${BASE}about`, {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${BASE}#organization`,
      name: "Example Ltd",
    }),
  ]);

  test("the builder records the drift the union would have erased", () => {
    // `node.types` is the union, so without the recorded per-page sets this
    // would be invisible: the merged node simply has both types.
    const org = map.nodes.find((n) => n.id === `${BASE}#organization`)!;
    expect(org.types.sort()).toEqual(["LocalBusiness", "Organization"]);
    expect(org.conflicts.some((c) => c.property === "@type")).toBe(true);
  });

  test("schema/entity-type-drift fires and schema/entity-conflicts does not", async () => {
    expect((await check("schema/entity-type-drift", map)).status).toBe("warn");
    expect((await check("schema/entity-conflicts", map)).status).toBe("pass");
  });
});

describe("two logos for one organization", () => {
  const map = mapOf([
    page(BASE, {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${BASE}#organization`,
      name: "Example Ltd",
      logo: `${BASE}logo-old.png`,
    }),
    page(`${BASE}about`, {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${BASE}#organization`,
      name: "Example Ltd",
      logo: `${BASE}logo-new.png`,
    }),
  ]);

  test("schema/entity-conflicts names both values", async () => {
    const result = await check("schema/entity-conflicts", map);
    expect(result.status).toBe("warn");
    expect(result.items?.[0]?.label).toContain("logo-old.png");
    expect(result.items?.[0]?.label).toContain("logo-new.png");
  });
});

describe("an inline author nested in an article", () => {
  const map = mapOf([
    page(`${BASE}post-1`, {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "@id": `${BASE}post-1#article`,
      headline: "Post one",
      author: { "@type": "Person", name: "Ada Lovelace" },
    }),
  ]);

  test("the builder found the nested Person", () => {
    expect(map.nodes.some((n) => n.types.includes("Person") && n.name === "Ada Lovelace")).toBe(
      true
    );
  });

  test("schema/entity-authors reports it as unidentified", async () => {
    const result = await check("schema/entity-authors", map);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("no url and no sameAs");
  });
});

describe("the acceptance-criteria snapshots", () => {
  // Real crawls, committed as fixtures. They are our own site and a public
  // hosting company's; both are read-only evidence that the rules fire on the
  // markup they were written for.
  const load = async (name: string): Promise<EntityMap> => {
    const raw = (await Bun.file(
      `${import.meta.dir}/fixtures/entity-map/${name}.json`
    ).json()) as EntityMap;
    // These predate three derived fields; the CLI's `--input` does the same.
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

  test("schema/entity-identity fires on squirrelscan.com", async () => {
    // Organization "squirrelscan" is declared on all 60 crawled pages with no
    // @id, which is exactly the defect the rule exists for — on our own site.
    const result = await check("schema/entity-identity", await load("squirrelscan-com"));
    expect(result.status).toBe("fail");
    expect(result.items?.some((item) => item.label?.includes("squirrelscan"))).toBe(true);
  });

  test("schema/entity-split-identity fires on kinsta.com", async () => {
    const result = await check("schema/entity-split-identity", await load("kinsta-com"));
    expect(result.status).toBe("fail");
    expect(result.value).toContain("data.wordlift.io");
    expect(result.value).toContain("kinsta.com/#organization");
  });

  test("schema/entity-local-business-per-page fires on wollongongservicecompany.com.au", async () => {
    // The issue's acceptance criteria name `schema/entity-identity` for this
    // site. It does not fire and cannot: the LocalBusiness carries an absolute
    // @id on all 60 pages. The defect is real and this is the rule for it.
    const map = await load("wollongongservicecompany-com-au");
    expect((await check("schema/entity-identity", map)).status).toBe("pass");

    const result = await check("schema/entity-local-business-per-page", map);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Wollongong Service Company");
    expect(result.value).toBe("100% of crawled pages");
  });

  test("the orphan rule stays readable on a real 40-page crawl", async () => {
    // Before articles and breadcrumbs were excluded this reported 79 entities
    // on kinsta.com, which is not a finding, it is the site's page count.
    const result = await check("schema/entity-orphan", await load("kinsta-com"));
    if (result.status === "info") {
      const reported = Number(/^(\d+)/.exec(result.message)?.[1] ?? 0);
      expect(reported).toBeLessThan(15);
    }
  });
});
