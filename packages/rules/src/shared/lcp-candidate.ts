// LCP image candidates, shared by perf/lcp-hints and perf/lcp-fetchpriority (#516).
//
// Both rules reason about "the hero image", so they must pick it the same way. An
// eligible candidate is an eager (non-lazy) content image that is not a tracking
// pixel, SVG or icon, not inside a header or nav (site chrome), and not declared
// under 300px on both sides. Images with no declared dimensions stay eligible.

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

// Skip obvious non-LCP raster candidates (tracking pixels, spacers).
const NON_CONTENT_SRC = /pixel|spacer|blank|1x1|tracking/i;

// Below this (when BOTH dims are declared) the image is too small to be the LCP.
const MIN_HERO_DIMENSION = 300;

function isSmallDeclared(width: string | null, height: string | null): boolean {
  const w = width ? Number.parseInt(width, 10) : Number.NaN;
  const h = height ? Number.parseInt(height, 10) : Number.NaN;
  // Only judge when both dimensions are declared; undimensioned heroes stay eligible.
  if (Number.isNaN(w) || Number.isNaN(h)) return false;
  return Math.max(w, h) < MIN_HERO_DIMENSION;
}

// Comparison key for src/preload matching: absolute URL without query or hash, so
// a relative src, an absolute preload and a cache-busting query all match. Null
// when unparseable.
function urlKey(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

// URL keys from a srcset / imagesrcset attribute (drops the descriptors).
function srcsetKeys(value: string | null, base: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const url = part.trim().split(/\s+/)[0];
    if (!url) continue;
    const key = urlKey(url, base);
    if (key) out.push(key);
  }
  return out;
}

/** Eligible LCP candidates in document order, at most `limit`. */
export function findLcpCandidates(doc: Document, limit = Number.POSITIVE_INFINITY): Element[] {
  const candidates: Element[] = [];
  for (const img of querySelectorAllOutsideNoscript(doc, "img")) {
    if (candidates.length >= limit) break;
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    if (NON_CONTENT_SRC.test(src)) continue;
    const lower = src.toLowerCase().split("?")[0] ?? src;
    if (lower.endsWith(".svg") || lower.endsWith(".ico")) continue;
    if (img.getAttribute("loading") === "lazy") continue;
    if (isSmallDeclared(img.getAttribute("width"), img.getAttribute("height"))) continue;
    // Skip logos inside header/nav; rarely the LCP element.
    if (img.closest("header, nav")) continue;
    candidates.push(img);
  }
  return candidates;
}

/** The page's hero candidate: the first eligible image, or null. */
export function findLcpCandidate(doc: Document): Element | null {
  return findLcpCandidates(doc, 1)[0] ?? null;
}

/** URL keys of every `<link rel="preload" as="image">` (href and imagesrcset). */
export function collectImagePreloadKeys(doc: Document, pageUrl: string): Set<string> {
  const keys = new Set<string>();
  for (const link of querySelectorAllOutsideNoscript(doc, 'link[rel~="preload"][as="image"]')) {
    const href = link.getAttribute("href");
    if (href) {
      const key = urlKey(href, pageUrl);
      if (key) keys.add(key);
    }
    for (const key of srcsetKeys(link.getAttribute("imagesrcset"), pageUrl)) keys.add(key);
  }
  return keys;
}

/**
 * True when an image preload matches the image's src or any of its srcset URLs
 * (a responsive hero preloads a srcset variant). URL-matched only: a preload for
 * some other image is no evidence this one is handled.
 */
export function isImagePreloaded(img: Element, preloadKeys: Set<string>, pageUrl: string): boolean {
  const keys = srcsetKeys(img.getAttribute("srcset"), pageUrl);
  const src = img.getAttribute("src");
  const srcKey = src ? urlKey(src, pageUrl) : null;
  if (srcKey) keys.push(srcKey);
  return keys.some((key) => preloadKeys.has(key));
}
