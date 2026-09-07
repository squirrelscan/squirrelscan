// Builds the blocklist-check site payload (urls + selectors) from crawl
// artifacts. Pure CLI-shape adaptation — the credit-gated call itself is
// dispatched by the cloud prefetch phase (@squirrelscan/audit-engine).

import { detachFromPage } from "@squirrelscan/audit-engine";

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
  absorbUrls(urls, siteContext);
  return [...urls];
}

/**
 * {@link collectUrls}' body accumulating into a caller-owned set, so the
 * streamed pre-rules walk can feed it one page batch at a time (#1913). The
 * MAX_URLS cap is a set-size test, so stopping at a batch boundary and resuming
 * on the next visits exactly the sequence one whole-array pass would.
 *
 * Every url added is a slice of the page's html, and a retained slice pins that
 * page's whole backing store (#240) — invisible in `heapUsed`, visible in
 * `external`. In the resident path the page was live anyway; on the streamed
 * path the batch is dropped right after this returns, so each kept url is
 * detached from it.
 */
export function absorbUrls(
  urls: Set<string>,
  siteContext: SiteContextPage[]
): void {
  for (const { page, parsed } of siteContext) {
    if (!parsed || page.status < 200 || page.status >= 300) continue;
    const pageHost = getHostname(page.url);

    for (const link of parsed.links) {
      if (urls.size >= MAX_URLS) return;
      if (!link.isInternal && isHttpUrl(link.url))
        urls.add(detachFromPage(link.url, "cloud-payload"));
    }

    for (const image of parsed.images) {
      if (urls.size >= MAX_URLS) return;
      if (isHttpUrl(image.src) && getHostname(image.src) !== pageHost)
        urls.add(detachFromPage(image.src, "cloud-payload"));
    }

    // ParsedPage carries no script list — pull external script srcs (the most
    // common tracker vector) straight from the pre-parsed document.
    const doc = parsed.document;
    if (!doc) continue;
    for (const script of doc.querySelectorAll("script[src]")) {
      if (urls.size >= MAX_URLS) return;
      const src = script.getAttribute("src");
      if (src && isHttpUrl(src) && getHostname(src) !== pageHost)
        urls.add(detachFromPage(src, "cloud-payload"));
    }
  }
}

/** Collect simple `.class` / `#id` selectors present on the first pages. */
function collectSelectors(siteContext: SiteContextPage[]): string[] {
  const state = createSelectorState();
  absorbSelectors(state, siteContext);
  return [...state.selectors];
}

export interface SelectorState {
  selectors: Set<string>;
  pagesScanned: number;
}

export function createSelectorState(): SelectorState {
  return { selectors: new Set<string>(), pagesScanned: 0 };
}

/**
 * {@link collectSelectors}' body over caller-owned state, so the
 * MAX_SELECTOR_PAGES scan budget spans batches instead of resetting on each
 * one (#1913). Selector tokens are `id`/`class` attribute slices, detached for
 * the same reason as the urls above.
 */
export function absorbSelectors(
  state: SelectorState,
  siteContext: SiteContextPage[]
): void {
  const { selectors } = state;
  for (const { page, parsed } of siteContext) {
    if (
      selectors.size >= MAX_SELECTORS ||
      state.pagesScanned >= MAX_SELECTOR_PAGES
    )
      return;
    if (!parsed?.document || page.status < 200 || page.status >= 300) continue;
    state.pagesScanned++;

    let elements: Iterable<Element>;
    try {
      elements = parsed.document.querySelectorAll("[class], [id]");
    } catch {
      continue; // linkedom limitation — skip this page
    }

    for (const el of elements) {
      if (selectors.size >= MAX_SELECTORS) break;
      const id = el.getAttribute("id");
      if (id && SIMPLE_TOKEN_RE.test(id))
        selectors.add(detachFromPage(`#${id}`, "cloud-payload"));
      const classAttr = el.getAttribute("class");
      if (!classAttr) continue;
      for (const cls of classAttr.split(/\s+/)) {
        if (selectors.size >= MAX_SELECTORS) break;
        if (cls && SIMPLE_TOKEN_RE.test(cls))
          selectors.add(detachFromPage(`.${cls}`, "cloud-payload"));
      }
    }
  }
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
