// An About/Contact section on a page (#1208).
//
// A one-page site puts its About and Contact content in sections of the
// homepage (`<section id="about">`), linked from the nav as `href="#about"`.
// The E-E-A-T presence rules look for a separate page by URL slug and so call
// that site's About and Contact missing. An element counts as the section when
// its `id` matches the page slugs (as if it were the path `/<id>`) AND a
// same-page fragment link points at it, so a stray id is not evidence.

import { getPathname } from "@squirrelscan/utils";
import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";

import { getRenderedProseText } from "../content/text-content";
import type { RuleContext } from "../types";

export interface InPageSection {
  /** URL of the page holding the section. */
  url: string;
  /** The element's id, without the `#`. */
  id: string;
  /** Words of visible text inside the section. */
  wordCount: number;
  /** The section, or the page holding it (a footer link counts), links `mailto:`/`tel:` or has a form. */
  hasContactMethod: boolean;
}

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Most `#fragment` anchors read per page: bounds the work on a page of thousands of links. */
const MAX_FRAGMENT_LINKS = 500;

/** Most `[id]` elements read per page, so a page of tens of thousands of ids stays bounded. */
const MAX_ID_ELEMENTS = 5000;

const fragmentId = (href: string): string | null => {
  if (!href.startsWith("#") || href.length < 2) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
};

/** Which page the section stands in for. */
export type InPageSectionKind = "about" | "contact";

/** A section found on one page: the page-time record collected while the DOM is live. */
export interface InPageSectionHit {
  /** The element's id, without the `#`. */
  id: string;
  /** Words of visible text inside the section. */
  wordCount: number;
  /** The section, or the page holding it (a footer link counts), links `mailto:`/`tel:` or has a form. */
  hasContactMethod: boolean;
}

/**
 * The per-page record (collected-signals.ts): the first About and the first Contact
 * section on the page. A few numbers, never the DOM, so a streaming audit keeps it
 * for every page (#1236).
 */
export interface InPageSectionSignal {
  about: InPageSectionHit | null;
  contact: InPageSectionHit | null;
}

/** First section on this page for each kind. Both the streaming collector and the v1 path call it. */
export function buildInPageSectionSignal(doc: Document): InPageSectionSignal {
  const out: InPageSectionSignal = { about: null, contact: null };
  const linked = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll("a[href^='#']")).slice(0, MAX_FRAGMENT_LINKS)) {
    const id = fragmentId((a.getAttribute("href") ?? "").trim());
    if (id) linked.add(id);
  }
  if (linked.size === 0) return out;

  let hasContactMethod: boolean | null = null;
  const withIds = doc.querySelectorAll("[id]");
  for (let i = 0; i < Math.min(withIds.length, MAX_ID_ELEMENTS); i++) {
    const el = withIds[i]!;
    if (out.about && out.contact) break;
    const id = el.getAttribute("id") ?? "";
    if (!linked.has(id)) continue;
    // Matched as if the id were the path `/<id>`. Encoded so an id holding `/`, `?` or `#`
    // stays one path segment instead of reading as a deeper path or a query.
    const asPath = `/${encodeURIComponent(id)}`;
    for (const kind of ["about", "contact"] as const) {
      if (out[kind] || !EEAT_PAGE_PATTERNS[kind].some((p) => p.test(asPath))) continue;
      hasContactMethod ??=
        doc.querySelector("a[href^='mailto:' i], a[href^='tel:' i], form") !== null;
      out[kind] = { id, wordCount: countWords(getRenderedProseText(el)), hasContactMethod };
    }
  }
  return out;
}

/**
 * A streaming snapshot cached before the field existed has no record on any page, which
 * would read as "no section" and warn on a one-page site. Mirrors links/broken-anchors:
 * the rules skip and ask for a re-run instead (#1236).
 */
export function inPageSectionsUnmeasured(ctx: Pick<RuleContext, "collectedSignals">): boolean {
  const pages = ctx.collectedSignals?.pages;
  return !!pages && pages.length > 0 && pages.every((rec) => rec.inPageSections === undefined);
}

export const INPAGE_SECTIONS_UNMEASURED_MESSAGE =
  "In-page sections were not checked: this crawl's page records predate the check. Re-run the audit with --refresh to check them";

/**
 * First section of `kind` in crawl order. A streaming audit has no DOM in the site
 * pass, so it reads the records collected page-time; the v1 path, which does have
 * the documents, builds the same record from them (#1236).
 */
export function findInPageSection(
  ctx: Pick<RuleContext, "site" | "collectedSignals">,
  kind: InPageSectionKind,
): InPageSection | null {
  const collected = ctx.collectedSignals;
  if (collected) {
    for (const rec of collected.pages) {
      const hit = rec.inPageSections?.[kind];
      if (hit) return { url: rec.url, ...hit };
    }
    return null;
  }
  for (const page of ctx.site?.pages ?? []) {
    const doc = page.parsed?.document;
    if (!doc) continue;
    const hit = buildInPageSectionSignal(doc)[kind];
    if (hit) return { url: page.url, ...hit };
  }
  return null;
}

/** "the homepage" for the root path, else the page's path. */
export function describeSectionPage(url: string): string {
  const path = getPathname(url);
  return path === "/" || path === "" ? "the homepage" : path;
}
