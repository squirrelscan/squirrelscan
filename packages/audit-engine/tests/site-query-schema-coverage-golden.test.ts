// SiteQuery dual-path golden test for schema/coverage-outlier (#1363).
//
// The rule's unit tests drive the streaming path through a hand-rolled SiteQuery
// stub. This one drives it through the REAL `createSiteQuery` over a seeded
// SQLite store, so the array columns the rule depends on (`schemaTypes`,
// `richResultTypes`) are proved to round-trip through storage rather than being
// assumed. The rule runs BOTH ways against ONE fixture and the emitted checks
// must be deep-equal; the siteQuery run is given an EMPTY `site.pages`, so a pass
// also proves the streaming path reads nothing from the resident page array.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageFeatureRow } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, RuleContext } from "@squirrelscan/rules";
import { getRichResultTypes } from "@squirrelscan/utils";

import { createSiteQuery } from "../src/site-query";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";

const coverageOutlierRule = loadAllRules().get("schema/coverage-outlier")!;

interface Row {
  normalizedUrl: string;
  pageType: string | null;
  schemaTypes: string[];
}

function feat(row: Row): PageFeatureRow {
  return {
    normalizedUrl: row.normalizedUrl,
    status: 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: row.pageType,
    schemaTypes: row.schemaTypes,
    robotsNoindex: false,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: getRichResultTypes({ types: row.schemaTypes } as never),
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
  };
}

// 12 product pages in normalized_url ASC order (== the cursor order): 10 carry
// Product, 2 do not. 2/12 == 16.7% deviant, under the fail share, so this is the
// canonical "warn and name the ratio" case.
const FIXTURE: Row[] = Array.from({ length: 12 }, (_, i) => ({
  normalizedUrl: `https://example.com/p${String(i).padStart(2, "0")}`,
  pageType: "product",
  schemaTypes: i < 10 ? ["Product", "BreadcrumbList"] : ["BreadcrumbList"],
}));

function legacySitePages() {
  return FIXTURE.map((r) => ({
    url: r.normalizedUrl,
    statusCode: 200,
    parsed: { pageType: r.pageType, schemas: { types: r.schemaTypes } } as unknown as ParsedPage,
  }));
}

describe("SiteQuery dual-path — schema/coverage-outlier", () => {
  test("streaming path deep-equal to legacy over the real store", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await run(store.upsertPageFeaturesBatch(CRAWL, FIXTURE.map(feat)));

    const base = {
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      options: {},
    };

    const legacy = (
      await Promise.resolve(
        coverageOutlierRule.run({
          ...base,
          site: { baseUrl: BASE, pages: legacySitePages(), robotsTxt: null, sitemaps: null },
        } as RuleContext)
      )
    ).checks;

    const siteQuery = await run(createSiteQuery(store, CRAWL));
    const streamed = (
      await Promise.resolve(
        coverageOutlierRule.run({
          ...base,
          // EMPTY pages — the streaming path must not read them.
          site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
          siteQuery,
        } as RuleContext)
      )
    ).checks;

    expect(streamed).toEqual(legacy);
    expect(legacy).toEqual([
      {
        name: "coverage-outlier",
        status: "warn",
        message:
          "2 of 12 page(s) are missing structured data their same-type siblings have (product BreadcrumbList+Product)",
        value: 2,
        items: [
          {
            id: "product:Product",
            label: "10 of 12 product pages have Product schema, these 2 do not",
            sourcePages: ["https://example.com/p10", "https://example.com/p11"],
            meta: {
              pageType: "product",
              schemaType: "Product",
              richResult: true,
              have: 10,
              total: 12,
              missing: 2,
            },
          },
        ],
        details: {
          judgedPages: 12,
          judgedTypes: 1,
          flaggedPages: 2,
          norms: [{ pageType: "product", pages: 12, schemaTypes: ["BreadcrumbList", "Product"] }],
        },
      },
    ]);

    await run(store.close());
  });
});
