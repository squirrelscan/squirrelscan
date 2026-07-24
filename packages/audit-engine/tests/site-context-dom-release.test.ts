// #858 — DOM working-set controls. The audit releases parsed DOMs during
// long DOM-free stretches (cloud prefetch waits, report/publish tail) and
// re-materializes them for the rules phase. These tests pin the contract:
// release nulls every document without touching extracted data, ensure
// rebuilds an equivalent DOM, and ensure is an idempotent no-op on entries
// that still hold their document.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import {
  buildSiteContext,
  ensureSiteContextDocuments,
  releaseSiteContextDocuments,
} from "../src/adapter";

function page(url: string, html: string | null): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html?.length ?? 0,
    loadTimeMs: 10,
    fetchedAt: 0,
    etag: null,
    lastModified: null,
    contentHash: "hash",
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
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

const HTML =
  '<!doctype html><html lang="en"><head><title>T</title><meta name="description" content="D"></head>' +
  '<body><h1>Heading</h1><p>hello <a href="https://other.example/x">out</a></p></body></html>';

describe("site-context DOM release/ensure (#858)", () => {
  test("release nulls every document but keeps extracted data", async () => {
    const ctx = await Effect.runPromise(buildSiteContext([page("https://example.com/", HTML)]));
    expect(ctx[0]!.parsed?.document).not.toBeNull();
    const titleBefore = ctx[0]!.parsed!.meta.title;

    releaseSiteContextDocuments(ctx);

    expect(ctx[0]!.parsed!.document).toBeNull();
    expect(ctx[0]!.parsed!.meta.title).toBe(titleBefore);
    expect(ctx[0]!.parsed!.links.length).toBeGreaterThan(0);
  });

  test("ensure re-materializes an equivalent DOM after release", async () => {
    const ctx = await Effect.runPromise(buildSiteContext([page("https://example.com/", HTML)]));
    const serializedBefore = String(ctx[0]!.parsed!.document);

    releaseSiteContextDocuments(ctx);
    ensureSiteContextDocuments(ctx);

    const doc = ctx[0]!.parsed!.document;
    expect(doc).not.toBeNull();
    expect(String(doc)).toBe(serializedBefore);
    expect(doc!.querySelector("h1")?.textContent).toBe("Heading");
  });

  test("ensure is a no-op when documents are still present", async () => {
    const ctx = await Effect.runPromise(buildSiteContext([page("https://example.com/", HTML)]));
    const instanceBefore = ctx[0]!.parsed!.document;

    ensureSiteContextDocuments(ctx);

    expect(ctx[0]!.parsed!.document).toBe(instanceBefore);
  });

  test("entries without html or parsed data survive both calls", async () => {
    const ctx = await Effect.runPromise(
      buildSiteContext([
        page("https://example.com/", HTML),
        { ...page("https://example.com/broken", null), contentType: "text/html" },
        { ...page("https://example.com/bin.pdf", null), contentType: "application/pdf" },
      ]),
    );

    releaseSiteContextDocuments(ctx);
    ensureSiteContextDocuments(ctx);

    expect(ctx[0]!.parsed!.document).not.toBeNull();
    expect(ctx[1]!.parsed).toBeNull();
    expect(ctx[2]!.parsed).toBeNull();
  });
});
