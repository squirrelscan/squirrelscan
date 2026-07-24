/**
 * Rich result schema type detection utilities
 */

import type { SchemaCollection } from "@squirrelscan/core-contracts";

/**
 * Flatten a raw JSON-LD string into the full list of schema nodes.
 * Handles top-level arrays, single objects, and Yoast-style `@graph`
 * wrappers (nested recursively). Returns [] for unparseable input.
 * Rules that JSON.parse `schema.raw` and only inspect top-level keys
 * silently miss everything on @graph sites — always go through this.
 */
export function flattenJsonLdNodes(raw: string): Record<string, unknown>[] {
  // raw may be several JSON-LD blocks joined with blank lines (one per
  // <script type="application/ld+json">) — fall back to per-block parsing.
  const documents: unknown[] = [];
  const tryParseParts = (separator: RegExp): boolean => {
    let parsedAny = false;
    for (const part of raw.split(separator)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        documents.push(JSON.parse(trimmed));
        parsedAny = true;
      } catch {
        // Skip unparseable block
      }
    }
    return parsedAny;
  };
  try {
    documents.push(JSON.parse(raw));
  } catch {
    // Blank-line-joined blocks first; legacy raw joined blocks with a
    // single \n (minified JSON-LD = one line per block), so retry per-line.
    if (!tryParseParts(/\n{2,}/)) {
      tryParseParts(/\n/);
    }
  }

  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      nodes.push(node);
      if (node["@graph"]) visit(node["@graph"]);
    }
  };
  for (const doc of documents) visit(doc);
  return nodes;
}

/**
 * Schema types eligible for Google rich results
 * @see https://developers.google.com/search/docs/appearance/structured-data/search-gallery
 */
export const RICH_RESULT_TYPES = [
  "Article",
  "NewsArticle",
  "BlogPosting",
  "Product",
  "Review",
  "Recipe",
  "Event",
  "FAQPage",
  "HowTo",
  "LocalBusiness",
  "Organization",
  "Person",
  "VideoObject",
  "BreadcrumbList",
  "WebSite",
  "SearchAction",
] as const;

/**
 * Check if schemas contain any rich result types
 *
 * @param schemas - Parsed schema collection
 * @returns true if any rich result schema types found
 */
export function hasRichResultSchema(schemas: SchemaCollection): boolean {
  return getRichResultTypes(schemas).length > 0;
}

/**
 * Get all rich result schema types present in the collection
 *
 * @param schemas - Parsed schema collection
 * @returns Array of rich result types found (deduplicated)
 */
export function getRichResultTypes(schemas: SchemaCollection): string[] {
  const richTypes = new Set<string>();

  for (const type of schemas.types) {
    // Case-insensitive match against rich result types
    const match = RICH_RESULT_TYPES.find(
      (richType) => richType.toLowerCase() === type.toLowerCase()
    );

    if (match) {
      richTypes.add(match); // Use canonical casing
    }
  }

  return Array.from(richTypes);
}
