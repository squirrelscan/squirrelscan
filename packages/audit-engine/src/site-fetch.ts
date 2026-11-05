// Site-fetch helpers: turning stored page records into the parsed site context
// the rules read (#1409, #1312). Extracted from ./adapter so ./streaming and
// ./page-features can use them without importing ./adapter back, which closed a
// runtime import cycle (adapter -> streaming -> adapter, and page-features ->
// adapter). Nothing here imports ./adapter, ./streaming or ./page-features;
// ./adapter re-exports these names so the package barrel is unchanged.

import {
  detectPageType,
  extractAuthorFromSchema,
  extractContactLinks,
  extractContent,
  extractHeadings,
  extractImages,
  extractLinks,
  extractMeta,
  extractOG,
  extractTwitter,
  extractVisibleMeta,
  hasErrorShellMarker,
  parseDocument,
  parseNotices,
  parseSchemas,
  runClassifier,
  schemaCollectionFromJSON,
  toLinkData,
  type ParsedPageCache,
  type ParsePageOptions,
} from "@squirrelscan/parser";
import { Effect } from "effect";

import type { CrawlStorage, PageRecord } from "@squirrelscan/core-contracts/storage";
import type { ParsedPage } from "@squirrelscan/rules";
import { decodedPageBytes } from "@squirrelscan/utils/bytes";
import { overlayTechHeaders } from "@squirrelscan/utils/headers";

import { logger } from "./adapter-logger";

// ============================================
// SITE CONTEXT BUILDER
// ============================================

/**
 * Site context page - pairs a PageRecord with its parsed data
 * This allows us to parse each page once and reuse across workflows
 */
export interface SiteContextPage {
  page: PageRecord;
  parsed: ParsedPage | null;
}

/**
 * True when a crawl page's HTML came from a browser render rather than plain HTTP. Rendered fetchers stamp
 * `fetcherMethod` "cloud-render" (CLI + container paid render) or "browser" (container browser-queue); a
 * render-blocked fallback stamps "fetch" (raw). Drives PageData.rendered (rule gate) + the render-prefetch
 * per-page skip (#673) — keep the two in sync by sourcing both from here.
 */
export const isRenderedFetch = (fetcherId?: string | null): boolean =>
  fetcherId === "cloud-render" || fetcherId === "browser";

/**
 * URLs the crawl already browser-rendered — the render-prefetch per-page skip set (#673/#964). Both the CLI
 * and container prefetch builders derive this identically; sharing one helper keeps them from drifting (a
 * dropped derivation silently re-renders every page — the dead-gate class #673 hit). Structural param so it
 * takes either path's SiteContextPage (both carry `page.url` + `page.fetcherId`).
 */
export function renderedPageUrlsFrom(
  siteContext: ReadonlyArray<{ page: { url: string; fetcherId?: string | null } }>,
): Set<string> {
  const out = new Set<string>();
  for (const { page } of siteContext) {
    if (isRenderedFetch(page.fetcherId)) out.add(page.url);
  }
  return out;
}

/**
 * Build site context by parsing all pages once
 * This eliminates redundant parsing across external link checking and rule execution
 */
