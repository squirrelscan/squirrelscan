// Endpoint discovery pass (engine side): the page-time collector and the final
// fold that produce `ctx.endpointSurface` for site rules. The extraction and the
// fold live in @squirrelscan/rules (endpoint-surface.ts); this file adds the one
// thing rules cannot do, which is run technology detection to choose convention
// paths.
//
// The pass is passive. It reads the page DOM the page loop already has live, the
// script bodies the engine already fetched, and the first page's html and headers
// for technology detection. It makes no request. The render pipeline hands back
// only the final html, status and headers for a rendered page, not the requests
// the page issued, so the render-request source is not fed here.

import type { PageRecord } from "@squirrelscan/core-contracts";
import type { EndpointSurface, PageEndpointRefs, ParsedPage, SiteData } from "@squirrelscan/rules";

import { buildEndpointSurface, extractEndpointRefsFromDocument } from "@squirrelscan/rules";
import { detectTechnologies } from "@squirrelscan/tech-detect";

import type { PageSignalCollector } from "./streaming";

/**
 * Distinct refs the collector retains across the whole crawl, in crawl order.
 * The final list is capped at 200, so this only has to be comfortably larger; it
 * keeps the retained set flat on a 25k-page crawl, where 100 refs a page would not.
 */
export const MAX_RETAINED_REFS = 2000;

/** Collector id. The rule cache keys a page's stored snapshot by it. */
export const ENDPOINT_COLLECTOR_ID = "endpoint-refs";

export interface EndpointCollector extends PageSignalCollector {
  /** Takes no shared signals, so the v1 path can call it without building them. */
  collect(page: PageRecord, parsed: ParsedPage): PageEndpointRefs;
  /** The records collected so far, in crawl order. */
  readonly pages: readonly PageEndpointRefs[];
  /** Fold the records, the served scripts and the detected stack into the surface. */
  finish(site: Pick<SiteData, "baseUrl" | "scripts">): EndpointSurface;
}

function scriptUrls(parsed: ParsedPage, pageUrl: string): { url: string }[] {
  const out: { url: string }[] = [];
  const doc = parsed.document;
  if (!doc) return out;
  for (const el of doc.querySelectorAll("script[src]")) {
    const raw = el.getAttribute("src")?.trim();
    if (!raw) continue;
    try {
      out.push({ url: new URL(raw, pageUrl).href });
    } catch {
      // A malformed src is not a script URL; skip it.
    }
  }
  return out;
}

/**
 * Build the collector. `headersOf` turns a stored page into the lowercase header
 * map technology detection reads (the adapter's `buildHeadersMap`); it is passed
 * in so this module does not import the adapter.
 *
 * Technology detection runs once, on the first page the collector sees: the
 * entry page, which is where a stack announces itself. Its ids ride on that
 * page's snapshot, so a replayed run (rule cache) restores them without the html.
 */
export function createEndpointCollector(opts: {
  headersOf: (page: PageRecord) => Record<string, string>;
}): EndpointCollector {
  const pages: PageEndpointRefs[] = [];
  const seen = new Set<string>();

  // Keep a page's refs that are new to the crawl, up to the retained cap. The
  // snapshot handed to the rule cache stays whole, so a replay admits the same
  // refs a fresh run would.
  const admit = (record: PageEndpointRefs): void => {
    const refs = [];
    for (const ref of record.refs) {
      if (seen.size >= MAX_RETAINED_REFS) break;
      const key = `${ref.method ?? ""} ${ref.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    pages.push({ ...record, refs });
  };

  const collector: EndpointCollector = {
    id: ENDPOINT_COLLECTOR_ID,
    get pages() {
      return pages;
    },
    collect(page, parsed) {
      const pageUrl = page.finalUrl || page.normalizedUrl;
      const record: PageEndpointRefs = {
        pageUrl: page.normalizedUrl,
        refs: parsed.document ? extractEndpointRefsFromDocument(parsed.document, pageUrl) : [],
      };
      if (pages.length === 0) {
        record.techIds = detectTechnologies({
          url: pageUrl,
          headers: opts.headersOf(page),
          html: page.html ?? "",
          scripts: scriptUrls(parsed, pageUrl),
        }).map((t) => t.id);
      }
      admit(record);
      return record;
    },
    replay(_page, snapshot) {
      admit(snapshot as PageEndpointRefs);
    },
    finish(site) {
      return buildEndpointSurface({
        baseUrl: site.baseUrl,
        pages,
        scripts: site.scripts,
        techIds: pages[0]?.techIds,
      });
    },
  };
  return collector;
}
