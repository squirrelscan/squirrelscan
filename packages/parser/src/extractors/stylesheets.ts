import type { Document } from "linkedom";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

export interface StylesheetRef {
  href: string;
}

function isStylesheetLink(rel: string, asValue: string | null): boolean {
  const relTokens = rel.toLowerCase().split(/\s+/).filter(Boolean);

  if (relTokens.includes("stylesheet")) return true;
  if (relTokens.includes("preload") && asValue?.toLowerCase() === "style") {
    return true;
  }
  return false;
}

export function extractStylesheets(
  doc: Document,
  baseUrl: string
): StylesheetRef[] {
  const results: StylesheetRef[] = [];
  // A <noscript> fallback stylesheet never loads with scripting on (#434).
  const links = querySelectorAllOutsideNoscript(doc, "link[href]");

  for (const link of links) {
    const rel = link.getAttribute("rel") || "";
    const asValue = link.getAttribute("as");
    if (!isStylesheetLink(rel, asValue)) continue;

    const href = link.getAttribute("href");
    if (!href) continue;

    try {
      const resolved = new URL(href, baseUrl).toString();
      results.push({ href: resolved });
    } catch {
      // Ignore invalid URLs
    }
  }

  return results;
}
