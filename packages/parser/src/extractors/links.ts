// Link extractor - works with pre-parsed Document
// Extracts all links with position detection and rel attributes

import type { Document, Element } from "linkedom";

import { coerceSchemelessUrl, hasNonCrawlableUrlScheme } from "@squirrelscan/utils";
import { Effect } from "effect";

// Trace stubs (CLI wraps with rich logger)
const logger = {
  traceStart: (_n: string) => "",
  traceEnd: (_id: string, _m?: Record<string, unknown>) => {},
};

import type { ExtractedLink, LinkPosition } from "./types";

/**
 * Detect link position in document structure.
 *
 * Walks ancestors (closest first), preserving the original precedence exactly:
 * within a level, semantic tag/role groups win over class/id groups, and groups
 * are checked header → footer → nav → sidebar → content. Output is byte-identical
 * to the previous implementation; the optimization is to skip the class/id string
 * work entirely on elements that have neither a `class` nor an `id` (the common
 * case for wrapper `<div>`s), avoiding redundant lowercase allocations and the
 * `.includes` scans on every ancestor.
 */
function detectLinkPosition(element: Element): LinkPosition {
  let current: Element | null = element;

  while (current) {
    const tagName = current.tagName?.toLowerCase();
    const role = current.getAttribute?.("role")?.toLowerCase();

    // Semantic tag/role groups (same combination & precedence as before).
    if (tagName === "header" || role === "banner") return "header";
    if (tagName === "footer" || role === "contentinfo") return "footer";
    if (tagName === "nav" || role === "navigation") return "nav";
    if (tagName === "aside" || role === "complementary") return "sidebar";
    if (tagName === "main" || tagName === "article" || role === "main") return "content";

    // Class/id pattern groups — only computed when the element actually has a
    // class or id (use getAttribute for className: SVG elements expose an
    // SVGAnimatedString, not a string).
    const rawClass = current.getAttribute?.("class");
    const rawId = current.id;
    if (rawClass || rawId) {
      const className = rawClass ? rawClass.toLowerCase() : "";
      const id = rawId ? rawId.toLowerCase() : "";

      if (className.includes("header") || className.includes("masthead") || id.includes("header")) {
        return "header";
      }
      if (className.includes("footer") || className.includes("colophon") || id.includes("footer")) {
        return "footer";
      }
      if (
        className.includes("nav") ||
        className.includes("menu") ||
        className.includes("navigation") ||
        id.includes("nav")
      ) {
        return "nav";
      }
      if (className.includes("sidebar") || className.includes("aside") || id.includes("sidebar")) {
        return "sidebar";
      }
      if (
        className.includes("content") ||
        className.includes("main") ||
        className.includes("article") ||
        className.includes("post") ||
        id.includes("content") ||
        id.includes("main")
      ) {
        return "content";
      }
    }

    current = current.parentElement;
  }

  return "unknown";
}

/**
 * Parse rel attribute into array
 */
function parseRel(rel: string | null): string[] {
  if (!rel) return [];
  return rel
    .toLowerCase()
    .split(/\s+/)
    .filter((r) => r.length > 0);
}

/**
 * Check if link has nofollow
 */
function hasNofollow(relArray: string[]): boolean {
  return (
    relArray.includes("nofollow") || relArray.includes("sponsored") || relArray.includes("ugc")
  );
}

/**
 * Extract all links from document
 */
export function extractLinks(doc: Document, baseUrl: string): ExtractedLink[] {
  const spanId = logger.traceStart("extractLinks");
  const anchors = doc.querySelectorAll("a[href]");
  const links: ExtractedLink[] = [];
  const baseUrlObj = new URL(baseUrl);

  for (const anchor of anchors) {
    const element = anchor as Element;
    const href = element.getAttribute("href");
    if (!href) continue;

    // Skip javascript:, mailto:, tel:, etc.
    if (href.trim() === "#" || hasNonCrawlableUrlScheme(href)) continue;

    const normalizedHref = coerceSchemelessUrl(href.trim());

    try {
      const resolvedUrl = new URL(normalizedHref, baseUrl);
      const url = resolvedUrl.toString();
      const text = element.textContent?.trim() ?? "";
      const isInternal = resolvedUrl.hostname === baseUrlObj.hostname;
      const position = detectLinkPosition(element);
      const rel = parseRel(element.getAttribute("rel"));

      links.push({
        href: url,
        text,
        isInternal,
        position,
        rel,
        isNofollow: hasNofollow(rel),
      });
    } catch {
      // Skip invalid URLs
    }
  }

  logger.traceEnd(spanId, { linkCount: links.length });
  return links;
}

/**
 * Extract internal links only
 */
export function extractInternalLinks(doc: Document, baseUrl: string): ExtractedLink[] {
  return extractLinks(doc, baseUrl).filter((link) => link.isInternal);
}

/**
 * Extract external links only
 */
export function extractExternalLinks(doc: Document, baseUrl: string): ExtractedLink[] {
  return extractLinks(doc, baseUrl).filter((link) => !link.isInternal);
}

/**
 * Get unique link hrefs for crawl queue
 */
export function extractCrawlableUrls(doc: Document, baseUrl: string): string[] {
  const internalLinks = extractInternalLinks(doc, baseUrl);
  const uniqueUrls = new Set<string>();

  for (const link of internalLinks) {
    // Skip nofollow links for crawling
    if (link.isNofollow) continue;

    // Normalize URL (remove fragment, trailing slash normalization)
    try {
      const url = new URL(link.href);
      url.hash = ""; // Remove fragment
      uniqueUrls.add(url.toString());
    } catch {
      // Skip invalid URLs
    }
  }

  return Array.from(uniqueUrls);
}

// Effect version for concurrent execution
export const extractLinksEffect = (doc: Document, baseUrl: string) =>
  Effect.sync(() => extractLinks(doc, baseUrl));

export const extractCrawlableUrlsEffect = (doc: Document, baseUrl: string) =>
  Effect.sync(() => extractCrawlableUrls(doc, baseUrl));
