// Schema parser - extracts and parses JSON-LD from documents

import type { Document, Element } from "linkedom";

import type { ParsedSchema } from "./types";

import { SchemaCollection } from "./collection";
import { validateSchemas } from "./validator";

/**
 * Parse JSON-LD schemas from a document
 */
export function parseSchemas(doc: Document): SchemaCollection {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const schemas: ParsedSchema[] = [];
  const errors: string[] = [];
  const rawParts: string[] = [];

  for (const script of scripts) {
    const content = (script as Element).textContent;
    if (!content) continue;

    rawParts.push(content);

    try {
      // Clean the content
      const cleaned = content
        .trim()
        .replace(/^\uFEFF/, "") // Remove BOM
        .replace(/<!--[\s\S]*?-->/g, ""); // Remove HTML comments

      const json = JSON.parse(cleaned);
      extractSchemas(json, schemas);
    } catch (e) {
      errors.push(`Invalid JSON-LD: ${(e as Error).message}`);
    }
  }

  const validationIssues = validateSchemas(schemas);
  const validationErrors = validationIssues.map((issue) => issue.message);
  const allErrors = [...errors, ...validationErrors];

  return new SchemaCollection(
    schemas,
    allErrors,
    rawParts.length > 0 ? rawParts.join("\n\n") : null,
    validationIssues
  );
}

/**
 * Recursively extract schemas from parsed JSON
 * @param obj - The JSON object to extract schemas from
 * @param schemas - Array to collect extracted schemas
 * @param parentContext - @context from parent object (for @graph inheritance)
 */
function extractSchemas(
  obj: unknown,
  schemas: ParsedSchema[],
  parentContext?: unknown
): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractSchemas(item, schemas, parentContext);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Handle @graph - propagate parent @context to children
  if (record["@graph"] && Array.isArray(record["@graph"])) {
    const graphContext = record["@context"] ?? parentContext;
    for (const item of record["@graph"]) {
      extractSchemas(item, schemas, graphContext);
    }
    return;
  }

  // If this object has @type, it's a schema
  if (record["@type"]) {
    const normalized = normalizeSchema(record, parentContext);
    if (normalized) {
      schemas.push(normalized);
    }
  }
}

/**
 * Normalize a schema object to ParsedSchema
 * @param obj - Schema object to normalize
 * @param parentContext - Inherited @context from parent (for @graph items)
 */
function normalizeSchema(
  obj: Record<string, unknown>,
  parentContext?: unknown
): ParsedSchema | null {
  const type = obj["@type"];
  if (!type) return null;

  // Validate type is string or string[] (no normalization - preserve all types)
  if (typeof type !== "string" && !Array.isArray(type)) return null;
  if (Array.isArray(type) && !type.every((t) => typeof t === "string"))
    return null;

  // Inject parent @context if item lacks its own
  const context = obj["@context"] ?? parentContext;

  return {
    ...obj,
    "@type": type,
    ...(context !== undefined && { "@context": context }),
  } as ParsedSchema;
}
