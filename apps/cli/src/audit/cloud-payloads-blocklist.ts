// Builds the blocklist-check site payload (urls + selectors) from crawl
// artifacts. Pure CLI-shape adaptation — the credit-gated call itself is
// dispatched by the cloud prefetch phase (@squirrelscan/audit-engine).

import type { SiteContextPage } from "@/audit/adapter";

import { getHostname } from "@/utils/url";

/** Server cap is 2000 combined; stay under it with room for both kinds. */
const MAX_URLS = 1_500;
const MAX_SELECTORS = 500;
/** Selector extraction walks the DOM — bound the per-audit cost. */
const MAX_SELECTOR_PAGES = 20;

const SIMPLE_TOKEN_RE = /^[A-Za-z][\w-]*$/;

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Collect external resource/link urls: anchors, images, script srcs. */
function collectUrls(siteContext: SiteContextPage[]): string[] {
  const urls = new Set<string>();

  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const pageHost = getHostname(page.url);

    for (const link of parsed.links) {
      if (urls.size >= MAX_URLS) return [...urls];
      if (!link.isInternal && isHttpUrl(link.url)) urls.add(link.url);
    }

    for (const image of parsed.images) {
      if (urls.size >= MAX_URLS) return [...urls];
      if (isHttpUrl(image.src) && getHostname(image.src) !== pageHost)
        urls.add(image.src);
    }

    // ParsedPage carries no script list — pull external script srcs (the most
    // common tracker vector) straight from the pre-parsed document.
    const doc = parsed.document;
    if (!doc) continue;
    for (const script of doc.querySelectorAll("script[src]")) {
      if (urls.size >= MAX_URLS) return [...urls];
      const src = script.getAttribute("src");
      if (src && isHttpUrl(src) && getHostname(src) !== pageHost) urls.add(src);
    }
  }

  return [...urls];
}

/** Collect simple `.class` / `#id` selectors present on the first pages. */
function collectSelectors(siteContext: SiteContextPage[]): string[] {
  const selectors = new Set<string>();
  let pagesScanned = 0;

  for (const { page, parsed } of siteContext) {
    if (selectors.size >= MAX_SELECTORS || pagesScanned >= MAX_SELECTOR_PAGES)
      break;
    if (!parsed?.document || page.status < 200 || page.status >= 300) continue;
    pagesScanned++;

    let elements: Iterable<Element>;
    try {
      elements = parsed.document.querySelectorAll("[class], [id]");
    } catch {
      continue; // linkedom limitation — skip this page
    }

    for (const el of elements) {
      if (selectors.size >= MAX_SELECTORS) break;
      const id = el.getAttribute("id");
      if (id && SIMPLE_TOKEN_RE.test(id)) selectors.add(`#${id}`);
      const classAttr = el.getAttribute("class");
      if (!classAttr) continue;
      for (const cls of classAttr.split(/\s+/)) {
        if (selectors.size >= MAX_SELECTORS) break;
        if (cls && SIMPLE_TOKEN_RE.test(cls)) selectors.add(`.${cls}`);
      }
    }
  }

  return [...selectors];
}

/**
 * Build the `blocklist-check` site payload from parsed crawl pages.
 * Returns null when there is nothing to check (prefetch then skips the
 * service as `not-prefetched` without charging).
 */
export function buildBlocklistPayload(
  siteContext: SiteContextPage[]
): { urls: string[]; selectors: string[] } | null {
  const urls = collectUrls(siteContext);
  const selectors = collectSelectors(siteContext);
  if (urls.length === 0 && selectors.length === 0) return null;
  return { urls, selectors };
}
