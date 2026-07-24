// SiteQuery dual-path golden tests for Bucket C content rules (#1022, PR-C).
//
// duplicate-title / duplicate-description / title-unique gained a streaming path:
// `if (ctx.siteQuery)` streams per-page scalars (title/description) from
// page_features via the async cursor instead of scanning `ctx.site.pages`. Each
// rule runs BOTH ways against ONE seeded fixture and the emitted checks must be
// deep-equal. The siteQuery run is given an EMPTY `site.pages`, so a pass also
// proves the streaming path reads nothing from the resident page array.
//
// The fixture deliberately separates the two title normalizations: duplicate-title
// lowercases only, while title-unique also collapses internal whitespace — so the
// "  home   page  " row joins the dup group in title-unique but not duplicate-title.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { PageFeatureRow } from "@squirrelscan/core-contracts";

import { createSiteQuery } from "../src/site-query";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";

const rules = loadAllRules();
const duplicateTitleRule = rules.get("content/duplicate-title")!;
const duplicateDescriptionRule = rules.get("content/duplicate-description")!;
const titleUniqueRule = rules.get("core/title-unique")!;

interface Row {
  normalizedUrl: string;
  title: string | null;
  description: string | null;
}

function feat(row: Row): PageFeatureRow {
  return {
    normalizedUrl: row.normalizedUrl,
    status: 200,
    depth: 1,
    title: row.title,
    titleHash: row.title ? `h:${row.title.trim().toLowerCase()}` : null,
    description: row.description,
    descHash: row.description ? `h:${row.description.trim().toLowerCase()}` : null,
    contentHash: null,
    wordCount: null,
    pageType: null,
    schemaTypes: [],
    robotsNoindex: false,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: [],
  };
}

// normalized_url ASC order (matches getPageFeaturesPage cursor + getPages).
const FIXTURE: Row[] = [
  { normalizedUrl: "https://example.com/a", title: "Home Page", description: "Welcome" },
  { normalizedUrl: "https://example.com/b", title: "Home Page", description: "Welcome" },
  { normalizedUrl: "https://example.com/c", title: "About Us", description: "About page" },
  // Whitespace variant: title-unique collapses to "home page" (joins the group),
  // duplicate-title keeps "home   page" (does not).
  { normalizedUrl: "https://example.com/d", title: "  Home   Page  ", description: "Different desc" },
  // Title-less + desc-less rows are skipped by the rules but still counted.
  { normalizedUrl: "https://example.com/e", title: null, description: null },
  { normalizedUrl: "https://example.com/f", title: "Unique Title", description: null },
];

async function seed(store: SQLiteStorage): Promise<void> {
  await run(store.upsertPageFeaturesBatch(CRAWL, FIXTURE.map(feat)));
}

// Legacy ctx.site.pages built from the same rows, in normalized_url ASC order
// (== the cursor order), so both paths' first-seen iteration matches.
function legacySitePages() {
  return [...FIXTURE]
    .sort((a, b) => (a.normalizedUrl < b.normalizedUrl ? -1 : 1))
    .map((r) => ({
      url: r.normalizedUrl,
      statusCode: 200,
      parsed: { meta: { title: r.title, description: r.description } } as ParsedPage,
    }));
}

async function runBothWays(store: SQLiteStorage, rule: Rule) {
  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options: {},
  };

  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: legacySitePages(), robotsTxt: null, sitemaps: null },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    // EMPTY pages — the streaming path must not read them.
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;

  return { legacy, streamed };
}

describe("SiteQuery dual-path — content/duplicate-title", () => {
  test("streaming path deep-equal to legacy; lowercase-only grouping", async () => {
    const store = await freshStore();
    await seed(store);
    const { legacy, streamed } = await runBothWays(store, duplicateTitleRule);
    expect(streamed).toEqual(legacy);
    expect(legacy).toEqual([
      {
        name: "duplicate-title",
        status: "warn",
        message: "1 duplicate title(s) found across 2 pages",
        items: [
          {
            id: "home page",
            label: '"home page..." (2 pages)',
            sourcePages: ["https://example.com/a", "https://example.com/b"],
            meta: { pageCount: 2 },
          },
        ],
        details: { totalDuplicates: 1, totalPages: 2 },
      },
    ]);
    await run(store.close());
  });
});

