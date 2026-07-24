// Schema module exports

export {
  SchemaCollection,
  EMPTY_SCHEMA_COLLECTION,
  schemaCollectionFromJSON,
} from "./collection";
export { parseSchemas } from "./parser";
export { extractAuthorFromSchema } from "./author";
export type { AuthorInfo } from "./author";

// Re-export types
export type {
  SchemaType,
  ParsedSchema,
  ImageObjectSchema,
  PersonSchema,
  OrganizationSchema,
  LocalBusinessSchema,
  ArticleSchema,
  ProductSchema,
  FAQPageSchema,
  EventSchema,
  RecipeSchema,
  VideoObjectSchema,
  BreadcrumbListSchema,
  WebSiteSchema,
  WebPageSchema,
} from "./types";