export function buildSiteContext(
  pages: PageRecord[],
  parsedCache?: ParsedPageCache,
  limits?: { maxParseBytes?: number },
): Effect.Effect<SiteContextPage[], never, never> {
  return Effect.sync(() => {
    const contextPages: SiteContextPage[] = [];
    const maxParseBytes = limits?.maxParseBytes;

    for (const page of pages) {
      // `--max-duration` (#1332): a page over the cap is stored but never parsed, here or anywhere else.
      if (maxParseBytes !== undefined && decodedPageBytes(page.sizeBytes, page.html ?? "") > maxParseBytes) {
        contextPages.push({ page, parsed: null });
        continue;
      }
      // Skip non-HTML pages by content type
      if (!isHtmlContentType(page.contentType)) {
        contextPages.push({ page, parsed: null });
        continue;
      }

      // An empty body is a document only when the response status permits one.
      // Error pages still join site.pages through EMPTY_PARSED_PAGE below, while
      // 204/205 responses have no representation to parse by definition.
      if (page.html === "" && !isAuditableEmptyBodyStatus(page.status)) {
        contextPages.push({ page, parsed: null });
        continue;
      }

      let parsed: ParsedPage | null = null;

      // Reuse stored parsed data if available
      if (page.parsedData) {
        try {
          const stored = JSON.parse(page.parsedData);

          // Handle corrupted state: parsedData exists but html is null
          if (page.html === null) {
            logger.error(
              `Cannot recreate document for ${page.url}: HTML is null but parsedData exists (corrupted state)`,
            );
            contextPages.push({ page, parsed: null });
            continue;
          }

          // Reuse the crawl-time DOM when present, else re-parse (#267)
          const doc = parsedCache?.get(page.normalizedUrl)?.document ?? parseDocument(page.html);
          // Rehydrate SchemaCollection (getters lost during JSON serialization)
          parsed = {
            document: doc,
            ...stored,
            schemas: schemaCollectionFromJSON(stored.schemas),
            // A parse stored before the marker was captured has no value, but
            // the DOM is live right here, so read it now rather than losing it.
            errorShell:
              typeof stored.errorShell === "boolean" ? stored.errorShell : hasErrorShellMarker(doc),
          };
        } catch (e) {
          logger.error(`Failed to deserialize parsedData for ${page.url}:`, e);
          // Fall through to re-parsing
        }
      }

      // Fallback: parse from HTML if no stored data (old crawls)
      if (!parsed) {
        // Skip pages without HTML and no stored data
        if (page.html === null) {
          contextPages.push({ page, parsed: null });
          continue;
        }

        logger.trace(`Re-parsing HTML for ${page.url} (no stored data)`);
        parsed = parsePageRecord(page);
      }

      contextPages.push({ page, parsed });
    }

    return contextPages;
  });
}

/**
 * Null out every retained DOM in the site context so long DOM-free stretches
 * (cloud prefetch waits, report generation, publish upload) don't keep a
 * GB-scale linkedom working set resident (#858). Under host memory pressure
 * that idle working set gets paged out and the next local phase runs at
 * page-fault speed (observed: 13s of rules taking ~4 minutes).
 *
 * Safe because re-parsing the same `page.html` is deterministic:
 * `ensureSiteContextDocuments` rebuilds an identical DOM on demand
 * (~12.5ms/page, #263 measurements).
 */
export function releaseSiteContextDocuments(siteContext: SiteContextPage[]): void {
  for (const entry of siteContext) {
    if (entry.parsed) entry.parsed.document = null;
  }
}

/**
 * Re-materialize DOMs released by `releaseSiteContextDocuments`. Idempotent:
 * only entries with a null document (and html to parse) are touched, so a
 * never-released context is a no-op.
 */
export function ensureSiteContextDocuments(siteContext: SiteContextPage[]): void {
  for (const entry of siteContext) {
    if (entry.parsed && !entry.parsed.document && entry.page.html !== null) {
      entry.parsed.document = parseDocument(entry.page.html);
    }
  }
}

// ============================================
// PARSED PAGE CONVERSION
// ============================================

/**
 * Parse raw HTML into the ParsedPage shape rules expect. The single source of
 * truth for rule-input parsing — shared by `parsePageRecord` (main-thread
 * pre-parse) and the #263 page-rule workers, which re-parse from html (the
 * linkedom Document can't cross a worker seam). Keeping ONE parse path is what
 * guarantees pooled execution stays byte-identical to serial.
 */
