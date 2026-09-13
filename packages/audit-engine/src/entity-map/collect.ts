// Streaming collector for the entity map (#2091).
//
// The audit walks pages in batches and never holds the whole crawl in memory,
// so the map cannot be built from a finished site context.
//
// This holds NO page content. An earlier version kept each page's raw JSON-LD
// until the crawl ended, which on a 10,000-page site (the page ceiling is the
// only bound) is ~100MB of strings alive for the whole run. Each page is folded
// into the builder's accumulators as it arrives and its raw string is dropped
// immediately; what stays resident is the graph, plus one URL per page.
//
// The input type is declared structurally rather than imported from
// `../adapter`: that one type import drags the crawler, rules and threat-intel
// packages into the type graph of everything downstream, which breaks consumers
// that compile with a different lib/types set (#2094).

import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

import {
  createEntityMapBuilder,
  type BuildEntityMapOptions,
  type EntityMapBuilder,
} from "./build";

/**
 * The shape the collector needs from one crawled page.
 *
 * Structurally compatible with the engine's `SiteContextPage`, deliberately
 * without importing it.
 */
export interface EntityMapPageRecord {
  page: {
    url: string;
    finalUrl: string;
    status: number;
  };
  parsed: {
    schemas?: { raw: string | null } | null;
  } | null;
}

export interface EntityMapCollector {
  /** Fold one batch in and release its page content. */
  absorb: (pages: readonly EntityMapPageRecord[]) => void;
  /** Assemble the map. The collector is not reusable afterwards. */
  build: (siteUrl: string, options?: BuildEntityMapOptions) => EntityMap;
}

/**
 * Collect the entity map one batch at a time.
 *
 * Only HTML 2xx pages count: a 404's JSON-LD is not part of the site's graph.
 * A page with no JSON-LD is still recorded, so `pagesWithoutEntities` is a real
 * denominator rather than a guess.
 */
export function createEntityMapCollector(): EntityMapCollector {
  const builder: EntityMapBuilder = createEntityMapBuilder();

  return {
    absorb(pages: readonly EntityMapPageRecord[]): void {
      for (const { page, parsed } of pages) {
        if (page.status < 200 || page.status >= 300) continue;
        // A redirect chain can land two crawl records on one final URL. The
        // builder counts the page once and lets a later record that HAS
        // JSON-LD fill in for an earlier one that had none.
        builder.addPage(page.finalUrl || page.url, parsed?.schemas?.raw ?? null);
      }
    },

    build(siteUrl: string, options?: BuildEntityMapOptions): EntityMap {
      return builder.finish(siteUrl, options);
    },
  };
}
