// Core parsing module - extracts all data from HTML
// This module consolidates all extraction functions for use by the rule runner
// IMPORTANT: HTML is parsed ONCE and the document is reused by all extractors and rules

import { clampItemString } from "@squirrelscan/core-contracts/clamp";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { coerceSchemelessUrl } from "@squirrelscan/utils";
import { parseHTML, type Document, type Element } from "linkedom";

import type {
  ContentAnalysis,
  HeadingData,
  HeadingHierarchy,
  ImageData,
  LinkData,
  MetaData,
  OpenGraphData,
  ParsedPage as BaseParsedPage,
  SchemaData,
  TwitterData,
} from "@squirrelscan/core-contracts";

import type { AuthorInfo } from "./schema";
import type { PageType } from "./page-type";
import type { SchemaCollection } from "./schema/collection";
import type { Soft404Confirmation, Soft404Signal } from "./soft404";

// Full ParsedPage with DOM reference (extends core-contracts version)
export interface ParsedPage extends BaseParsedPage {
  document: Document | null;
  schemas: SchemaCollection;
  author: AuthorInfo | null;
  pageType: PageType;
  // Soft-404 signal — set per-run by the rule runner (needs the page status
  // code), not by `parsePage`. See @squirrelscan/parser `detectSoft404`.
  isSoft404?: boolean;
  soft404Signals?: Soft404Signal[];
  // Verdict of the end-of-crawl confirmation re-fetch (#1177); absent until the
  // audit-engine confirm pass runs (e.g. runner-only paths / storage reads).
  soft404Confirmation?: Soft404Confirmation;
}

// Crawl-time ParsedPage keyed by normalizedUrl, so an audit reuses the DOM (#267)
export type ParsedPageCache = Map<string, ParsedPage>;

import { detectPageType } from "./page-type";
import { parseSchemas, extractAuthorFromSchema } from "./schema";
import { extractVisibleMeta } from "./visible-meta";

// Extract meta tags from parsed document
export function extractMeta(doc: Document): MetaData {
  return {
    title: doc.querySelector("title")?.textContent ?? null,
    description:
      doc.querySelector('meta[name="description"]')?.getAttribute("content") ??
      null,
    canonical:
      doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
    robots:
      doc.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null,
  };
}

// Extract H1 tags from parsed document
export function extractH1(doc: Document): { count: number; texts: string[] } {
  const h1s = doc.querySelectorAll("h1");
  const h1Array = Array.from(h1s) as Element[];

  return {
    count: h1s.length,
    // Cap at extraction (#1216/#1228): the publishers read `parsed.h1.texts`
    // (NOT `headings.h1Texts`), so an unbounded h1 here 400'd whole publishes
    // before the server clamp existed — same cap as extractHeadings.
    texts: h1Array.map((h1) =>
      clampItemString(h1.textContent?.trim() ?? "", REPORT_LIMITS.maxMediumString),
    ),
  };
}

// Extract Open Graph tags from parsed document
export function extractOG(doc: Document): OpenGraphData {
  const getOG = (property: string): string | null =>
    doc
      .querySelector(`meta[property="og:${property}"]`)
      ?.getAttribute("content") ?? null;

  return {
    title: getOG("title"),
    description: getOG("description"),
    url: getOG("url"),
    type: getOG("type"),
    image: getOG("image"),
    siteName: getOG("site_name"),
  };
}

// Extract Twitter Card tags from parsed document
export function extractTwitter(doc: Document): TwitterData {
  const getTwitter = (name: string): string | null =>
    doc
      .querySelector(`meta[name="twitter:${name}"]`)
      ?.getAttribute("content") ?? null;

  return {
    card: getTwitter("card"),
    title: getTwitter("title"),
    description: getTwitter("description"),
    image: getTwitter("image"),
  };
}

// Extract links from parsed document
export function extractLinks(doc: Document, baseUrl: string): LinkData[] {
  const anchors = doc.querySelectorAll("a[href]");
  const links: LinkData[] = [];
  const baseUrlObj = new URL(baseUrl);

  const shouldSkip = (href: string): boolean => {
    const trimmed = href.trim();
    return (
      trimmed.startsWith("#") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("tel:") ||
      trimmed.startsWith("data:")
    );
  };

  for (const anchor of anchors) {
    const href = (anchor as Element).getAttribute("href");
    if (!href) continue;
    if (shouldSkip(href)) continue;

    try {
      const normalizedHref = coerceSchemelessUrl(href.trim());
      const url = new URL(normalizedHref, baseUrl).toString();
      const text = (anchor as Element).textContent?.trim() ?? "";
      const isInternal = new URL(url).hostname === baseUrlObj.hostname;

      links.push({ url, text, isInternal });
    } catch {
      // Skip invalid URLs
      links.push({
        url: href.trim(),
        text: (anchor as Element).textContent?.trim() ?? "",
        isInternal: false,
        error: "Invalid URL format",
      });
    }
  }

  return links;
}

// Extract images from parsed document
export function extractImages(doc: Document, baseUrl: string): ImageData[] {
  const imgs = doc.querySelectorAll("img");
  const images: ImageData[] = [];

  for (const img of imgs) {
    // Try data-src first (lazy loading), fall back to src
    const src =
      (img as Element).getAttribute("data-src") ||
      (img as Element).getAttribute("data-original") ||
      (img as Element).getAttribute("data-lazy-src") ||
      (img as Element).getAttribute("src");

    if (!src) continue;

    // Skip data: URLs
    if (src.startsWith("data:")) continue;

    try {
      const absoluteSrc = new URL(src, baseUrl).toString();
      images.push({
        src: absoluteSrc,
        alt: (img as Element).getAttribute("alt"),
        width: (img as Element).getAttribute("width"),
        height: (img as Element).getAttribute("height"),
      });
    } catch {
      // Skip invalid URLs
    }
  }

  return images;
}

