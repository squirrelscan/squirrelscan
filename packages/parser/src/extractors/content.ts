// Content extractor - works with pre-parsed Document
// Analyzes text content, word count, and content quality

import type { Document, Element, Node } from "linkedom";

import { Effect } from "effect";

// Trace stubs (CLI wraps with rich logger)
const logger = { traceStart: (_n: string) => "", traceEnd: (_id: string, _m?: Record<string, unknown>) => {} };

import type { ContentAnalysis } from "./types";
import { collectTextExcluding, tagExcluder } from "./dom-text";

// Tag-based exclusions, plus class/aria exclusions for clean text below.
const CLEAN_REMOVE_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "video",
  "audio",
  "template",
]);
const MAIN_REMOVE_TAGS = new Set([
  "script",
  "style",
  "nav",
  "footer",
  "header",
  "aside",
]);
const isMainExcluded = tagExcluder(MAIN_REMOVE_TAGS);

// Exclusion predicate mirroring the original selector list exactly: the tag set
// plus [aria-hidden="true"] and the .visually-hidden / .sr-only /
// .screen-reader-text class tokens (classList.contains matches the same tokens
// as the `.class` selectors; the aria check matches the exact `="true"` value).
function isCleanExcluded(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  if (tag && CLEAN_REMOVE_TAGS.has(tag)) return true;
  if (el.getAttribute?.("aria-hidden") === "true") return true;
  const classList = el.classList;
  if (
    classList &&
    (classList.contains("visually-hidden") ||
      classList.contains("sr-only") ||
      classList.contains("screen-reader-text"))
  ) {
    return true;
  }
  return false;
}

/**
 * Simple string hash for duplicate detection
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Get clean text content from document (excluding scripts, styles, etc.)
 */
export function getCleanTextContent(doc: Document): string {
  const spanId = logger.traceStart("getCleanTextContent");
  const body = doc.querySelector("body");
  if (!body) {
    logger.traceEnd(spanId, { result: "no-body" });
    return "";
  }

  // Non-mutating walk (no deep clone — the old bottleneck — and no N
  // querySelectorAll passes). Output identical to the prior clone-and-strip.
  const result = collectTextExcluding(body as Node, isCleanExcluded).trim();
  logger.traceEnd(spanId, { textLen: result.length });
  return result;
}

/**
 * Extract content analysis from document
 */
export function extractContent(doc: Document, html: string): ContentAnalysis {
  const text = getCleanTextContent(doc);
  // Normalize whitespace for clean textContent
  const textContent = text.replace(/\s+/g, " ");
  const words = text.split(/\s+/).filter((w) => w.length > 0);

  return {
    wordCount: words.length,
    textLength: text.length,
    htmlLength: html.length,
    textToHtmlRatio: html.length > 0 ? text.length / html.length : 0,
    isThinContent: words.length < 300,
    contentHash: simpleHash(text),
    textContent,
  };
}

/**
 * Get main content text (article, main, or body)
 */
export function getMainContent(doc: Document): string {
  // Try to find main content area
  const mainSelectors = [
    "article",
    "main",
    '[role="main"]',
    ".content",
    ".post-content",
    ".article-content",
    ".entry-content",
    "#content",
    "#main",
  ];

  for (const selector of mainSelectors) {
    const element = doc.querySelector(selector);
    if (element) {
      // Non-mutating walk, skipping the same tags the prior clone-and-strip
      // removed. Output identical, no deep clone.
      const text = collectTextExcluding(element as Node, isMainExcluded).trim();
      if (text && text.length > 100) {
        return text;
      }
    }
  }

  // Fall back to full body text
  return getCleanTextContent(doc);
}

/**
 * Calculate reading time (average 200 words per minute)
 */
export function getReadingTime(doc: Document): number {
  const text = getCleanTextContent(doc);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return Math.ceil(words.length / 200);
}

/**
 * Detect content language from html lang attribute or meta
 */
export function detectLanguage(doc: Document): string | null {
  // Check html lang attribute
  const htmlLang = doc.documentElement?.getAttribute("lang");
  if (htmlLang) return htmlLang;

  // Check meta language
  const metaLang = doc
    .querySelector('meta[http-equiv="content-language"]')
    ?.getAttribute("content");
  if (metaLang) return metaLang;

  return null;
}

// Effect version for concurrent execution
export const extractContentEffect = (doc: Document, html: string) =>
  Effect.sync(() => extractContent(doc, html));
