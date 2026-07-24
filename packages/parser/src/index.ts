// @squirrelscan/parser - HTML parsing and extraction

import { parseHTML } from "linkedom";

export {
  parsePage,
  extractMeta,
  extractH1,
  extractOG,
  extractTwitter,
  extractLinks as extractLinksBasic,
  extractImages,
  extractSchema,
  extractHeadings,
  extractContent,
  type ParsedPage,
  type ParsedPageCache,
} from "./html";

export { detectPageType, type PageType } from "./page-type";

export {
  detectSoft404,
  looksLikeNotFoundText,
  hasErrorShellMarker,
  type Soft404Detection,
  type Soft404Signal,
  type Soft404SignalName,
  type Soft404Input,
  type Soft404Confirmation,
} from "./soft404";

export {
  extractVisibleMeta,
  EMPTY_VISIBLE_META,
  type VisibleMeta,
} from "./visible-meta";

export {
  parseSchemas,
  extractAuthorFromSchema,
  EMPTY_SCHEMA_COLLECTION,
  schemaCollectionFromJSON,
  type AuthorInfo,
} from "./schema";

export { SchemaCollection } from "./schema/collection";

// Re-export extractor types and functions
export * from "./extractors";

// Parse HTML string into Document (single parse, reused by all extractors)
export function parseDocument(html: string): ReturnType<typeof parseHTML>["document"] {
  const { document } = parseHTML(html);
  return document;
}
