// The rule cache key covers the browser events a render saw (#425): security/csp-violations reads them, so
// a page whose events changed must not replay the verdict of the old events. Dropping `page.browserEvents`
// from `computePageCacheKey` fails this file.

import { describe, expect, test } from "bun:test";

import type { BrowserEvents, PageRecord } from "@squirrelscan/core-contracts";

import { computePageCacheKey } from "../src/rule-cache";

const page = (browserEvents?: BrowserEvents | null): PageRecord =>
  ({
    url: "https://e.test/a",
    normalizedUrl: "https://e.test/a",
    finalUrl: "https://e.test/a",
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 1,
    htmlHash: "h1",
    contentHash: "c1",
    parsedData: null,
    headers: {},
    securityHeaders: {},
    fetcherId: "cloud-render",
    ...(browserEvents === undefined ? {} : { browserEvents }),
  }) as unknown as PageRecord;

const events = (blockedUri: string): BrowserEvents => ({
  cspViolations: [{ violatedDirective: "img-src", blockedUri, disposition: "enforce" }],
  failedRequests: [],
  listenedAfterLoad: true,
});

describe("computePageCacheKey and browser events", () => {
  test("a page with other events, or none, has another key; the same events have the same key", async () => {
    const a = await computePageCacheKey("ctx", page(events("https://a.test/x.png")), undefined);
    const b = await computePageCacheKey("ctx", page(events("https://b.test/x.png")), undefined);
    const none = await computePageCacheKey("ctx", page(), undefined);
    const again = await computePageCacheKey("ctx", page(events("https://a.test/x.png")), undefined);
    expect(a).not.toBeNull();
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
    expect(await computePageCacheKey("ctx", page(null), undefined)).toBe(none);
  });
});
