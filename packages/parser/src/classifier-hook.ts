// The seam between the parser and the page classifier (#2307).
//
// The parser never imports the classifier or its artifact. A caller that wants model-backed link
// sections passes a hook; the parser calls it once per page with the document it already parsed,
// then uses the returned placer for each anchor and stores the page-level answer on the parsed page.

import type { PageClassification } from "@squirrelscan/core-contracts";
import type { Document } from "linkedom";

import type { LinkPlacer } from "./extractors/link-section";

/** What one run of the classifier hands back for a page. */
export interface PageClassifierOutput {
  /** Stored on the parsed page as `classification`. */
  classification: PageClassification;
  /** Places one anchor on the page; the parser asks it only where the markup is silent. */
  placeLink: LinkPlacer;
}

/**
 * Classify one parsed page. Return null to skip it (classifier off, or nothing to classify).
 * A throw is caught by the parser and reads as null: classification never fails a parse.
 */
export type PageClassifierHook = ((input: {
  document: Document;
  url: string;
  html: string;
}) => PageClassifierOutput | null) & {
  /**
   * Identifies the classifier that answers (the `model` stamped on each classification). A caller
   * that reuses stored parses compares it with the stored one and re-parses a page that differs.
   */
  readonly version?: string;
};

/** Options for `parsePage`. */
export interface ParsePageOptions {
  /** Run the page classifier on this page; see {@link PageClassifierHook}. */
  classify?: PageClassifierHook;
}

/** Run a hook without ever letting it fail the parse. */
export function runClassifier(
  hook: PageClassifierHook | undefined,
  document: Document,
  url: string,
  html: string,
): PageClassifierOutput | null {
  if (!hook) return null;
  try {
    return hook({ document, url, html });
  } catch {
    return null;
  }
}
