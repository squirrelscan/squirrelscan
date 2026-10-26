// Link extractor - works with pre-parsed Document
// Extracts all links with position detection and rel attributes

import type { Document, Element } from "linkedom";

import {
  coerceSchemelessUrl,
  hasNonCrawlableUrlScheme,
  isCloudflareEmailProtectionUrl,
} from "@squirrelscan/utils";
import { Effect } from "effect";

// Trace stubs (CLI wraps with rich logger)
const logger = {
  traceStart: (_n: string) => "",
  traceEnd: (_id: string, _m?: Record<string, unknown>) => {},
};

import type { ExtractedLink, LinkPosition } from "./types";

import { createSiteChromeTest } from "./chrome";

/**
 * The position an element names itself, or null when it names none.
 *
 * Preserves the original precedence exactly: semantic tag/role groups win over
 * class/id groups, and groups are checked header → footer → nav → sidebar →
 * content. The class/id string work is skipped entirely on elements that have
 * neither a `class` nor an `id` (the common case for wrapper `<div>`s).
 */
function ownLinkPosition(current: Element): LinkPosition | null {
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
  return null;
}

/**
 * Detect link position in document structure: the position the closest
 * ancestor (or the element itself) names, else "unknown".
 *
 * (squirrelscan/repo#3356) For the many anchors of one document: each call walks
 * up only until it meets an element an earlier call already answered for, and
 * records the answer on every element it passed, so a page's links cost about
 * one walk of the tree instead of one walk to the root per link.
 */
export function createLinkPositionTest(): (element: Element) => LinkPosition {
  // The answer for an element, itself included. Weak, for the same reason as
  // createSiteChromeTest: the memo must never keep a page's DOM alive.
  const known = new WeakMap<Element, LinkPosition>();
  return (element) => {
    const passed: Element[] = [];
    let answer: LinkPosition = "unknown";
    let current: Element | null = element;
    while (current) {
      const cached = known.get(current);
      if (cached !== undefined) {
        answer = cached;
        break;
      }
      passed.push(current);
      const own = ownLinkPosition(current);
      if (own) {
        answer = own;
        break;
      }
      current = current.parentElement;
    }
    for (const el of passed) known.set(el, answer);
    return answer;
  };
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
  const detectLinkPosition = createLinkPositionTest();
  const isInSiteChrome = createSiteChromeTest();
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
      // pub#811: an obfuscated email address, not a page: never crawled or
      // checked, on this site or another (`extractContactLinks` carries it).
      if (isCloudflareEmailProtectionUrl(url)) continue;
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
        // Landmark-strict, unlike `position` above (#109) — see ./chrome.ts.
        isChrome: isInSiteChrome(element),
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