export function parseHtmlForRules(
  html: string,
  baseUrl: string,
  options?: ParsePageOptions,
): ParsedPage {
  const doc = parseDocument(html);
  // The page classifier, when the caller supplied one (#2307): same hook `parsePage` takes.
  const classified = runClassifier(options?.classify, doc, baseUrl, html);

  const meta = extractMeta(doc);
  const og = extractOG(doc);
  const twitter = extractTwitter(doc);
  const headings = extractHeadings(doc);
  const content = extractContent(doc, html);
  const links = extractLinks(doc, baseUrl, classified?.placeLink);
  const images = extractImages(doc, baseUrl);

  // Parse schemas (new rich collection)
  const schemas = parseSchemas(doc);
  const author = extractAuthorFromSchema(schemas);
  const visibleMeta = extractVisibleMeta(doc);
  const pageType = detectPageType(baseUrl, schemas);

  // Legacy schema format (backwards compat)
  const schema = {
    types: schemas.types,
    valid: schemas.valid,
    errors: schemas.errors,
    raw: schemas.raw,
  };

  return {
    document: doc,
    meta,
    og,
    twitter,
    headings,
    content,
    h1: { count: headings.h1Count, texts: headings.h1Texts },
    links: links.map(toLinkData),
    // tel:/mailto: anchors, which `extractLinks` drops as non-crawlable. This is
    // the parse path production actually runs (parsePageRecord + the #263 page-rule
    // workers), so a field populated only by `parsePage` would be invisible live.
    contactLinks: extractContactLinks(doc, classified?.placeLink),
    images: images.map((i) => ({
      src: i.src,
      alt: i.alt,
      width: i.width,
      height: i.height,
    })),
    // Captured now, while the DOM is live: the streamed audit releases it before
    // soft-404 candidates are picked (#235).
    errorShell: hasErrorShellMarker(doc),
    ...(parseNotices(doc).length > 0 ? { parseNotices: parseNotices(doc) } : {}),
    // New schema data
    schemas,
    author,
    pageType,
    // Visible (non-schema) author/date markup
    visibleAuthor: visibleMeta.visibleAuthor,
    visibleDatePublished: visibleMeta.visibleDatePublished,
    visibleDateModified: visibleMeta.visibleDateModified,
    // Present only when the classifier ran (#2307).
    ...(classified ? { classification: classified.classification } : {}),
    // Legacy (deprecated)
    schema,
  };
}

/**
 * Parse a page record to extract structured data for rules
 */
export function parsePageRecord(page: PageRecord, options?: ParsePageOptions): ParsedPage | null {
  if (page.html === null) return null;

  return logger.withTrace(
    "parsePageRecord",
    () => parseHtmlForRules(page.html!, page.url, options),
    () => ({ url: page.url, htmlLen: page.html!.length }),
  );
}

/**
 * Get parsed pages from storage for rule execution
 */
export function getParsedPages(
  storage: CrawlStorage,
  crawlId: string,
): Effect.Effect<Array<{ url: string; parsed: ParsedPage }>, never, never> {
  return Effect.gen(function* () {
    const pages = yield* storage.getPages(crawlId).pipe(Effect.catchAll(() => Effect.succeed([])));

    const result: Array<{ url: string; parsed: ParsedPage }> = [];

    for (const page of pages) {
      if (!hasAuditableHtmlBody(page) || !isHtmlContentType(page.contentType)) continue;

      const parsed = parsePageRecord(page);
      if (parsed) {
        result.push({ url: page.url, parsed });
      }
    }

    return result;
  });
}

/**
 * Flatten a stored page's typed `headers`/`securityHeaders` into the loose
 * `Record<string, string>` rules read via `ctx.page.headers`. Exported (not
 * just a `runRulesOnStorage` closure helper) so it's directly unit-testable —
 * this is the exact seam where a header field can be added to the storage
 * type but never surfaced to rules, as happened with Set-Cookie (#748).
 */
/**
 * Whether a stored page record carries the version headers (#713). The crawler
 * writes them as `null` when not sent; a record stored before they existed has
 * no key at all, and security/version-disclosure must not read that as "not sent".
 */
export function recordsVersionHeaders(page: PageRecord): boolean {
  return page.headers?.xPoweredBy !== undefined;
}

/**
 * The header map technology detection reads: the rule-facing map plus the
 * headers the crawler keeps for detection (pub#871), which a crawl reusing an
 * unchanged page refreshes.
 */
export function buildTechHeadersMap(page: PageRecord): Record<string, string> {
  return overlayTechHeaders(buildHeadersMap(page), page.headers.techHeaders);
}

