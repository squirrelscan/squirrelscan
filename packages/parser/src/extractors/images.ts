// Image extractor - works with pre-parsed Document
// Extracts all images with lazy loading and figure detection

import type { Document, Element } from "linkedom";

import { Effect } from "effect";

import type { ExtractedImage } from "./types";

/**
 * Check if image is lazy loaded
 */
function isLazyLoaded(element: Element): boolean {
  // Check loading attribute
  if (element.getAttribute("loading") === "lazy") return true;

  // Check common lazy loading patterns
  const src = element.getAttribute("src") ?? "";
  const dataSrc = element.getAttribute("data-src");
  const dataSrcset = element.getAttribute("data-srcset");
  const dataLazy = element.getAttribute("data-lazy");
  const lazyload = element.getAttribute("data-lazyload");

  // If has data-src but src is placeholder, it's lazy
  if (
    dataSrc &&
    (src === "" || src.includes("placeholder") || src.includes("data:image"))
  ) {
    return true;
  }

  // Check for common lazy loading class names
  // Use getAttribute - SVG elements have SVGAnimatedString, not string
  const className = (element.getAttribute?.("class") ?? "").toLowerCase();
  if (
    className.includes("lazy") ||
    className.includes("lazyload") ||
    className.includes("lazyloading")
  ) {
    return true;
  }

  return !!(dataSrcset || dataLazy || lazyload);
}

/**
 * Check if image is inside a figure element
 */
function isInFigure(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.tagName?.toLowerCase() === "figure") {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Get the actual image source (handling lazy loading)
 */
function getImageSrc(element: Element, baseUrl: string): string | null {
  // First try data-src (lazy loaded)
  let src =
    element.getAttribute("data-src") ||
    element.getAttribute("data-original") ||
    element.getAttribute("data-lazy-src") ||
    element.getAttribute("src");

  if (!src) return null;

  // Skip data: URLs and empty sources
  if (src.startsWith("data:") || src === "") return null;

  // Resolve relative URLs
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Extract all images from document
 */
export function extractImages(
  doc: Document,
  baseUrl: string
): ExtractedImage[] {
  const imgs = doc.querySelectorAll("img");
  const images: ExtractedImage[] = [];

  for (const img of imgs) {
    const element = img as Element;
    const src = getImageSrc(element, baseUrl);

    if (!src) continue;

    images.push({
      src,
      alt: element.getAttribute("alt"),
      width: element.getAttribute("width"),
      height: element.getAttribute("height"),
      isLazyLoaded: isLazyLoaded(element),
      inFigure: isInFigure(element),
    });
  }

  // Also check for picture > source elements
  const pictures = doc.querySelectorAll("picture source[srcset]");
  for (const source of pictures) {
    const element = source as Element;
    const srcset = element.getAttribute("srcset");
    if (!srcset) continue;

    // Parse srcset to get URLs
    const sources = srcset.split(",").map((s) => s.trim().split(/\s+/)[0]);
    for (const src of sources) {
      try {
        const resolvedSrc = new URL(src, baseUrl).toString();
        // Check if we already have this image
        if (!images.some((img) => img.src === resolvedSrc)) {
          images.push({
            src: resolvedSrc,
            alt: null, // picture sources don't have alt
            width: element.getAttribute("width"),
            height: element.getAttribute("height"),
            isLazyLoaded: false,
            inFigure: isInFigure(element),
          });
        }
      } catch {
        // Skip invalid URLs
      }
    }
  }

  return images;
}

/**
 * Get unique image sources
 */
export function getUniqueImageUrls(doc: Document, baseUrl: string): string[] {
  const images = extractImages(doc, baseUrl);
  return [...new Set(images.map((img) => img.src))];
}

/**
 * Get images missing alt text
 */
export function getImagesWithoutAlt(
  doc: Document,
  baseUrl: string
): ExtractedImage[] {
  return extractImages(doc, baseUrl).filter(
    (img) => img.alt === null || img.alt === ""
  );
}

/**
 * Get images missing dimensions
 */
export function getImagesWithoutDimensions(
  doc: Document,
  baseUrl: string
): ExtractedImage[] {
  return extractImages(doc, baseUrl).filter((img) => !img.width || !img.height);
}

// Effect version for concurrent execution
export const extractImagesEffect = (doc: Document, baseUrl: string) =>
  Effect.sync(() => extractImages(doc, baseUrl));
