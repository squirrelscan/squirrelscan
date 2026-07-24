import { parsePage, type ParsedPageCache } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageRecord } from "../../src/crawler/storage/types";

import { buildSiteContext } from "../../src/audit/adapter";

const HTML = `<!doctype html><html><head><title>Reuse Me</title>
<meta name="description" content="hi"></head>
<body><h1>Heading</h1><a href="/next">next</a></body></html>`;

// Build a PageRecord the way the crawler does: parsedData = the parsed page
// minus its (non-serializable) document.
function createPage(url: string, html: string): PageRecord {
  const parsed = parsePage(html, url);
  const { document: _doc, ...serializable } = parsed;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 1,
    fetchedAt: 0,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html,
    parsedData: JSON.stringify(serializable),
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      expires: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  };
}

describe("buildSiteContext DOM reuse (#267)", () => {
  test("reuses the cached crawl-time document instead of re-parsing", () => {
    const url = "https://example.com/";
    const page = createPage(url, HTML);
    const cached = parsePage(HTML, url);
    const cache: ParsedPageCache = new Map([[url, cached]]);

    const ctx = Effect.runSync(buildSiteContext([page], cache));
    // Same Document instance → no second linkedom parse.
    expect(ctx[0].parsed?.document).toBe(cached.document);
  });

  test("falls back to re-parse when no cache is supplied (behavior-preserving)", () => {
    const url = "https://example.com/";
    const page = createPage(url, HTML);

    const withoutCache = Effect.runSync(buildSiteContext([page]));
    const cached = parsePage(HTML, url);
    const withCache = Effect.runSync(
      buildSiteContext([page], new Map([[url, cached]]))
    );

    const a = withoutCache[0].parsed;
    const b = withCache[0].parsed;
    expect(a).not.toBeNull();
    // Re-parsed and reused DOMs yield identical extraction.
    expect(a?.document?.querySelector("title")?.textContent).toBe("Reuse Me");
    expect(b?.document?.querySelector("title")?.textContent).toBe("Reuse Me");
    expect(b?.meta).toEqual(a?.meta);
    expect(b?.headings).toEqual(a?.headings);
    expect(b?.links).toEqual(a?.links);
  });

  test("a cache miss for an unknown url still re-parses", () => {
    const url = "https://example.com/";
    const page = createPage(url, HTML);
    const cache: ParsedPageCache = new Map([
      ["https://other.example/", parsePage(HTML, "https://other.example/")],
    ]);

    const ctx = Effect.runSync(buildSiteContext([page], cache));
    expect(ctx[0].parsed?.document).not.toBeNull();
    expect(ctx[0].parsed?.document?.querySelector("h1")?.textContent).toBe(
      "Heading"
    );
  });

  test("a cached entry with a null document falls back to re-parse", () => {
    const url = "https://example.com/";
    const page = createPage(url, HTML);
    // error-page shape: cached ParsedPage carries no DOM
    const cache: ParsedPageCache = new Map([
      [url, { ...parsePage(HTML, url), document: null }],
    ]);

    const ctx = Effect.runSync(buildSiteContext([page], cache));
    expect(ctx[0].parsed?.document).not.toBeNull();
    expect(ctx[0].parsed?.document?.querySelector("title")?.textContent).toBe(
      "Reuse Me"
    );
  });
});