export function buildHeadersMap(page: PageRecord): Record<string, string> {
  const headers: Record<string, string> = {};
  if (page.headers.contentType) {
    // The stored media type plus the charset parameter it was sent with
    // (pub#674); a record without one reads as before.
    const charset = page.headers.contentTypeCharset;
    headers["content-type"] = charset
      ? `${page.headers.contentType}; charset=${charset}`
      : page.headers.contentType;
  }
  if (page.headers.contentEncoding) headers["content-encoding"] = page.headers.contentEncoding;
  if (page.headers.cacheControl) headers["cache-control"] = page.headers.cacheControl;
  if (page.headers.expires) headers["expires"] = page.headers.expires;
  if (page.headers.vary) headers["vary"] = page.headers.vary;
  if (page.headers.etag) headers["etag"] = page.headers.etag;
  if (page.headers.lastModified) headers["last-modified"] = page.headers.lastModified;
  if (page.headers.server) headers["server"] = page.headers.server;
  // New headers for SEO/performance rules
  if (page.headers.link) headers["link"] = page.headers.link;
  if (page.headers.serverTiming) headers["server-timing"] = page.headers.serverTiming;
  if (page.headers.age) headers["age"] = page.headers.age;
  if (page.headers.xCache) headers["x-cache"] = page.headers.xCache;
  if (page.headers.cfCacheStatus) headers["cf-cache-status"] = page.headers.cfCacheStatus;
  if (page.headers.xVercelCache) headers["x-vercel-cache"] = page.headers.xVercelCache;
  if (page.headers.altSvc) headers["alt-svc"] = page.headers.altSvc;
  if (page.headers.acceptRanges) headers["accept-ranges"] = page.headers.acceptRanges;
  // Version-revealing headers (security/version-disclosure, #713).
  if (page.headers.xPoweredBy) headers["x-powered-by"] = page.headers.xPoweredBy;
  if (page.headers.xAspNetVersion) headers["x-aspnet-version"] = page.headers.xAspNetVersion;
  if (page.headers.xAspNetMvcVersion)
    headers["x-aspnetmvc-version"] = page.headers.xAspNetMvcVersion;
  if (page.headers.xGenerator) headers["x-generator"] = page.headers.xGenerator;
  // Set-Cookie — security/cookie-flags rule (#748).
  if (page.headers.setCookie) headers["set-cookie"] = page.headers.setCookie;
  // Security headers
  if (page.securityHeaders.hsts) headers["strict-transport-security"] = page.securityHeaders.hsts;
  if (page.securityHeaders.csp) headers["content-security-policy"] = page.securityHeaders.csp;
  if (page.securityHeaders.xFrameOptions)
    headers["x-frame-options"] = page.securityHeaders.xFrameOptions;
  if (page.securityHeaders.xContentTypeOptions)
    headers["x-content-type-options"] = page.securityHeaders.xContentTypeOptions;
  if (page.securityHeaders.referrerPolicy)
    headers["referrer-policy"] = page.securityHeaders.referrerPolicy;
  if (page.securityHeaders.permissionsPolicy)
    headers["permissions-policy"] = page.securityHeaders.permissionsPolicy;
  if (page.securityHeaders.xRobotsTag) headers["x-robots-tag"] = page.securityHeaders.xRobotsTag;
  return headers;
}

// The page-universe content-type gate — shared with page-features.ts's
// `isAuditablePage` so the extraction universe can't drift from `site.pages`.
export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}

/** Whether an empty successful response is allowed to carry a document body. */
export function isAuditableEmptyBodyStatus(status: number): boolean {
  return status >= 200 && status < 300 && status !== 204 && status !== 205;
}

/** A captured body, including an empty one when its status permits content. */
export function hasAuditableHtmlBody(
  page: Pick<PageRecord, "html" | "status">,
): page is Pick<PageRecord, "status"> & { html: string } {
  return page.html !== null && (page.html.length > 0 || isAuditableEmptyBodyStatus(page.status));
}
