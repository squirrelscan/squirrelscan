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
 *
 * The returned nodes are raw JSON.parse output from an audited page, so a node
 * can carry an OWN property literally named `__proto__` or `constructor`. That
 * is harmless to hold and to read, but a consumer must never bracket-copy those
 * keys onto a plain `{}` — see @squirrelscan/core-contracts/untrusted-keys.
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
  const visit = (value: unknown, depth: number): void => {
    // The input is JSON from an audited page, so its nesting is chosen by
    // someone else. `'{"@graph":'.repeat(40000)` parses fine and then blows the
    // stack here, which takes down whichever rule called us. Nothing legitimate
    // nests a graph anywhere near this deep.
    if (depth > MAX_GRAPH_DEPTH) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      nodes.push(node);
      if (node["@graph"]) visit(node["@graph"], depth + 1);
    }
  };
  for (const doc of documents) visit(doc, 0);
  return nodes;
}

/**
 * The page's JSON-LD nodes by `@id`, for resolving node references
 * (`{"@id": …}`) within one page (pub#817). Nodes nested in ordinary
 * properties count too (an Offer written inline on one Product can be
 * referenced from another). The first full node with an id wins; an id only a
 * bare reference or a minimal `{"@id", "@type"}` stub carries maps to the
 * first of those, so a stub and the references to it are one object. Ids are
 * resolved against `baseUrl`, so `#q1` and `https://site/page#q1` match.
 */
export function indexJsonLdIds(
  nodes: readonly Record<string, unknown>[],
  baseUrl?: string,
): Map<string, Record<string, unknown>> {
  const full = new Map<string, Record<string, unknown>>();
  const stubs = new Map<string, Record<string, unknown>>();
  let seen = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_GRAPH_DEPTH || seen >= MAX_INDEXED_OBJECTS) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    seen++;
    const node = value as Record<string, unknown>;
    const id = node["@id"];
    if (typeof id === "string" && id !== "") {
      const key = jsonLdIdKey(id, baseUrl);
      const target = isJsonLdReference(node) ? stubs : full;
      if (!target.has(key)) target.set(key, node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "@id" || key === "@type" || key === "@context") continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  for (const node of nodes) visit(node, 0);
  for (const [key, stub] of stubs) if (!full.has(key)) full.set(key, stub);
  return full;
}

/** Objects {@link indexJsonLdIds} looks at, a bound on a hostile page. */
const MAX_INDEXED_OBJECTS = 20_000;

/** An `@id` as an index key: resolved against the page URL when that parses. */
function jsonLdIdKey(id: string, baseUrl: string | undefined): string {
  try {
    return new URL(id, baseUrl).href;
  } catch {
    return id;
  }
}

/**
 * True for a node reference: an object whose only keys are `@id` and,
 * optionally, `@type` and `@context`. Yoast writes
 * `mainEntity: [{"@id": "…#q1"}]` and the node itself elsewhere in the `@graph`.
 */
function isJsonLdReference(value: Record<string, unknown>): boolean {
  if (typeof value["@id"] !== "string") return false;
  return Object.keys(value).every((key) => key === "@id" || key === "@type" || key === "@context");
}

/**
 * `value` with a node reference replaced by the node it names on the page,
 * when there is one. Anything else, a dangling reference included, comes back
 * as it was, so a rule judging it still sees what the markup says.
 */
export function resolveJsonLdRef(
  value: unknown,
  ids: ReadonlyMap<string, Record<string, unknown>>,
  baseUrl?: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const node = value as Record<string, unknown>;
  if (!isJsonLdReference(node)) return value;
  return ids.get(jsonLdIdKey(node["@id"] as string, baseUrl)) ?? value;
}

/**
 * How deep a `@graph` chain is followed.
 *
 * Real markup is one or two levels: a document wrapping a `@graph`, whose
 * entries are occasionally arrays. 64 is far past anything a generator emits
 * and far short of the stack.
 */
const MAX_GRAPH_DEPTH = 64;

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
