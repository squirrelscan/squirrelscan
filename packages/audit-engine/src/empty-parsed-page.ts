import { EMPTY_SCHEMA_COLLECTION } from "@squirrelscan/parser";
import type { ParsedPage } from "@squirrelscan/rules";

/**
 * Empty ParsedPage for error pages (4xx/5xx) that have no HTML content.
 * Used in site context for broken link detection - only statusCode matters.
 */
export const EMPTY_PARSED_PAGE: ParsedPage = {
  document: null,
  meta: { title: null, description: null, canonical: null, robots: null },
  h1: { count: 0, texts: [] },
  og: {
    title: null,
    description: null,
    url: null,
    type: null,
    image: null,
    siteName: null,
  },
  twitter: { card: null, title: null, description: null, image: null },
  links: [],
  images: [],
  headings: {
    headings: [],
    h1Count: 0,
    h1Texts: [],
    hasSkippedLevels: false,
    skippedLevels: [],
    emptyHeadings: [],
    longHeadings: [],
    duplicateHeadings: [],
    outline: "",
  },
  content: {
    wordCount: 0,
    textLength: 0,
    htmlLength: 0,
    textToHtmlRatio: 0,
    isThinContent: true,
    contentHash: "",
    textContent: "",
  },
  schemas: EMPTY_SCHEMA_COLLECTION,
  author: null,
  pageType: "unknown",
  schema: { types: [], valid: true, errors: [], raw: null },
};
