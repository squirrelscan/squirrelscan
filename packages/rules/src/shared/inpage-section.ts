// An About/Contact section on a page (#1208).
//
// A one-page site puts its About and Contact content in sections of the
// homepage (`<section id="about">`), linked from the nav as `href="#about"`.
// The E-E-A-T presence rules look for a separate page by URL slug and so call
// that site's About and Contact missing. An element counts as the section when
// its `id` matches the page slugs (as if it were the path `/<id>`) AND a
// same-page fragment link points at it, so a stray id is not evidence.

import { getPathname } from "@squirrelscan/utils";

import { getRenderedProseText } from "../content/text-content";
import type { SiteData } from "../types";

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

const fragmentId = (href: string): string | null => {
  if (!href.startsWith("#") || href.length < 2) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
};

/** First section (in crawl order) whose id matches `patterns` and is linked by a `#fragment` anchor. */
export function findInPageSection(
  pages: SiteData["pages"],
  patterns: readonly RegExp[],
): InPageSection | null {
  for (const page of pages) {
    const doc = page.parsed?.document;
    if (!doc) continue;

    const linked = new Set<string>();
    for (const a of Array.from(doc.querySelectorAll("a[href^='#']")).slice(0, MAX_FRAGMENT_LINKS)) {
      const id = fragmentId((a.getAttribute("href") ?? "").trim());
      if (id) linked.add(id);
    }
    if (linked.size === 0) continue;

    for (const el of Array.from(doc.querySelectorAll("[id]"))) {
      const id = el.getAttribute("id") ?? "";
      if (!linked.has(id)) continue;
      // Matched as if the id were the path `/<id>`. Encoded so an id holding `/`, `?` or `#`
      // stays one path segment instead of reading as a deeper path or a query.
      const asPath = `/${encodeURIComponent(id)}`;
      if (!patterns.some((p) => p.test(asPath))) continue;
      return {
        url: page.url,
        id,
        wordCount: countWords(getRenderedProseText(el)),
        hasContactMethod:
          doc.querySelector("a[href^='mailto:' i], a[href^='tel:' i], form") !== null,
      };
    }
  }
  return null;
}

/** "the homepage" for the root path, else the page's path. */
export function describeSectionPage(url: string): string {
  const path = getPathname(url);
  return path === "/" || path === "" ? "the homepage" : path;
}
