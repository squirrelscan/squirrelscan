// Author extraction from schema.org data

import type { SchemaCollection } from "./collection";
import type {
  ImageObjectSchema,
  OrganizationSchema,
  ParsedSchema,
  PersonSchema,
} from "./types";

/**
 * Author information extracted from schema
 */
export interface AuthorInfo {
  name: string;
  url?: string;
  image?: string;
  jobTitle?: string;
  socialProfiles?: string[];
}

/**
 * Extract author information from schema collection
 *
 * Priority:
 * 1. Article.author (Person or Organization)
 * 2. Recipe.author
 * 3. Standalone Person schema
 *
 * Yoast/Kadence and many WP themes emit `@graph` with the article's `author`
 * as an `{ "@id": "…" }` reference to a separate Person node. We resolve those
 * references against the full node set so the *correct* author is returned —
 * the old standalone-Person fallback grabbed whichever Person appeared first
 * (e.g. the publisher/editor), not the one the article actually references.
 */
export function extractAuthorFromSchema(
  schemas: SchemaCollection
): AuthorInfo | null {
  // Index every node by @id so author references can be resolved.
  const byId = buildIdIndex(schemas.all);

  // Try Article.author first
  const article = schemas.article;
  if (article?.author) {
    const authorInfo = parseAuthorField(article.author, byId);
    if (authorInfo) return authorInfo;
  }

  // Try Recipe.author
  const recipe = schemas.recipe;
  if (recipe?.author) {
    const authorInfo = parseAuthorField(recipe.author, byId);
    if (authorInfo) return authorInfo;
  }

  // Try standalone Person schema
  const person = schemas.person;
  if (person?.name) {
    return personToAuthorInfo(person);
  }

  return null;
}

/** Build an `@id` → node lookup from all parsed schema nodes. */
function buildIdIndex(
  nodes: ParsedSchema[]
): Map<string, ParsedSchema> {
  const map = new Map<string, ParsedSchema>();
  for (const node of nodes) {
    const id = node["@id"];
    if (typeof id !== "string") continue;
    const existing = map.get(id);
    // A nameless `@id` stub (a forward reference) and the real node often share
    // an id. Prefer whichever carries a name so the stub doesn't shadow the
    // real Person (first-wins would otherwise resolve the author to null). Two
    // *named* duplicates keep the first — malformed input we don't try to merge.
    if (!existing || (!hasName(existing) && hasName(node))) {
      map.set(id, node);
    }
  }
  return map;
}

/** True when a node has a usable string `name`. */
function hasName(node: ParsedSchema): boolean {
  return typeof node["name"] === "string" && node["name"].length > 0;
}

/**
 * Resolve an `{ "@id": "…" }` reference to its full node, if the reference has
 * no inline name/fields. Returns the original value when it isn't a bare ref or
 * can't be resolved.
 */
function resolveRef(
  value: PersonSchema | OrganizationSchema | string,
  byId: Map<string, ParsedSchema>
): PersonSchema | OrganizationSchema | string {
  if (typeof value !== "object" || value === null) return value;
  const id = (value as { "@id"?: unknown })["@id"];
  if (typeof id !== "string") return value;
  // Only follow the reference when the inline object lacks a usable name —
  // an inline name takes precedence over the referenced node.
  if (typeof value.name === "string" && value.name) return value;
  const resolved = byId.get(id);
  if (resolved) {
    return resolved as PersonSchema | OrganizationSchema;
  }
  return value;
}

/**
 * Parse author field which can be string, Person, Organization, array, or an
 * `@id` reference into another `@graph` node.
 */
function parseAuthorField(
  author:
    | PersonSchema
    | OrganizationSchema
    | string
    | (PersonSchema | OrganizationSchema | string)[],
  byId: Map<string, ParsedSchema>
): AuthorInfo | null {
  // Handle array - use first item
  if (Array.isArray(author)) {
    if (author.length === 0) return null;
    return parseAuthorField(author[0], byId);
  }

  // Handle string (just name)
  if (typeof author === "string") {
    return { name: author };
  }

  // Resolve `{ "@id": "…" }` references to the referenced Person/Org node.
  const resolved = resolveRef(author, byId);
  if (typeof resolved === "string") {
    return { name: resolved };
  }
  author = resolved;

  // Handle Person or Organization object
  if (typeof author === "object" && author.name) {
    const type = author["@type"];

    if (type === "Person") {
      return personToAuthorInfo(author as PersonSchema);
    }

    if (
      type === "Organization" ||
      type === "Corporation" ||
      (typeof type === "string" && type.includes("Organization"))
    ) {
      return organizationToAuthorInfo(author as OrganizationSchema);
    }

    // Unknown type but has name
    return { name: author.name };
  }

  return null;
}

/**
 * Convert Person schema to AuthorInfo
 */
function personToAuthorInfo(person: PersonSchema): AuthorInfo {
  return {
    name: person.name!,
    url: person.url,
    image: extractImageUrl(person.image),
    jobTitle: person.jobTitle,
    socialProfiles: person.sameAs,
  };
}

/**
 * Convert Organization schema to AuthorInfo
 */
function organizationToAuthorInfo(org: OrganizationSchema): AuthorInfo {
  return {
    name: org.name!,
    url: org.url,
    image: extractImageUrl(org.logo) ?? extractImageUrl(org.image),
    socialProfiles: org.sameAs,
  };
}

/**
 * Extract URL from image field (can be string or ImageObject)
 */
function extractImageUrl(
  image: string | ImageObjectSchema | (string | ImageObjectSchema)[] | undefined
): string | undefined {
  if (!image) return undefined;

  if (typeof image === "string") return image;

  if (Array.isArray(image)) {
    if (image.length === 0) return undefined;
    return extractImageUrl(image[0]);
  }

  // ImageObject
  return image.url ?? image.contentUrl;
}
