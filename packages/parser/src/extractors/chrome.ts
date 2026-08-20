// Site-chrome detection for anchors (#109).
//
// A link that sits in sitewide chrome — the header, the footer, the primary nav,
// a sidebar — is repeated verbatim on every page of the site. It contributes to a
// page's RAW inbound-link count but carries no editorial signal: it says nothing
// about which page is relevant to which. `links/no-contextual-inbound` needs to
// tell the two apart, so every link in the graph records where it sat.
//
// Deliberately STRICTER than `detectLinkPosition` in ./links.ts. That function
// falls back to class/id substring heuristics (`class="post-nav"` → "nav",
// `id="main-content"` → "content") which are fine for a descriptive position
// label but far too loose to drive a warning: a single blog post whose wrapper is
// `<div class="nav-post">` would have its body links silently reclassified as
// chrome. Here only the four SEMANTIC landmark elements count — `nav`, `header`,
// `footer`, `aside` — matching the acceptance criteria exactly. False negatives
// (a div-soup footer) cost a missed warning; false positives cost a wrong one.

import type { Element } from "linkedom";

/** Landmark elements whose subtree is treated as sitewide chrome. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);

/**
 * True when `element` has an ancestor (or is itself) one of {@link CHROME_TAGS}.
 *
 * Walks to the root rather than stopping at the first landmark, so a link inside
 * `<footer><div class="content">…` is still chrome — nesting a content wrapper
 * inside the footer does not make a sitewide link editorial.
 */
export function isInSiteChrome(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const tagName = current.tagName?.toLowerCase();
    if (tagName && CHROME_TAGS.has(tagName)) return true;
    current = current.parentElement;
  }
  return false;
}