describe("SiteQuery dual-path — content/duplicate-description", () => {
  test("streaming path deep-equal to legacy", async () => {
    const store = await freshStore();
    await seed(store);
    const { legacy, streamed } = await runBothWays(store, duplicateDescriptionRule);
    expect(streamed).toEqual(legacy);
    expect(legacy).toEqual([
      {
        name: "duplicate-description",
        status: "warn",
        message: "1 duplicate description(s) found across 2 pages",
        items: [
          {
            id: "welcome",
            label: '"welcome..." (2 pages)',
            sourcePages: ["https://example.com/a", "https://example.com/b"],
            meta: { pageCount: 2 },
          },
        ],
        details: { totalDuplicates: 1, totalPages: 2 },
      },
    ]);
    await run(store.close());
  });
});

describe("SiteQuery dual-path — core/title-unique", () => {
  test("streaming path deep-equal to legacy; whitespace-collapse joins the group", async () => {
    const store = await freshStore();
    await seed(store);
    const { legacy, streamed } = await runBothWays(store, titleUniqueRule);
    expect(streamed).toEqual(legacy);
    // /d ("  Home   Page  ") collapses to "home page" → group of 3, unlike
    // duplicate-title's group of 2.
    expect(legacy).toEqual([
      {
        name: "title-unique",
        status: "warn",
        message: "1 duplicate title(s) affecting 3 pages",
        items: [
          {
            id: "home page",
            label: '"home page..." (3 pages)',
            sourcePages: [
              "https://example.com/a",
              "https://example.com/b",
              "https://example.com/d",
            ],
            meta: { pageCount: 3 },
          },
        ],
        details: { totalDuplicates: 1, totalPages: 3 },
      },
    ]);
    await run(store.close());
  });
});

describe("SiteQuery dual-path — content-rule edge cases parity", () => {
  test("<2 pages skips identically on both paths", async () => {
    const store = await freshStore();
    await run(store.upsertPageFeaturesBatch(CRAWL, [feat(FIXTURE[0]!)]));
    // Legacy uses a single-page site for the skip branch.
    const single = [
      {
        url: FIXTURE[0]!.normalizedUrl,
        statusCode: 200,
        parsed: {
          meta: { title: FIXTURE[0]!.title, description: FIXTURE[0]!.description },
        } as ParsedPage,
      },
    ];
    const base = {
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      options: {},
    };
    const siteQuery = await run(createSiteQuery(store, CRAWL));

    for (const rule of [duplicateTitleRule, duplicateDescriptionRule, titleUniqueRule]) {
      const legacy = (
        await Promise.resolve(
          rule.run({
            ...base,
            site: { baseUrl: BASE, pages: single, robotsTxt: null, sitemaps: null },
          } as RuleContext)
        )
      ).checks;
      const streamed = (
        await Promise.resolve(
          rule.run({
            ...base,
            site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
            siteQuery,
          } as RuleContext)
        )
      ).checks;
      expect(streamed).toEqual(legacy);
      expect(legacy[0]!.status).toBe("skipped");
    }
    await run(store.close());
  });

  test("all-unique crawl passes identically on both paths", async () => {
    const store = await freshStore();
    const unique: Row[] = [
      { normalizedUrl: "https://example.com/x", title: "One", description: "d1" },
      { normalizedUrl: "https://example.com/y", title: "Two", description: "d2" },
      { normalizedUrl: "https://example.com/z", title: "Three", description: "d3" },
    ];
    await run(store.upsertPageFeaturesBatch(CRAWL, unique.map(feat)));
    const sitePages = unique.map((r) => ({
      url: r.normalizedUrl,
      statusCode: 200,
      parsed: { meta: { title: r.title, description: r.description } } as ParsedPage,
    }));
    const base = {
      page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      options: {},
    };
    const siteQuery = await run(createSiteQuery(store, CRAWL));
    for (const rule of [duplicateTitleRule, duplicateDescriptionRule, titleUniqueRule]) {
      const legacy = (
        await Promise.resolve(
          rule.run({
            ...base,
            site: { baseUrl: BASE, pages: sitePages, robotsTxt: null, sitemaps: null },
          } as RuleContext)
        )
      ).checks;
      const streamed = (
        await Promise.resolve(
          rule.run({
            ...base,
            site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
            siteQuery,
          } as RuleContext)
        )
      ).checks;
      expect(streamed).toEqual(legacy);
      expect(legacy[0]!.status).toBe("pass");
    }
    await run(store.close());
  });
});
