// The generic anchor phrases every link rule agrees on (repo#1387). `links/anchor-text` (per page),
// `a11y/link-text` (per page, broader list) and `links/generic-anchor-density` (site-wide) all
// start from this list, so none of them can disagree on whether "click here" is generic.
// `a11y/link-text` extends it with action words ("download", "view"); the shared core is the
// phrases that name nothing at all.

import type { LinkData } from "@squirrelscan/core-contracts";

import { isConventionalLinkLabel, normalizeLinkLabel } from "./conventional-link-labels";

export const CORE_GENERIC_ANCHORS: readonly string[] = [
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this",
  "this link",
  "this page",
  "go",
  "continue",
];

const CORE_SET: ReadonlySet<string> = new Set(CORE_GENERIC_ANCHORS);

/** True when the whole anchor text is a core generic phrase and not a conventional label. */
export function isCoreGenericAnchor(text: string): boolean {
  if (isConventionalLinkLabel(text)) return false;
  return CORE_SET.has(normalizeLinkLabel(text));
}

/** Generic and total content anchors of one page's links. */
export interface GenericAnchorCount {
  generic: number;
  total: number;
}

/**
 * Count the internal anchors of one page. Counted: internal, dofollow, non-chrome links that carry
 * text (an empty anchor is `links/anchor-text`'s finding, and sitewide nav and footer repeats
 * would swamp the editorial ratio). `isChrome === undefined` (an old crawl) counts as content.
 * Both the legacy and the streaming path call this on the same `LinkData`, so they agree.
 */
export function countGenericAnchors(links: readonly LinkData[]): GenericAnchorCount {
  let generic = 0;
  let total = 0;
  for (const link of links) {
    if (!link.isInternal || !link.url || link.isNofollow || link.isChrome) continue;
    if (link.url.startsWith("#")) continue;
    const text = (link.text ?? "").trim();
    if (!text) continue;
    total += 1;
    if (isCoreGenericAnchor(text)) generic += 1;
  }
  return { generic, total };
}
