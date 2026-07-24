// Meta tag extractor - works with pre-parsed Document
// Extracts title, description, canonical, robots

import type { Document } from "linkedom";

import { Effect } from "effect";

import type { MetaData, OpenGraphData, TwitterData } from "./types";

/**
 * Extract meta tags from document
 */
export function extractMeta(doc: Document): MetaData {
  const titleEl = doc.querySelector("title");
  const title = titleEl?.textContent?.trim() ?? null;

  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ??
    null;
  const canonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
  const robots =
    doc.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;

  return {
    title: title || null, // Convert empty string to null
    description: description || null, // Convert empty string to null
    canonical: canonical || null, // Convert empty string to null
    robots: robots || null, // Convert empty string to null
  };
}

/**
 * Extract Open Graph tags
 */
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

/**
 * Extract Twitter Card tags
 */
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

/**
 * Extract H1 tags
 */
export function extractH1(doc: Document): { count: number; texts: string[] } {
  const h1s = doc.querySelectorAll("h1");
  const h1Array = Array.from(h1s) as Element[];

  return {
    count: h1s.length,
    texts: h1Array.map((h1) => h1.textContent?.trim() ?? ""),
  };
}

// Effect versions for concurrent execution
export const extractMetaEffect = (doc: Document) =>
  Effect.sync(() => extractMeta(doc));

export const extractOGEffect = (doc: Document) =>
  Effect.sync(() => extractOG(doc));

export const extractTwitterEffect = (doc: Document) =>
  Effect.sync(() => extractTwitter(doc));

export const extractH1Effect = (doc: Document) =>
  Effect.sync(() => extractH1(doc));
