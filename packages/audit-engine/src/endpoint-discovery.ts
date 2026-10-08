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

/**
 * Of those, how many may be cross-origin to the page that referenced them. The
 * final list keeps at most 50 cross-origin candidates, so they must not be able to
 * fill the retained set and push out same-origin refs from later pages.
 */
export const MAX_RETAINED_CROSS_ORIGIN_REFS = 300;

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
 * Technology detection runs once per run, on the first page collected fresh
 * unless a replayed snapshot already carries a result. The entry page is first in
 * crawl order, and that is where a stack announces itself. The ids ride on the
 * page's snapshot, so a replayed run (rule cache) restores them without the html.
 * `finish` unions the ids across all snapshots, so the result does not depend on
 * which page happened to be first.
 */
export function createEndpointCollector(opts: {
  headersOf: (page: PageRecord) => Record<string, string>;
}): EndpointCollector {
  const pages: PageEndpointRefs[] = [];
  const seen = new Set<string>();
  // URLs already retained with a method. A method-less ref to one of them is
  // dropped by the fold anyway, so it must not spend the retained cap.
  const withMethod = new Set<string>();
  let crossOriginRetained = 0;

  // Keep a page's refs that are new to the crawl, up to the retained cap. The
  // snapshot handed to the rule cache stays whole, so a replay admits the same
  // refs a fresh run would.
  const admit = (record: PageEndpointRefs): void => {
    const refs = [];
    let pageOrigin: string | null = null;
    try {
      pageOrigin = new URL(record.pageUrl).origin;
    } catch {
      // An unparsable page URL leaves every ref counted as same-origin.
    }
    // Method-carrying refs first, so a bare literal never crowds one out.
    const ordered = [...record.refs].sort((a, b) => Number(!!b.method) - Number(!!a.method));
    for (const ref of ordered) {
      if (seen.size >= MAX_RETAINED_REFS) break;
      if (!ref.method && withMethod.has(ref.url)) continue;
      const key = `${ref.method ?? ""} ${ref.url}`;
      if (seen.has(key)) continue;
      if (pageOrigin) {
        let refOrigin = pageOrigin;
        try {
          refOrigin = new URL(ref.url).origin;
        } catch {
          // Refs are absolute by construction; keep a malformed one as same-origin.
        }
        if (refOrigin !== pageOrigin) {
          if (crossOriginRetained >= MAX_RETAINED_CROSS_ORIGIN_REFS) continue;
          crossOriginRetained++;
        }
      }
      seen.add(key);
      if (ref.method) withMethod.add(ref.url);
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
      // Detect until some page, fresh or replayed, carries a detection result. An
      // explicit empty array means "ran, found nothing", which differs from a
      // snapshot that never ran (`undefined`). If the entry page replays from a
      // run where it was not first, the next fresh page runs detection instead.
      if (!pages.some((p) => p.techIds !== undefined)) {
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
        // Union across pages: only a page that was first in its run carries ids,
        // and a replayed snapshot may come from a run with a different first page.
        techIds: [...new Set(pages.flatMap((p) => p.techIds ?? []))],
      });
    },
  };
  return collector;
}
