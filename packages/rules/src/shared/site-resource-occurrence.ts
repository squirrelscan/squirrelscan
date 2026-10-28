// Shared-resource evidence, the non-DOM counterpart of `component-occurrence`.
//
// A rule sees one page. It cannot know that the `app.js.map` it just found is
// the same one every other page ships, so it records the observation and the
// report stage, which sees every page, decides. This module exists so that
// decision is made from ONE shape: every rule that finds a shared resource
// records the same four facts, and the origin is derived here rather than at
// each call site, so no two rules can scope a resource differently.

import { componentSiteOrigin, type SiteResourceOccurrence } from "@squirrelscan/core-contracts";

/**
 * One observation per distinct resource key on one page.
 *
 * Deduped on `key`: the same map reached through two references (a script tag
 * and a `SourceMap` header) is one resource and one repair, and counting it
 * twice would inflate the resource count the report prints. The FIRST source
 * wins, matching the rule's own first-seen dedupe of its items.
 *
 * Deliberately uncapped. The per-page `items` cap is a presentation sample; this
 * is membership evidence, and a cap would silently turn "these pages reference
 * it" into a guess.
 */
export function siteResourceOccurrences(input: {
  kind: SiteResourceOccurrence["kind"];
  pageUrl: string;
  /** The fetched/final URL decides site identity when a page redirects. */
  observedUrl?: string;
  resources: ReadonlyArray<{ key: string; source: string }>;
}): SiteResourceOccurrence[] {
  const siteOrigin = componentSiteOrigin(input.observedUrl ?? input.pageUrl);
  const seen = new Set<string>();
  const out: SiteResourceOccurrence[] = [];
  for (const resource of input.resources) {
    if (seen.has(resource.key)) continue;
    seen.add(resource.key);
    out.push({
      kind: input.kind,
      key: resource.key,
      pageUrl: input.pageUrl,
      source: resource.source,
      siteOrigin,
    });
  }
  return out;
}
