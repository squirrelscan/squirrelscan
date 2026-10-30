// #1350: the report builder (the path the hosted container and cloud publish use) counts a
// query-string variant with its canonical page, like the CLI report does (#858); the entity map's
// page counts follow. A site with no variants reports byte-identically with the fold on or off.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { EntityMap, PageRecord } from "@squirrelscan/core-contracts";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import { generateReportFromStorage, runStreamingRules, type PreFetchedAssets } from "../src/adapter";
import { entityMapVariantKeys } from "../src/canonical-groups";
import { foldEntityMapVariants } from "../src/entity-map";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const ASSETS: PreFetchedAssets = { resourceSizes: { css: [], images: [] }, scripts: [], pdfSizes: [], sitemapUrlStatuses: [] };
const T = 60_000;

const withCanonical = (html: string, canonical: string): string =>
  html.replace(/<link[^>]*rel=["']canonical["'][^>]*>/gi, "").replace(/<head([^>]*)>/i, `<head$1><link rel="canonical" href="${canonical}">`);

async function crawl(withVariants: boolean) {
  const model = generateSiteModel({ seed: 7, pageCount: 12 });
  const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");
  const pages = await run(storage.getPages(crawlId));
  const base = pages.find((p) => p.status === 200 && p.html && new URL(p.url).pathname !== "/")!;
  if (withVariants) {
    const variant = `${base.url}?subject=Billing`;
    const paginated = `${base.url}?page=2`;
    const make = (url: string, canonical: string): PageRecord => ({
      ...base,
      url,
      normalizedUrl: url,
      finalUrl: url,
      contentHash: `h-${url}`,
      parsedData: null,
      html: withCanonical(base.html!, canonical),
    });
    await run(storage.upsertPage(crawlId, make(variant, base.url)));
    // Pagination keeps its own canonical: it stays a page of its own.
    await run(storage.upsertPage(crawlId, make(paginated, paginated)));
  }
  const result = await run(runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 8 }));
  return { storage, crawlId, result, base, pageCount: pages.length };
}

describe("buildV1Report folds query-string variants (#1350)", () => {
  test("a variant is counted with its canonical; pagination with its own canonical stays; the score does not move", async () => {
    const { storage, crawlId, result, base, pageCount } = await crawl(true);
    const unfolded = await run(generateReportFromStorage(storage, crawlId, result));
    const folded = await run(generateReportFromStorage(storage, crawlId, result, { foldCanonicalVariants: true }));
    const variant = `${base.url}?subject=Billing`;

    expect(unfolded.totalPages).toBe(pageCount + 2);
    expect(unfolded.canonicalVariants).toBeUndefined();

    expect(folded.totalPages).toBe(pageCount + 1);
    expect(folded.canonicalVariants).toBe(1);
    expect(folded.canonicalVariantPages).toEqual([{ page: variant, canonical: base.url }]);
    expect(folded.pages.map((p) => p.url)).not.toContain(variant);
    expect(folded.pages.map((p) => p.url)).toContain(`${base.url}?page=2`);
    // Nothing a renderer reads names the variant any more, and the page's own checks include its variant's.
    expect(JSON.stringify([folded.ruleResults, folded.pages, folded.siteChecks])).not.toContain("subject=Billing");
    const baseChecks = folded.pages.find((p) => p.url === base.url)!.checks.length;
    const baseBefore = unfolded.pages.find((p) => p.url === base.url)!.checks.length;
    expect(baseChecks).toBeGreaterThanOrEqual(baseBefore); // capped per page, so never fewer
    // Every page still has its own checks: tallies and score are unchanged.
    expect(folded.healthScore).toEqual(unfolded.healthScore);
    expect({ passed: folded.passed, warnings: folded.warnings, failed: folded.failed }).toEqual({
      passed: unfolded.passed,
      warnings: unfolded.warnings,
      failed: unfolded.failed,
    });
    await run(storage.close());
  }, T);

  test("a site with no variants reports byte-identically with the fold on or off", async () => {
    const { storage, crawlId, result } = await crawl(false);
    const strip = (r: object): string => JSON.stringify({ ...r, timestamp: "" });
    const off = await run(generateReportFromStorage(storage, crawlId, result));
    const on = await run(generateReportFromStorage(storage, crawlId, result, { foldCanonicalVariants: true }));
    expect(strip(on)).toBe(strip(off));
    await run(storage.close());
  }, T);
});

