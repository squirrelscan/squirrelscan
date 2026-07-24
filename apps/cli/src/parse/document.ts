// Parse page processor - single DOM parse, concurrent extractors
// This is the main entry point for parsing a page

import {
  extractMeta,
  extractOG,
  extractTwitter,
  extractH1,
  extractLinks,
  extractImages,
  extractSchema,
  extractHeadings,
  extractContent,
  extractCrawlableUrls,
  type ExtractedLink,
  type ExtractedImage,
} from "@squirrelscan/parser/extractors";
import { Effect } from "effect";
import { parseHTML, type Document } from "linkedom";

import type {
  ContextRef,
  Page,
  ParsedPageData,
  LinkAppearance,
  ImageAppearance,
} from "@/infra/context";

import { getContext, updateContext, addLink, addImage } from "@/infra/context";
import { ParseError } from "@/infra/errors";

// ============================================
// PARSE DOCUMENT
// ============================================

/**
 * Parse HTML string into Document
 * Single parse - reused by all extractors
 */
export function parseDocument(html: string): Document {
  const { document } = parseHTML(html);
  return document;
}

/**
 * Parse document with Effect error handling
 */
export function parseDocumentEffect(
  html: string,
  url: string
): Effect.Effect<Document, ParseError, never> {
  return Effect.try({
    try: () => parseDocument(html),
    catch: (error) =>
      ParseError.html(url, `Failed to parse HTML: ${(error as Error).message}`),
  });
}

// ============================================
// CONCURRENT EXTRACTION
// ============================================

/**
 * Run all extractors concurrently on a parsed document
 */
export function extractAllFromDocument(
  doc: Document,
  html: string,
  baseUrl: string
): Effect.Effect<ParsedPageData, never, never> {
  return Effect.all(
    {
      meta: Effect.sync(() => extractMeta(doc)),
      h1: Effect.sync(() => extractH1(doc)),
      og: Effect.sync(() => extractOG(doc)),
      twitter: Effect.sync(() => extractTwitter(doc)),
      links: Effect.sync(() => extractLinks(doc, baseUrl)),
      images: Effect.sync(() => extractImages(doc, baseUrl)),
      schema: Effect.sync(() => extractSchema(doc)),
      headings: Effect.sync(() => extractHeadings(doc)),
      content: Effect.sync(() => extractContent(doc, html)),
    },
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map(
      ({
        meta,
        h1,
        og,
        twitter,
        links,
        images,
        schema,
        headings,
        content,
      }) => ({
        meta,
        h1,
        og,
        twitter,
        links: links as unknown as ExtractedLink[],
        images: images as unknown as ExtractedImage[],
        schema,
        headings,
        content,
      })
    ),
    // Convert to ParsedPageData format (links/images are different types)
    Effect.map((extracted) => ({
      meta: extracted.meta,
      h1: extracted.h1,
      og: extracted.og,
      twitter: extracted.twitter,
      schema: extracted.schema,
      headings: extracted.headings,
      content: extracted.content,
    }))
  );
}

// ============================================
// CONTEXT UPDATE WITH DEDUPLICATION
// ============================================

/**
 * Update context with parsed page data
 * Handles link/image deduplication
 */
export function updateContextWithParsedPage(
  contextRef: ContextRef,
  pageUrl: string,
  doc: Document,
  html: string,
  baseUrl: string
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    // Extract all data concurrently
    const parsedData = yield* extractAllFromDocument(doc, html, baseUrl);

    // Extract links and images with full data
    const links = extractLinks(doc, baseUrl);
    const images = extractImages(doc, baseUrl);

    // Get current context
    let ctx = yield* getContext(contextRef);

    // Update page with parsed data
    const page = ctx.project.site.pages.get(pageUrl);
    if (page) {
      const updatedPage: Page = {
        ...page,
        parsed: parsedData,
        links: links.map((l) => ({
          href: l.href,
          anchorText: l.text,
          position: l.position,
        })),
        images: images.map((i) => ({
          src: i.src,
          alt: i.alt ?? undefined,
        })),
      };

      const newPages = new Map(ctx.project.site.pages);
      newPages.set(pageUrl, updatedPage);
      ctx = {
        ...ctx,
        project: {
          ...ctx.project,
          site: {
            ...ctx.project.site,
            pages: newPages,
          },
        },
      };
    }

    // Add/update links in site graph (deduplicated)
    for (const link of links) {
      const appearance: LinkAppearance = {
        pageUrl,
        anchorText: link.text,
        position: link.position,
        rel: link.rel,
        isNofollow: link.isNofollow,
      };
      ctx = addLink(ctx, link.href, appearance, link.isInternal);
    }

    // Add/update images in site graph (deduplicated)
    for (const image of images) {
      const appearance: ImageAppearance = {
        pageUrl,
        alt: image.alt ?? undefined,
        width: image.width ?? undefined,
        height: image.height ?? undefined,
        isLazyLoaded: image.isLazyLoaded,
        inFigure: image.inFigure,
      };
      ctx = addImage(ctx, image.src, appearance);
    }

    // Update context
    yield* updateContext(contextRef, () => ctx);
  });
}

// ============================================
// GET CRAWLABLE URLS
// ============================================

/**
 * Get URLs to add to crawl queue from parsed page
 */
export function getCrawlableUrlsFromDocument(
  doc: Document,
  baseUrl: string
): string[] {
  return extractCrawlableUrls(doc, baseUrl);
}

// ============================================
// FULL PARSE PROCESSOR
// ============================================

export interface ParsePageResult {
  parsed: ParsedPageData;
  crawlableUrls: string[];
}

/**
 * Full parse processor - parses page and returns all data
 */
export function parsePageProcessor(
  html: string,
  url: string,
  baseUrl: string
): Effect.Effect<ParsePageResult, ParseError, never> {
  return Effect.gen(function* () {
    // Single DOM parse
    const doc = yield* parseDocumentEffect(html, url);

    // Concurrent extraction
    const parsed = yield* extractAllFromDocument(doc, html, baseUrl);

    // Get crawlable URLs
    const crawlableUrls = getCrawlableUrlsFromDocument(doc, baseUrl);

    return { parsed, crawlableUrls };
  });
}
