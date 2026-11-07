// schema/entity-conflicts: a localized URL alias is one entity, not a disagreement (#1615).
//
// One Service @id declared on reciprocal hreflang alternates carries the page's own `url` on each
// page. That `url` is the only difference, so it is not a conflict. Every control that is a real
// disagreement must still warn: a missing or one-way hreflang pair, a differing telephone, a
// divergent provider, a divergent legal identifier. Identity is never inferred from names.
// Fixtures use invented hosts and text.

import { describe, expect, test } from "bun:test";

import type { HreflangAlternate, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import { entityConflictsRule } from "../src/schema/entity-conflicts";
import type { CheckResult, EntityMap, ParsedPage, RuleContext } from "../src/types";

import { ctxWith, edge, entityMap, node } from "./helpers/entity-map";

const EN = "https://example.com/en/service";
const DK = "https://example.com/en-dk/service";
const DE = "https://example.com/de/dienst";
const SERVICE = "id:https://example.com/b2b#service";

interface PageSpec {
  url: string;
  alternates?: Array<[string, string]>;
  canonical?: string;
}

const alternatesOf = (spec: PageSpec): HreflangAlternate[] =>
  (spec.alternates ?? []).map(([hreflang, href]) => ({ hreflang, href }));

const parsedOf = (spec: PageSpec): ParsedPage =>
  ({
    meta: { canonical: spec.canonical ?? spec.url },
    hreflangAlternates: alternatesOf(spec),
  }) as unknown as ParsedPage;

/** The pair as a site declares it: each page lists both, so each lists the other. */
const RECIPROCAL: PageSpec[] = [
  {
    url: EN,
    alternates: [
      ["en", EN],
      ["en-dk", DK],
    ],
  },
  {
    url: DK,
    alternates: [
      ["en", EN],
      ["en-dk", DK],
    ],
  },
];

/** v1 path: the pages carry their parsed alternates. */
function pagesContext(map: EntityMap, specs: PageSpec[]): RuleContext {
  const ctx = ctxWith(map);
  return {
    ...ctx,
    site: {
      ...ctx.site!,
      pages: specs.map((spec) => ({ url: spec.url, statusCode: 200, parsed: parsedOf(spec) })),
    } as RuleContext["site"],
  };
}

/** Streaming path: no pages, a SiteQuery that serves the stored rows. */
function siteQueryContext(map: EntityMap, specs: PageSpec[]): RuleContext {
  const rows = specs.map(
    (spec) =>
      ({
        normalizedUrl: spec.url,
        canonical: spec.canonical ?? spec.url,
        hreflangAlternates: alternatesOf(spec),
      }) as unknown as PageFeatureRow,
  );
  const unused = (): never => {
    throw new Error("entity-conflicts must not use this SiteQuery method");
  };
  const siteQuery: SiteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (row: PageFeatureRow) => boolean) {
      for (const row of rows) if (pred(row)) yield row;
    },
  };
  return { ...ctxWith(map), siteQuery };
}

async function check(ctx: RuleContext): Promise<CheckResult> {
  const result = await Promise.resolve(entityConflictsRule.run(ctx));
  expect(result.checks).toHaveLength(1);
  return result.checks[0]!;
}

const urlConflict = (...pairs: Array<[string, string[]]>) => ({
  property: "url",
  values: pairs.map(([value, pages]) => ({ value, pages, morePages: 0 })),
});

/** One Service @id declared on both pages, differing only in `url`. */
function serviceMap(
  overrides: Parameters<typeof node>[0] = {},
  edges = providerEdges(),
): EntityMap {
  return entityMap({
    nodes: [
      node({
        key: SERVICE,
        id: "https://example.com/b2b#service",
        types: ["Service"],
        name: "B2B orders",
        properties: { name: "B2B orders", url: EN },
        occurrences: 2,
        pages: [DK, EN],
        conflicts: [urlConflict([DK, [DK]], [EN, [EN]])],
        ...overrides,
      }),
    ],
    edges,
    pageUrls: [DK, EN],
  });
}

const providerEdges = (pages = [DK, EN], target = "id:https://example.com/#provider") => [
  edge({ source: SERVICE, predicate: "provider", target, pages }),
];

const BOTH_ENGINES: Array<[string, (map: EntityMap, specs: PageSpec[]) => RuleContext]> = [
  ["pages (v1)", pagesContext],
  ["site query (streaming)", siteQueryContext],
];

