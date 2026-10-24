// #2307: the report's page structure block comes from the per-page structure the rules phase
// stored with the page's other report scalars, and from nothing else: building the report reads
// no page body for it.
//
// Pinned here: the block a real parse produces (landmark markup, hand-counted), that a page
// which answered with an error does not count, that a stored row from before the block existed
// adds nothing, and that a crawl with no section data anywhere carries no block at all.

import type { PageRecord } from "@squirrelscan/core-contracts";

import { extractPageFeatures } from "@squirrelscan/audit-engine";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parsePageRecord } from "@/audit/adapter";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(eff));
}

function page(path: string, html: string, status = 200): PageRecord {
  const url = `${SITE}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: path,
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

// Home: two header links, one navigation, one in <main>, one sidebar, one loose, a footer pair
// (one of them external). Internal chrome links: 2 + 1 + 1 + 1 = 5; internal content links: 1.
const HOME = `<html><head><title>Home</title></head><body>
<header><a href="/">Home</a><a href="/shop">Shop</a></header>
<nav><a href="/about">About</a></nav>
<main><p>text <a href="/p/1">product</a></p></main>
<aside><a href="/blog">Blog</a></aside>
<p><a href="/loose">loose</a></p>
<footer><a href="/legal">Legal</a><a href="https://other.example/x">ext</a></footer>
</body></html>`;

// About: one header link and one footer link, both internal chrome.
const ABOUT = `<html><head><title>About</title></head><body>
<header><a href="/">Home</a></header><p>About us</p>
<footer><a href="/legal">Legal</a></footer></body></html>`;

interface Spec {
  path: string;
  html: string;
  status?: number;
  /** The classifier's answer to attach to the parse, as the classifier hook would. */
  classified?: { label: string; confidence: number; source: "model" | "rules" };
  /** Store the row as an earlier binary did: no structure in the scalars. */
  stripStructure?: boolean;
}

const SPECS: Spec[] = [
  {
    path: "/",
    html: HOME,
    classified: { label: "homepage", confidence: 0.97, source: "model" },
  },
  { path: "/about", html: ABOUT },
  // A 404 page carries the site's chrome too; it must not count.
  { path: "/missing", html: ABOUT, status: 404 },
];

async function storedAudit(specs: Spec[]) {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const crawlId = await run(
    store.createCrawl({
      baseUrl: SITE,
      seedUrl: SITE,
      originalUrl: SITE,
      startedAt: 1,
      status: "analyzed",
      config: {} as never,
      stats: {
        pagesTotal: specs.length,
        pagesFetched: specs.length,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      },
    })
  );
  for (const spec of specs) {
    const record = page(spec.path, spec.html, spec.status);
    await run(store.upsertPage(crawlId, record));
    const parsed = parsePageRecord(record)!;
    if (spec.classified) {
      parsed.classification = { pageType: spec.classified, degraded: "" };
    }
    const row = extractPageFeatures(record, parsed);
    if (spec.stripStructure && row.reportScalars) {
      const { structure: _dropped, ...rest } = row.reportScalars;
      row.reportScalars = rest;
    }
    await run(store.upsertPageFeatures(crawlId, row));
  }
  return { store, crawlId };
}

async function report(specs: Spec[]) {
  const { store, crawlId } = await storedAudit(specs);
  const built = await run(reconstructReport(store, crawlId, undefined));
  await run(store.close());
  return built;
}

describe("reconstructReport page structure (#2307)", () => {
  test("the extractor stores each page's structure beside its other report scalars", async () => {
    const record = page("/", HOME);
    const parsed = parsePageRecord(record)!;
    parsed.classification = {
      pageType: { label: "homepage", confidence: 0.97, source: "model" },
      degraded: "",
    };

    expect(
      extractPageFeatures(record, parsed).reportScalars?.structure
    ).toEqual({
      sections: {
        header: 2,
        navigation: 1,
        content: 1,
        sidebar: 1,
        unknown: 1,
        footer: 2,
      },
      chromeInternal: 5,
      contentInternal: 1,
      pageType: { label: "homepage", confidence: 0.97, source: "model" },
      degraded: false,
    });
  });

  test("the block adds up the pages that answered, and only those", async () => {
    const built = await report(SPECS);

    expect(built.structure).toEqual({
      pages: 2,
      sections: [
        { section: "header", pages: 2, links: 3 },
        { section: "footer", pages: 2, links: 3 },
        { section: "navigation", pages: 1, links: 1 },
        { section: "sidebar", pages: 1, links: 1 },
        { section: "content", pages: 1, links: 1 },
      ],
      unknownLinks: 1,
      totalLinks: 10,
      chrome: { links: 7, contentLinks: 1, share: 0.875 },
      pageTypes: {
        counts: [{ label: "homepage", pages: 1 }],
        notClassified: 1,
        byModel: 1,
        degraded: 0,
      },
    });
  });

  test("a stored row from before the block existed adds nothing", async () => {
    const built = await report([
      SPECS[0]!,
      { ...SPECS[1]!, stripStructure: true },
    ]);

    // Only the homepage contributes: one page, no about-page links.
    expect(built.structure?.pages).toBe(1);
    expect(built.structure?.totalLinks).toBe(8);
  });

  test("a failed features read leaves the block out rather than printing it short", async () => {
    const { store, crawlId } = await storedAudit(SPECS);
    store.getPageFeaturesPage = () =>
      Effect.fail(new Error("features read failed")) as never;
    const built = await run(reconstructReport(store, crawlId, undefined));
    await run(store.close());

    expect(built.structure).toBeUndefined();
    // The rest of the report still builds, from the fallback parse.
    expect(built.pages).toHaveLength(3);
  });

  test("a crawl with no section data anywhere has no block", async () => {
    const built = await report(
      SPECS.map((spec) => ({ ...spec, stripStructure: true }))
    );

    expect(built.structure).toBeUndefined();
    expect("structure" in built).toBe(false);
  });
});
