// The per-page facts i18n/hreflang-targets needs, read from the parsed page and
// its headers: no DOM. The streaming engine stores one per page in
// `ctx.collectedSignals`, and the v1 path derives the same record on demand, so
// both engines judge the same input.

import type { HreflangAlternate } from "@squirrelscan/core-contracts";

import { noindexSource, type NoindexSource } from "../shared/noindex";
import type { ParsedPage } from "../types";

export interface HreflangPageSignal {
  /** The page's hreflang alternates, hrefs absolute, in document order. */
  alternates: HreflangAlternate[];
  /** Where the page's noindex comes from, or null. */
  noindex: NoindexSource | null;
  /** The page's canonical, resolved to an absolute URL; null when absent or unparseable. */
  canonical: string | null;
}

/** Most alternates kept per page: the parser already caps a page's list. */
export function buildHreflangSignal(
  parsed: ParsedPage | null | undefined,
  headers: Record<string, string> | undefined,
  pageUrl: string,
): HreflangPageSignal {
  const rawCanonical = parsed?.meta?.canonical?.trim() ?? "";
  let canonical: string | null = null;
  if (rawCanonical) {
    try {
      canonical = new URL(rawCanonical, pageUrl).toString();
    } catch {
      canonical = null;
    }
  }
  return {
    alternates: (parsed?.hreflangAlternates ?? []).map((a) => ({
      hreflang: a.hreflang,
      href: a.href,
    })),
    noindex: noindexSource(parsed, headers),
    canonical,
  };
}