// Extract JSON-LD schema from parsed document
export function extractSchema(doc: Document): SchemaData {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  const types: string[] = [];
  const errors: string[] = [];
  let raw: string | null = null;

  for (const script of scripts) {
    const content = (script as Element).textContent;
    if (!content) continue;

    raw = content;
    try {
      const json = JSON.parse(content);
      if (Array.isArray(json)) {
        for (const item of json) {
          if (item["@type"]) types.push(item["@type"]);
        }
      } else if (json["@type"]) {
        types.push(json["@type"]);
      }
    } catch (e) {
      errors.push(`Invalid JSON-LD: ${(e as Error).message}`);
    }
  }

  return {
    types,
    valid: errors.length === 0,
    errors,
    raw,
  };
}

// Extract heading hierarchy from parsed document
export function extractHeadings(doc: Document): HeadingHierarchy {
  const headings: HeadingHierarchy["headings"] = [];
  const h1Texts: string[] = [];
  const skippedLevels: string[] = [];
  const emptyHeadings: HeadingHierarchy["headings"] = [];
  const longHeadings: HeadingHierarchy["headings"] = [];
  const headingTexts: string[] = [];

  let lastLevel = 0;
  let order = 0;

  for (const level of [1, 2, 3, 4, 5, 6]) {
    const elements = doc.querySelectorAll(`h${level}`);
    for (const el of elements) {
      // Cap at the publish schema's medium-string limit (#1216) — same clamp
      // as extractors/headings.ts; oversize h1s must never leave the parser.
      const text = clampItemString(
        (el as Element).textContent?.trim() ?? "",
        REPORT_LIMITS.maxMediumString
      );
      const heading = { level, text, order: order++ };
      headings.push(heading);

      if (level === 1) h1Texts.push(text);
      if (!text) emptyHeadings.push(heading);
      if (text.length > 70) longHeadings.push(heading);
      headingTexts.push(text);

      // Check for skipped levels
      if (lastLevel > 0 && level > lastLevel + 1) {
        skippedLevels.push(`H${lastLevel} -> H${level}`);
      }
      lastLevel = level;
    }
  }

  // Find duplicates
  const duplicateHeadings = headingTexts.filter(
    (text, index) => headingTexts.indexOf(text) !== index && text !== ""
  );

  // Build outline
  const outline = headings
    .map(
      (h: HeadingData) => `${"  ".repeat(h.level - 1)}H${h.level}: ${h.text}`
    )
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

// Extract content analysis from parsed document
export function extractContent(doc: Document, html: string): ContentAnalysis {
  // Get text content (excluding scripts/styles)
  const body = doc.querySelector("body");
  if (!body) {
    return {
      wordCount: 0,
      textLength: 0,
      htmlLength: html.length,
      textToHtmlRatio: 0,
      isThinContent: true,
      contentHash: "",
      textContent: "",
    };
  }

  // Remove script and style elements for text extraction
  const clone = body.cloneNode(true) as Element;
  for (const el of clone.querySelectorAll("script, style")) {
    el.remove();
  }

  const text = clone.textContent?.trim() ?? "";
  // Normalize whitespace for clean textContent
  const textContent = text.replace(/\s+/g, " ");
  const words = text.split(/\s+/).filter((w) => w.length > 0);

  // Simple hash for duplicate detection
  const hash = simpleHash(text);

  return {
    wordCount: words.length,
    textLength: text.length,
    htmlLength: html.length,
    textToHtmlRatio: html.length > 0 ? text.length / html.length : 0,
    isThinContent: words.length < 300,
    contentHash: hash,
    textContent,
  };
}

// Simple string hash
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// Parse all data from HTML - parses ONCE, reuses document for all extractors
export function parsePage(html: string, url: string): ParsedPage {
  // Single DOM parse - this document is reused by all extractors and available to rules
  const { document: doc } = parseHTML(html);

  // Parse schemas (new rich collection)
  const schemas = parseSchemas(doc);

  // Extract author from schema
  const author = extractAuthorFromSchema(schemas);

  // Extract visible author/date markup (hCard byline, entry-meta <time>) so the
  // eeat rules can fall back to it when JSON-LD omits these signals.
  const visibleMeta = extractVisibleMeta(doc);

  // Detect page type from schema + URL
  const pageType = detectPageType(url, schemas);

  // Legacy schema format (backwards compat)
  const schema: SchemaData = {
    types: schemas.types,
    valid: schemas.valid,
    errors: schemas.errors,
    raw: schemas.raw,
  };

  return {
    document: doc,
    meta: extractMeta(doc),
    h1: extractH1(doc),
    og: extractOG(doc),
    twitter: extractTwitter(doc),
    links: extractLinks(doc, url),
    images: extractImages(doc, url),
    headings: extractHeadings(doc),
    content: extractContent(doc, html),

    // New schema data
    schemas,
    author,
    pageType,

    // Visible (non-schema) author/date markup
    visibleAuthor: visibleMeta.visibleAuthor,
    visibleDatePublished: visibleMeta.visibleDatePublished,
    visibleDateModified: visibleMeta.visibleDateModified,

    // Legacy (deprecated)
    schema,
  };
}
