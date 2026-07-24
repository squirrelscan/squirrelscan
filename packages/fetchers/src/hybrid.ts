// HTTP-first hybrid DocumentFetcher (#294).
//
// Most pages are server-rendered, so plain HTTP already has the real DOM. This
// fetcher fetches every page via HTTP first and re-renders ONLY pages detected
// as client-side-rendered shells (see csr-detect.ts). Static/SSR sites pay zero
// render credits and run at HTTP speed; SPA pages still get a real rendered
// DOM. A failed render upgrade falls back to the HTTP response so a page is
// never lost.

import { looksClientRendered } from "./csr-detect";
import type { DocumentFetcher, FetchRequest, FetchResponse } from "./index";

export interface HybridFetcherOptions {
  /** Plain-HTTP fetcher — tried for every page first. */
  http: DocumentFetcher;
  /** Render fetcher (cloud) — used only to upgrade CSR-shell pages. */
  render: DocumentFetcher;
  /**
   * Override the upgrade decision. Default: non-error HTML responses that
   * `looksClientRendered`. Exposed for tests.
   */
  shouldUpgrade?: (resp: FetchResponse) => boolean;
  /** Called with the url each time a page is upgraded to a render. */
  onUpgrade?: (url: string) => void;
}

function isHtml(resp: FetchResponse): boolean {
  const ct = resp.headers["content-type"] ?? resp.headers["Content-Type"] ?? "";
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

export function defaultShouldUpgrade(resp: FetchResponse): boolean {
  return resp.status < 400 && isHtml(resp) && looksClientRendered(resp.body);
}

export function createHybridDocumentFetcher(opts: HybridFetcherOptions): DocumentFetcher {
  const shouldUpgrade = opts.shouldUpgrade ?? defaultShouldUpgrade;

  return {
    id: "hybrid-http-first",
    // Advertises render capability — it CAN upgrade pages to a real DOM.
    capabilities: { jsRendering: true, cookies: false, screenshot: false },
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      const httpResp = await opts.http.fetch(req);

      // Don't upgrade if the crawl was interrupted or the page isn't a shell.
      if (req.signal?.aborted || !shouldUpgrade(httpResp)) {
        return httpResp;
      }

      opts.onUpgrade?.(req.url);
      try {
        return await opts.render.fetch(req);
      } catch (err) {
        // If the crawl was interrupted mid-upgrade (per-URL watchdog / stop),
        // propagate so the fiber unwinds promptly — don't mask the abort by
        // returning a value. Otherwise the render upgrade just failed: keep the
        // HTTP result rather than lose the page.
        if (req.signal?.aborted) throw err;
        return httpResp;
      }
    },
  };
}
