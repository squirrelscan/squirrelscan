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
import type {
  EndpointSurface,
  PageEndpointRef,
  PageEndpointRefs,
  ParsedPage,
  SiteData,
} from "@squirrelscan/rules";

import { buildEndpointSurface, extractEndpointRefsFromDocument } from "@squirrelscan/rules";
import { detectTechnologies } from "@squirrelscan/tech-detect";

import type { PageSignalCollector } from "./streaming";

/**
 * Distinct refs the collector retains across the whole crawl. The final list is
 * capped at 200, so this only has to be comfortably larger; it keeps the retained
 * set flat on a 25k-page crawl, where 100 refs a page would not.
 *
 * Admission is by a stable order, not by arrival: the collector keeps the smallest
 * keys (method-carrying refs first, then URL, then method), so the retained set is
 * the same for any crawl order and any cache replay split.
 */
export const MAX_RETAINED_REFS = 2000;

/**
 * Of those, how many may be cross-origin to the page that referenced them. The
 * final list keeps at most 50 cross-origin candidates, so they must not be able to
 * fill the retained set and push out same-origin refs.
 */
export const MAX_RETAINED_CROSS_ORIGIN_REFS = 300;

/** Collector id. The rule cache keys a page's stored snapshot by it. */
export const ENDPOINT_COLLECTOR_ID = "endpoint-refs";

export interface EndpointCollector extends PageSignalCollector {
  /** Takes no shared signals, so the v1 path can call it without building them. */
  collect(page: PageRecord, parsed: ParsedPage): PageEndpointRefs;
  /** The retained refs, in the stable admission order (same for any crawl order). */
  retained(): PageEndpointRef[];
  /** Fold the retained refs, the served scripts and the detected stack into the surface. */
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

/** Stable total order over refs: method-carrying first, then URL, then method. */
function refKey(ref: PageEndpointRef): string {
  return `${ref.method ? 0 : 1}\u0000${ref.url}\u0000${ref.method ?? ""}`;
}

function originOrNull(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * A bounded set that keeps the `cap` smallest keys ever offered. Evicted keys are
 * never larger-than-kept ones, so the final contents do not depend on offer order.
 * It compacts lazily at twice the cap, so an offer is O(1) amortized.
 */
class SmallestKeys {
  readonly map = new Map<string, PageEndpointRef>();
  constructor(private readonly cap: number) {}

  has(key: string): boolean {
    return this.map.has(key);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  offer(key: string, ref: PageEndpointRef): void {
    this.map.set(key, ref);
    if (this.map.size >= this.cap * 2) this.compact();
  }
  compact(): void {
    if (this.map.size <= this.cap) return;
    const keep = [...this.map.keys()].sort().slice(0, this.cap);
    const kept = new Map(keep.map((k) => [k, this.map.get(k)!] as const));
    this.map.clear();
    for (const [k, v] of kept) this.map.set(k, v);
  }
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
 * The ids are unioned across all snapshots, so the result does not depend on
 * which page happened to be first.
 */
export function createEndpointCollector(opts: {
  headersOf: (page: PageRecord) => Record<string, string>;
}): EndpointCollector {
  const same = new SmallestKeys(MAX_RETAINED_REFS);
  const cross = new SmallestKeys(MAX_RETAINED_CROSS_ORIGIN_REFS);
  const techIds = new Set<string>();
  let detectionSeen = false;

  // Keep a page's refs under the stable admission order. The snapshot handed to
  // the rule cache stays whole, so a replay offers the same refs a fresh run would.
  // A ref's class is "same-origin" if ANY page that carries it shares its origin,
  // so the class does not depend on which page was offered first.
  const admit = (record: PageEndpointRefs): void => {
    if (record.techIds !== undefined) {
      detectionSeen = true;
      for (const id of record.techIds) techIds.add(id);
    }
    const pageOrigin = originOrNull(record.pageUrl);
    for (const ref of record.refs) {
      const key = refKey(ref);
      if (same.has(key)) continue;
      const refOrigin = originOrNull(ref.url);
      const isCross = pageOrigin !== null && refOrigin !== null && refOrigin !== pageOrigin;
      if (isCross) {
        if (!cross.has(key)) cross.offer(key, ref);
      } else {
        cross.delete(key);
        same.offer(key, ref);
      }
    }
  };

  const retained = (): PageEndpointRef[] => {
    same.compact();
    cross.compact();
    return [...same.map, ...cross.map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
  };

  const collector: EndpointCollector = {
    id: ENDPOINT_COLLECTOR_ID,
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
      if (!detectionSeen) {
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
    retained,
    finish(site) {
      return buildEndpointSurface({
        baseUrl: site.baseUrl,
        pages: [{ pageUrl: site.baseUrl, refs: retained() }],
        scripts: site.scripts,
        techIds: [...techIds],
      });
    },
  };
  return collector;
}
