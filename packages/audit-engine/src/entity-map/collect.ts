// Streaming collector for the entity map (#2061).
//
// The audit walks pages in batches and never holds the whole crawl in memory,
// so the map cannot be built from a finished site context. This keeps the one
// thing the builder needs — the page URL and its raw JSON-LD — and nothing
// else: no HTML, no DOM, no PageRecord.

import type { SiteContextPage } from "../adapter";
import type { EntityMapPageInput } from "./build";

export interface EntityMapCollector {
  absorb: (siteContext: SiteContextPage[]) => void;
  build: () => EntityMapPageInput[];
}

/**
 * Collect entity-map input one batch at a time.
 *
 * Only HTML 2xx pages count: a 404's JSON-LD is not part of the site's graph,
 * and a page with no JSON-LD is still recorded so `pagesWithoutEntities` is a
 * real denominator rather than a guess.
 */
export function createEntityMapCollector(): EntityMapCollector {
  const pages = new Map<string, EntityMapPageInput>();

  return {
    absorb(siteContext: SiteContextPage[]): void {
      for (const { page, parsed } of siteContext) {
        if (page.status < 200 || page.status >= 300) continue;
        const url = page.finalUrl || page.url;
        const raw = parsed?.schemas?.raw ?? null;
        const existing = pages.get(url);
        // A redirect chain can land two records on one final URL. Prefer the
        // one that actually carries JSON-LD.
        if (existing && (existing.raw || !raw)) continue;
        pages.set(url, { url, raw });
      }
    },
    build(): EntityMapPageInput[] {
      return [...pages.values()];
    },
  };
}
