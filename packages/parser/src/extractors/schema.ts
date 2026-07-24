// Schema extractor - works with pre-parsed Document
// Extracts JSON-LD structured data

import type { Document, Element } from "linkedom";

import { Effect } from "effect";

import type { SchemaData } from "./types";

/**
 * Recursively extract @type from JSON-LD
 */
function extractTypes(obj: unknown, types: string[]): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractTypes(item, types);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Extract @type
  if (record["@type"]) {
    if (Array.isArray(record["@type"])) {
      types.push(...(record["@type"] as string[]));
    } else if (typeof record["@type"] === "string") {
      types.push(record["@type"]);
    }
  }

  // Check @graph for multiple schemas
  if (record["@graph"] && Array.isArray(record["@graph"])) {
    for (const item of record["@graph"]) {
      extractTypes(item, types);
    }
  }

  // Recursively check nested objects
  for (const key of Object.keys(record)) {
    if (key !== "@type" && key !== "@graph") {
      extractTypes(record[key], types);
    }
  }
}

/**
 * Extract JSON-LD schema from document
 */
export function extractSchema(doc: Document): SchemaData {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const types: string[] = [];
  const errors: string[] = [];
  const rawSchemas: string[] = [];

  for (const script of scripts) {
    const content = (script as Element).textContent;
    if (!content) continue;

    rawSchemas.push(content);

    try {
      // Clean the content (remove HTML comments, BOM, etc.)
      const cleanedContent = content
        .trim()
        .replace(/^\uFEFF/, "") // Remove BOM
        .replace(/<!--[\s\S]*?-->/g, ""); // Remove HTML comments

      const json = JSON.parse(cleanedContent);
      extractTypes(json, types);
    } catch (e) {
      errors.push(`Invalid JSON-LD: ${(e as Error).message}`);
    }
  }

  // Deduplicate types
  const uniqueTypes = [...new Set(types)];

  return {
    types: uniqueTypes,
    valid: errors.length === 0,
    errors,
    raw: rawSchemas.length > 0 ? rawSchemas.join("\n\n") : null,
  };
}

/**
 * Check for specific schema types
 */
export function hasSchemaType(doc: Document, type: string): boolean {
  const schema = extractSchema(doc);
  return schema.types.some(
    (t) => t.toLowerCase() === type.toLowerCase() || t.includes(type)
  );
}

/**
 * Get schema types useful for rich results
 */
export function getRichResultTypes(doc: Document): string[] {
  const schema = extractSchema(doc);
  const richResultTypes = [
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
  ];

  return schema.types.filter((type) =>
    richResultTypes.some((rt) => type.includes(rt))
  );
}

// Effect version for concurrent execution
export const extractSchemaEffect = (doc: Document) =>
  Effect.sync(() => extractSchema(doc));
