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

/**
 * The placer a classified document answered with, kept per document so a rule can ask which
 * region an element sits in without the node list ever being stored on the page (repo#3544).
 * Weak on purpose: it lives and dies with the in-memory DOM and is never serialised, so a page
 * rebuilt from cached HTML has no entry and rules fall back to the markup landmarks.
 */
const PLACERS = new WeakMap<object, LinkPlacer>();

/** Remember the placer for a document (the parser does this; tests may too). */
export function setDocumentPlacer(document: object, placer: LinkPlacer): void {
  PLACERS.set(document, placer);
}

/** The classifier's element placer for this document, or null when it was not classified. */
export function getDocumentPlacer(document: object | null | undefined): LinkPlacer | null {
  return document ? (PLACERS.get(document) ?? null) : null;
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
    const out = hook({ document, url, html });
    if (out) PLACERS.set(document, out.placeLink);
    return out;
  } catch {
    return null;
  }
}
