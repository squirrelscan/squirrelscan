import type { Document } from "linkedom";

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
  const links = doc.querySelectorAll("link[href]");

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
