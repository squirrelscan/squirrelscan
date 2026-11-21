// Main text of a page, placed by the classifier (#2359).
//
// The extractor itself lives in @squirrelscan/parser (it must not depend on this package); this
// glue runs the classifier over a parsed document and hands the parser's extractor an
// `elementPlacer` as its placer. With no model the classifier is the rules path, so the placer still
// answers for landmarks and declared comment threads and the markup rules cover the rest.

import {
  extractMainText,
  type MainTextExtraction,
} from "@squirrelscan/parser/main-text";

// linkedom is not a dependency of this package: take the document type from the parser.
type ParsedDocument = Parameters<typeof extractMainText>[0];

import { elementPlacer } from "./placement";
import { classifyDocument, type ClassifyOptions } from "./predict";

/** The classify options that make sense here; `elementsOut` is owned by this function. */
export type MainTextClassifyOptions = Pick<
  ClassifyOptions,
  | "model"
  | "budgetMs"
  | "threshold"
  | "siteFeatures"
  | "html"
  | "platform"
  | "groupFallback"
>;

/**
 * Classify `document`, then extract its main text with the classifier as the placer. The document is
 * not modified. Chrome, ads, cookie banners and the other dropped sections the classifier labels are
 * excluded; where it abstains the parser's markup rules decide.
 */
export function extractPageMainText(
  document: ParsedDocument,
  url: string,
  options: MainTextClassifyOptions = {}
): MainTextExtraction {
  const elements: unknown[] = [];
  const result = classifyDocument(document, url, {
    ...options,
    elementsOut: elements,
  });
  return extractMainText(document, { place: elementPlacer(result, elements) });
}
