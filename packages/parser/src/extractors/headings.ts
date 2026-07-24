// Heading extractor - works with pre-parsed Document
// Analyzes heading hierarchy and structure

import type { Document, Element } from "linkedom";

import { Effect } from "effect";

import type { HeadingHierarchy, HeadingData } from "@squirrelscan/core-contracts";
import { clampItemString } from "@squirrelscan/core-contracts/clamp";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

/**
 * Extract heading hierarchy from document
 */
export function extractHeadings(doc: Document): HeadingHierarchy {
  const headings: HeadingData[] = [];
  const h1Texts: string[] = [];
  const skippedLevels: string[] = [];
  const emptyHeadings: HeadingData[] = [];
  const longHeadings: HeadingData[] = [];
  const headingTexts: string[] = [];

  // Get all headings in document order
  const allHeadings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
  let lastLevel = 0;

  for (let order = 0; order < allHeadings.length; order++) {
    const el = allHeadings[order] as Element;
    const tagName = el.tagName.toLowerCase();
    const level = Number.parseInt(tagName.charAt(1), 10);
    // Cap at the publish schema's medium-string limit (#1216): a >1000-char h1
    // 400'd whole cloud publishes before the server-side clamp existed; capping
    // at the producer keeps every downstream consumer (dedup, outline, report)
    // on the same bounded text.
    const text = clampItemString(
      el.textContent?.trim() ?? "",
      REPORT_LIMITS.maxMediumString
    );

    const heading: HeadingData = { level, text, order };
    headings.push(heading);

    if (level === 1) h1Texts.push(text);
    if (!text) emptyHeadings.push(heading);
    if (text.length > 70) longHeadings.push(heading);
    headingTexts.push(text);

    // Check for skipped levels (e.g., H1 -> H3)
    if (lastLevel > 0 && level > lastLevel + 1) {
      skippedLevels.push(`H${lastLevel} -> H${level}`);
    }
    lastLevel = level;
  }

  // Find duplicates
  const duplicateHeadings = headingTexts.filter(
    (text, index) => headingTexts.indexOf(text) !== index && text !== ""
  );

  // Build outline
  const outline = headings
    .map((h) => `${"  ".repeat(h.level - 1)}H${h.level}: ${h.text}`)
    .join("\n");

  return {
    headings,
    h1Count: h1Texts.length,
    h1Texts,
    hasSkippedLevels: skippedLevels.length > 0,
    skippedLevels,
    emptyHeadings,
    longHeadings,
    duplicateHeadings: [...new Set(duplicateHeadings)],
    outline,
  };
}

/**
 * Check heading structure issues
 */
export interface HeadingIssues {
  noH1: boolean;
  multipleH1: boolean;
  hasSkippedLevels: boolean;
  hasEmptyHeadings: boolean;
  hasLongHeadings: boolean;
  hasDuplicateHeadings: boolean;
}

export function analyzeHeadingIssues(doc: Document): HeadingIssues {
  const hierarchy = extractHeadings(doc);

  return {
    noH1: hierarchy.h1Count === 0,
    multipleH1: hierarchy.h1Count > 1,
    hasSkippedLevels: hierarchy.hasSkippedLevels,
    hasEmptyHeadings: hierarchy.emptyHeadings.length > 0,
    hasLongHeadings: hierarchy.longHeadings.length > 0,
    hasDuplicateHeadings: hierarchy.duplicateHeadings.length > 0,
  };
}

// Effect version for concurrent execution
export const extractHeadingsEffect = (doc: Document) =>
  Effect.sync(() => extractHeadings(doc));