describe("foldEntityMapVariants (#1350)", () => {
  const S = "https://example.com";
  const map = {
    format: "squirrelscan.entity-map",
    version: 1,
    site: S,
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: { nodeCount: 1, edgeCount: 1, danglingCount: 0, pagesTotal: 3, pagesWithoutEntities: 1, nodesWithStableId: 1, stableIdShare: 1, pageLocalCount: 0, nodesWithoutIdCount: 0, conflictCount: 0, countsByType: { Organization: 1 } },
    nodes: [{ key: "id:org", id: "org", types: ["Organization"], name: "Acme", properties: {}, occurrences: 3, pages: [`${S}/contact`, `${S}/contact?a=1`, `${S}/`], morePages: 0, conflicts: [], danglingRefs: 0, pageLocal: false }],
    edges: [{ source: "id:org", predicate: "url", target: "id:org", dangling: false, occurrences: 2, pages: [`${S}/contact`, `${S}/contact?a=1`], morePages: 0 }],
    pages: [
      { url: `${S}/`, declares: ["id:org"], references: [], entityCount: 1 },
      { url: `${S}/contact`, declares: [], references: [], entityCount: 0 },
      { url: `${S}/contact?a=1`, declares: ["id:org"], references: [], entityCount: 1 },
    ],
  } as unknown as EntityMap;

  test("a variant's page is counted under its canonical page and pagesTotal agrees with the report", () => {
    const folded = foldEntityMapVariants(map, new Map([[`${S}/contact?a=1`, `${S}/contact`]]));
    expect(folded.pages.map((p) => p.url)).toEqual([`${S}/`, `${S}/contact`]);
    expect(folded.summary.pagesTotal).toBe(2);
    expect(folded.summary.pagesWithoutEntities).toBe(0);
    expect(folded.pages[1]).toEqual({ url: `${S}/contact`, declares: ["id:org"], references: [], entityCount: 1 });
    expect(folded.nodes[0]!.pages).toEqual([`${S}/`, `${S}/contact`]);
    expect(folded.edges[0]!.pages).toEqual([`${S}/contact`]);
    // The input is not mutated and everything else is unchanged.
    expect(map.pages).toHaveLength(3);
    expect(folded.nodes[0]!.occurrences).toBe(3);
  });

  test("nothing to fold returns the same map", () => {
    expect(foldEntityMapVariants(map, new Map())).toBe(map);
    expect(foldEntityMapVariants(map, new Map([[`${S}/other?x=1`, `${S}/other`]]))).toBe(map);
  });
});

describe("entityMapVariantKeys (#1350)", () => {
  const S = "https://example.com";
  const storage = {
    getPagesWithoutBodies: () =>
      Effect.succeed([
        { normalizedUrl: `${S}/c`, url: `${S}/c`, finalUrl: `${S}/c/` },
        { normalizedUrl: `${S}/c?a=1`, url: `${S}/c?a=1`, finalUrl: `${S}/c/?a=1&x=2` },
      ]),
  } as never;

  test("variant and canonical are keyed by the URL the entity map lists them under", async () => {
    const out = await run(entityMapVariantKeys(storage, "crawl", new Map([[`${S}/c?a=1`, `${S}/c`]]), 10));
    expect([...out]).toEqual([[`${S}/c/?a=1&x=2`, `${S}/c/`]]);
  });
  test("nothing to fold, or storage without the reader, is empty", async () => {
    expect((await run(entityMapVariantKeys(storage, "crawl", new Map(), 10))).size).toBe(0);
    expect((await run(entityMapVariantKeys({} as never, "crawl", new Map([["a", "b"]]), 10))).size).toBe(0);
  });
});