for (const [engine, build] of BOTH_ENGINES) {
  describe(`schema/entity-conflicts localized aliases (#1615): ${engine}`, () => {
    test("one Service on reciprocal hreflang alternates, differing only in url, passes", async () => {
      const result = await check(build(serviceMap(), RECIPROCAL));
      expect(result.status).toBe("pass");
      expect(result.details).toEqual({ localizedUrlAliases: 1 });
    });

    test("the same pair without hreflang alternates still warns on url", async () => {
      const bare: PageSpec[] = [{ url: EN }, { url: DK }];
      const result = await check(build(serviceMap(), bare));
      expect(result.status).toBe("warn");
      expect(result.items).toHaveLength(1);
      expect(result.items![0]!.label).toContain("url:");
    });

    test("a one-way reference is not reciprocal and still warns", async () => {
      const oneWay: PageSpec[] = [
        {
          url: EN,
          alternates: [
            ["en", EN],
            ["en-dk", DK],
          ],
        },
        { url: DK },
      ];
      expect((await check(build(serviceMap(), oneWay))).status).toBe("warn");
    });

    test("a page that canonicalises elsewhere is not an alternate and still warns", async () => {
      const specs: PageSpec[] = [RECIPROCAL[0]!, { ...RECIPROCAL[1]!, canonical: EN }];
      expect((await check(build(serviceMap(), specs))).status).toBe("warn");
    });

    test("alternates in different languages are alternates too", async () => {
      const specs: PageSpec[] = [
        {
          url: EN,
          alternates: [
            ["en", EN],
            ["de", DE],
          ],
        },
        {
          url: DE,
          alternates: [
            ["en", EN],
            ["de", DE],
          ],
        },
      ];
      const map = serviceMap(
        {
          pages: [DE, EN],
          conflicts: [urlConflict([DE, [DE]], [EN, [EN]])],
        },
        providerEdges([DE, EN]),
      );
      expect((await check(build(map, specs))).status).toBe("pass");
    });

    test("a differing telephone on the same Organization still warns", async () => {
      const map = entityMap({
        nodes: [
          node({
            occurrences: 2,
            pages: [DK, EN],
            conflicts: [
              {
                property: "telephone",
                values: [
                  { value: "+49111111", pages: [EN], morePages: 0 },
                  { value: "+49222222", pages: [DK], morePages: 0 },
                ],
              },
            ],
          }),
        ],
        pageUrls: [DK, EN],
      });
      const result = await check(build(map, RECIPROCAL));
      expect(result.status).toBe("warn");
      expect(result.items![0]!.label).toContain("telephone");
    });

    test("a divergent provider on the localized pages still warns on url", async () => {
      const edges = [
        edge({
          source: SERVICE,
          predicate: "provider",
          target: "id:https://example.com/#a",
          pages: [EN],
        }),
        edge({
          source: SERVICE,
          predicate: "provider",
          target: "id:https://example.com/#b",
          pages: [DK],
        }),
      ];
      const result = await check(build(serviceMap({}, edges), RECIPROCAL));
      expect(result.status).toBe("warn");
      expect(result.items![0]!.label).toContain("url:");
    });

    test("a provider declared on only one of the pages still warns on url", async () => {
      const result = await check(build(serviceMap({}, providerEdges([EN])), RECIPROCAL));
      expect(result.status).toBe("warn");
    });

    test("a divergent legal identifier on the localized pages warns, url included", async () => {
      const map = serviceMap({
        conflicts: [
          urlConflict([DK, [DK]], [EN, [EN]]),
          {
            property: "vatID",
            values: [
              { value: "dk12345678", pages: [DK], morePages: 0 },
              { value: "gb123456789", pages: [EN], morePages: 0 },
            ],
          },
        ],
      });
      const result = await check(build(map, RECIPROCAL));
      expect(result.status).toBe("warn");
      expect(result.items!.map((item) => item.meta?.property).sort()).toEqual(["url", "vatID"]);
    });

    test("identity is not inferred from names: a name that differs is a conflict, url included", async () => {
      const map = serviceMap({
        conflicts: [
          urlConflict([DK, [DK]], [EN, [EN]]),
          {
            property: "name",
            values: [
              { value: "B2B orders", pages: [EN], morePages: 0 },
              { value: "B2B Orders", pages: [DK], morePages: 0 },
            ],
          },
        ],
      });
      const result = await check(build(map, RECIPROCAL));
      expect(result.status).toBe("warn");
      expect(result.items).toHaveLength(2);
    });

    test("a url that is not the address of a declaring page is not an alias", async () => {
      const map = serviceMap({
        conflicts: [urlConflict(["https://elsewhere.example/service", [DK]], [EN, [EN]])],
      });
      expect((await check(build(map, RECIPROCAL))).status).toBe("warn");
    });

    test("declaring pages beyond the stored cap cannot be verified and still warn", async () => {
      const map = serviceMap({
        conflicts: [
          {
            property: "url",
            values: [
              { value: DK, pages: [DK], morePages: 0 },
              { value: EN, pages: [EN], morePages: 3 },
            ],
          },
        ],
      });
      expect((await check(build(map, RECIPROCAL))).status).toBe("warn");
    });
  });
}
