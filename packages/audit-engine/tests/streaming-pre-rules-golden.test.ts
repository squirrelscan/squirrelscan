// GOLDEN INVARIANT (#1860): the streamed pre-rules phase collects EXACTLY what
// the resident whole-crawl pass collected.
//
// `runStreamingPreRules` exists to stop a cloud audit holding every page's
// linkedom DOM live between the crawl and the rules phase (#1862: 500 pages of
// ~1 MB HTML = 2.2 GB of DOM, OOM). It gets there by feeding each collector one
// page batch at a time instead of one whole-crawl array. Batching is only safe if
// every collector's caps, dedupe sets and early-exits carry ACROSS batches — a
// cap that reset per batch, or a "first N pages" sample taken per batch, would
// silently change what the cloud sends to the paid prefetch services.
//
// So each test below runs one collector twice over the same crawl — once with the
// whole site context, once batch by batch — and asserts the outputs are equal;
// the prefetch collector is additionally compared against the pre-existing
// whole-array builders it now delegates from, which is what pins it to the shape
// the cloud has always sent.
//
// The end-to-end test uses a hand-built crawl with no sitemap and no sub-resource
// markup, so `fetchAssetsFromOccurrences` has nothing to fetch and the whole file
// stays hermetic (no network).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { PageRecord, ResponseHeaders, SecurityHeaders } from "@squirrelscan/core-contracts";
import type { SQLiteStorage } from "@squirrelscan/crawler";
import { SQLiteStorage as SQLiteStorageImpl } from "@squirrelscan/crawler";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import {
  absorbExternalLinkOccurrences,
  buildSiteContext,
  createSiteAssetCollector,
  releaseSiteContextDocuments,
  renderedPageUrlsFrom,
  runStreamingRules,
  type PreFetchedAssets,
  type ExternalLinkOccurrences,
  type SiteAssetOccurrences,
  type SiteContextPage,
} from "../src/adapter";
import {
  buildBlocklistPayload,
  buildCloudPagePayloads,
  buildGapsPayloads,
  buildMetadataPayload,
  createCloudPrefetchCollector,
} from "../src/cloud-prefetch-run";
import { collectIntelUrls } from "../src/intel";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CONFIG = {
  rule_options: {},
  rules: { enable: ["*"] },
  cloud: {},
  crawler: {},
  external_links: { enabled: false, concurrency: 1, timeout_ms: 1000, cache_ttl_days: 1 },
} as unknown as Config;

const SITE_URL = "http://synthetic.test";

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

/** Minimal non-null crawl stats — the crawls table requires the column. */
const CRAWL_STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

/** Occurrence maps compare as sorted plain arrays — Map/Set don't deep-equal usefully. */
function assetShape(occ: SiteAssetOccurrences) {
  const flat = (m: Map<string, Set<string>>) =>
    [...m.entries()].map(([k, v]) => [k, [...v].sort()] as const).sort();
  return {
    css: flat(occ.css),
    images: flat(occ.images),
    scripts: flat(occ.scripts),
    pdfs: flat(occ.pdfs),
    coveragePages: occ.coveragePages,
    pageCount: occ.pageCount,
  };
}

function linkShape(occ: ExternalLinkOccurrences) {
  return [...occ.entries()].map(([href, list]) => [href, list] as const).sort();
}

/** Read the crawl's pages in `size` chunks, parsed, as the streamed pass does. */
async function batches(
  storage: SQLiteStorage,
  crawlId: string,
  size: number,
): Promise<SiteContextPage[][]> {
  const out: SiteContextPage[][] = [];
  for (let offset = 0; ; offset += size) {
    const batch = await run(storage.getPages(crawlId, { limit: size, offset }));
    if (batch.length === 0) break;
    out.push(await run(buildSiteContext(batch)));
    if (batch.length < size) break;
  }
  return out;
}

async function residentContext(
  storage: SQLiteStorage,
  crawlId: string,
): Promise<SiteContextPage[]> {
  return run(buildSiteContext(await run(storage.getPages(crawlId))));
}

const T = 30_000;

describe("streamed pre-rules collectors — batched === resident (#1860)", () => {
  test("asset occurrences are identical whether absorbed whole or in batches", async () => {
    const model = generateSiteModel({ seed: 11, pageCount: 60 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");
    await injectRichPages(storage, crawlId, 12);

    const resident = createSiteAssetCollector(SITE_URL);
    resident.absorb(await residentContext(storage, crawlId));

    const streamed = createSiteAssetCollector(SITE_URL);
    for (const batch of await batches(storage, crawlId, 7)) {
      streamed.absorb(batch);
      releaseSiteContextDocuments(batch);
    }

    expect(assetShape(streamed.occurrences)).toEqual(assetShape(resident.occurrences));
    // Guard against a vacuous pass: EVERY map the collector fills must be
    // non-empty, or "batched === resident" would just be "empty === empty".
    // The synthetic model renders no sub-resource markup at all, which is why
    // injectRichPages exists.
    expect(resident.occurrences.css.size).toBeGreaterThan(0);
    expect(resident.occurrences.images.size).toBeGreaterThan(0);
    expect(resident.occurrences.scripts.size).toBeGreaterThan(0);
    expect(resident.occurrences.pdfs.size).toBeGreaterThan(0);
    expect(resident.occurrences.coveragePages.length).toBeGreaterThan(0);
    // pageCount counts EVERY stored page (the model's redirect hops included),
    // matching v1's siteContext.length.
    expect(resident.occurrences.pageCount).toBe(
      (await run(storage.getPages(crawlId))).length,
    );

    await run(storage.close());
  }, T);

  test("external-link occurrences are identical whether absorbed whole or in batches", async () => {
    const model = generateSiteModel({ seed: 13, pageCount: 60 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");
    await injectRichPages(storage, crawlId, 12);

    const resident: ExternalLinkOccurrences = new Map();
    absorbExternalLinkOccurrences(resident, await residentContext(storage, crawlId));

    const streamed: ExternalLinkOccurrences = new Map();
    for (const batch of await batches(storage, crawlId, 7)) {
      absorbExternalLinkOccurrences(streamed, batch);
      releaseSiteContextDocuments(batch);
    }

    expect(linkShape(streamed)).toEqual(linkShape(resident));
    // Non-vacuity: the injected pages carry external anchors, and each shared
    // href must accumulate an appearance per page (the part batching could drop).
    expect(resident.size).toBeGreaterThan(0);
    expect(resident.get(SHARED_EXTERNAL_HREF)?.length).toBe(12);

    await run(storage.close());
  }, T);

  test("cloud-prefetch payloads match the whole-array builders, batched or not", async () => {
    const model = generateSiteModel({ seed: 17, pageCount: 60 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");
    // Blocklist URLs come from off-host links, images and script srcs; the
    // synthetic model renders none, so without these the blocklist comparison
    // would be null === null.
    await injectRichPages(storage, crawlId, 12);

    // The legacy whole-array builders, over a fully resident context — the shape
    // the cloud has always sent to /v1/services/*.
    const ctx = await residentContext(storage, crawlId);
    const legacy = {
      pages: buildCloudPagePayloads(ctx),
      metadataPages: buildMetadataPayload(ctx, SITE_URL),
      blocklist: buildBlocklistPayload(ctx),
      gaps: buildGapsPayloads(ctx, SITE_URL, CONFIG),
      rendered: [...renderedPageUrlsFrom(ctx)],
    };

    const streamed = createCloudPrefetchCollector(SITE_URL);
    for (const batch of await batches(storage, crawlId, 7)) {
      streamed.absorb(batch);
      releaseSiteContextDocuments(batch);
    }
    const built = streamed.build();

    expect(built.pages).toEqual(legacy.pages);
    expect(built.metadataPages).toEqual(legacy.metadataPages);
    expect(built.blocklist).toEqual(legacy.blocklist);
    expect([...built.renderedPageUrls]).toEqual(legacy.rendered);
    // Seeds reach the wire through buildGapsPayloadsFromSeeds; compare the
    // assembled payload rather than the intermediate list.
    expect(
      built.gapsSeeds.length > 0
        ? {
            "keyword-gaps": {
              ...(legacy.gaps["keyword-gaps"] ?? {}),
              seedKeywords: built.gapsSeeds,
            },
          }
        : {},
    ).toEqual(
      legacy.gaps["keyword-gaps"] ? { "keyword-gaps": legacy.gaps["keyword-gaps"] } : {},
    );

    // Vacuity guards: the sample and the blocklist must be non-trivial, and the
    // metadata sample must be the CAPPED sample rather than every page — that cap
    // is exactly what the batched collector could have got wrong.
    expect(built.pages.length).toBeGreaterThan(0);
    expect(built.metadataPages.length).toBeGreaterThan(0);
    expect(built.metadataPages.length).toBeLessThan(built.pages.length);
    expect(built.blocklist?.urls.length).toBeGreaterThan(0);
    expect(built.blocklist?.selectors.length ?? 0).toBeGreaterThanOrEqual(0);
    expect(built.gapsSeeds.length).toBeGreaterThan(0);
    expect(built.renderedPageUrls.size).toBe(0);

    await run(storage.close());
  }, T);

  test("metadata sample still picks the homepage when it sorts past the retained prefix", async () => {
    // `getPages` orders by normalized_url, so a homepage at "/" sorts FIRST and
    // the interesting case (home beyond the first metadataMaxPages usable pages)
    // never arises from a natural crawl. Force it: give every page a path that
    // sorts before the home URL, so home lands last.
    const storage = new SQLiteStorageImpl(":memory:");
    await run(storage.init());
    const crawlId = await run(
      storage.createCrawl({
        baseUrl: SITE_URL,
        seedUrl: SITE_URL,
        originalUrl: SITE_URL,
        startedAt: Date.now(),
        status: "running",
        config: {},
        stats: CRAWL_STATS,
      } as never),
    );

    const paths = ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", ""];
    for (const path of paths) {
      await run(storage.upsertPage(crawlId, htmlPage(`${SITE_URL}${path}`, path || "home")));
    }

    const ctx = await residentContext(storage, crawlId);
    const legacy = buildMetadataPayload(ctx, SITE_URL);

    const streamed = createCloudPrefetchCollector(SITE_URL);
    for (const batch of await batches(storage, crawlId, 3)) {
      streamed.absorb(batch);
      releaseSiteContextDocuments(batch);
    }

    expect(streamed.build().metadataPages).toEqual(legacy);
    // The point of the fixture: home really is last in crawl order, and really is
    // the sample's first entry.
    expect(legacy[0]?.url).toBe(SITE_URL);

    await run(storage.close());
  }, T);
});

describe("runStreamingPreRules end to end (#1860)", () => {
  test("reports v1's pages[0], intel URL order and page count", async () => {
    // Hand-built: no sitemap and no sub-resource markup, so the asset phase has
    // nothing to fetch and the test never touches the network.
    const storage = new SQLiteStorageImpl(":memory:");
    await run(storage.init());
    const crawlId = await run(
      storage.createCrawl({
        baseUrl: SITE_URL,
        seedUrl: SITE_URL,
        originalUrl: SITE_URL,
        startedAt: Date.now(),
        status: "running",
        config: {},
        stats: CRAWL_STATS,
      } as never),
    );
    for (const path of ["/c", "/a", "/b"]) {
      await run(storage.upsertPage(crawlId, htmlPage(`${SITE_URL}${path}`, path)));
    }

    const result = await run(
      runStreamingPreRules(storage, crawlId, CONFIG, {
        batchSize: 2,
        cloudPrefetchSiteUrl: SITE_URL,
        intelBaseUrl: SITE_URL,
      }),
    );

    expect(result.pageCount).toBe(3);
    // normalized_url ASC ⇒ "/a" is v1's pages[0], not the insertion-order "/c".
    expect(result.techDetectPage?.url).toBe(`${SITE_URL}/a`);
    // Base URL first, then each page's url + finalUrl in crawl order — the exact
    // order collectIntelUrls produces.
    const ctx = await residentContext(storage, crawlId);
    expect(result.intelUrls).toEqual(collectIntelUrls(ctx, SITE_URL));
    // Nothing to fetch, so the asset phase is empty and undegraded.
    expect(result.assets.resourceSizes.css).toEqual([]);
    expect(result.assets.scripts).toEqual([]);
    expect(result.assets.degradation).toBeUndefined();
    // External links off ⇒ no results, exactly as v1 returns.
    expect(result.externalLinkResults).toEqual([]);
    expect(result.cloudPrefetchPayloads?.pages.length).toBe(3);

    await run(storage.close());
  }, T);

  test("collects no prefetch payloads when no site URL is given", async () => {
    const storage = new SQLiteStorageImpl(":memory:");
    await run(storage.init());
    const crawlId = await run(
      storage.createCrawl({
        baseUrl: SITE_URL,
        seedUrl: SITE_URL,
        originalUrl: SITE_URL,
        startedAt: Date.now(),
        status: "running",
        config: {},
        stats: CRAWL_STATS,
      } as never),
    );
    await run(storage.upsertPage(crawlId, htmlPage(`${SITE_URL}/a`, "a")));

    const result = await run(runStreamingPreRules(storage, crawlId, CONFIG, { batchSize: 2 }));
    expect(result.cloudPrefetchPayloads).toBeNull();

    await run(storage.close());
  }, T);
});

const EMPTY_HEADERS: ResponseHeaders = {
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
};

const EMPTY_SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

const SHARED_EXTERNAL_HREF = "https://external.example/shared";

/**
 * Pages that actually carry the markup the asset + external-link collectors read.
 * The synthetic generator renders none of it (no `img`, `script` or stylesheet
 * `link`, and only internal anchors), so without these the parity assertions
 * would compare two empty maps. Each page gets its own stylesheet, script, image
 * and same-origin PDF link plus a per-page and a SHARED external anchor, so the
 * occurrence maps exercise both distinct keys and multi-page accumulation.
 */
async function injectRichPages(
  storage: SQLiteStorage,
  crawlId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const url = `${SITE_URL}/rich/${String(i).padStart(3, "0")}`;
    const html =
      `<!doctype html><html lang="en"><head><title>rich ${i}</title>` +
      `<link rel="stylesheet" href="${SITE_URL}/assets/site-${i % 3}.css">` +
      `<script src="${SITE_URL}/assets/app-${i % 4}.js"></script>` +
      `</head><body><h1>rich ${i}</h1>` +
      `<img src="${SITE_URL}/img/hero-${i % 5}.png" alt="hero ${i}">` +
      `<a href="${SITE_URL}/docs/manual-${i % 2}.pdf">manual</a>` +
      `<a href="https://external.example/page-${i}">out ${i}</a>` +
      `<a href="${SHARED_EXTERNAL_HREF}">shared</a>` +
      `</body></html>`;
    await run(storage.upsertPage(crawlId, { ...htmlPage(url, `rich ${i}`), html }));
  }
}

/** A minimal 200 HTML page with no sub-resources of any kind. */
function htmlPage(url: string, title: string): PageRecord {
  const html = `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} page"></head><body><h1>${title}</h1><p>Body copy for ${title}.</p></body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: Buffer.byteLength(html, "utf8"),
    loadTimeMs: 1,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "test",
    html,
    parsedData: null,
    headers: EMPTY_HEADERS,
    securityHeaders: EMPTY_SECURITY_HEADERS,
  };
}

// #1860 P0: the streamed universe must stay O(1) per page in the fields it
// retains, not just DOM-free. A 5,000-10,000 page audit is the target, and the
// retained ParsedPage set is the structure that decides whether that fits.
//
// `content.textContent` is the whole page's extracted text and was 97% of the
// retained universe (39.1 KB of 40.5 KB per page on a 509-page crawl of ~1 MB
// pages). Nothing that reads this universe wants it: site rules take text from
// `ctx.collectedSignals` or their own DOM walk, the four rules reading
// `content.textContent` read it off `ctx.parsed` (the page context, re-parsed
// fresh per batch), and the report reads only meta/og/twitter/schema/h1 and the
// `isThinContent` flag. So it is dropped — and this test is what stops it
// silently coming back, or a future site rule quietly depending on it.
describe("streamed universe retention (#1860)", () => {
  test("the retained universe carries no page text and no live documents", async () => {
    const model = generateSiteModel({ seed: 23, pageCount: 40 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");

    const result = await run(
      runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, { batchSize: 7 }),
    );

    const retained = [...result.parsedPages.values()];
    expect(retained.length).toBeGreaterThan(0);
    for (const parsed of retained) {
      expect(parsed.content.textContent).toBe("");
      // The residency invariant the whole pipeline rests on.
      expect(parsed.document).toBeNull();
    }

    // The rest of `content` must SURVIVE — the report's summary reads
    // isThinContent, and dropping the lot would silently change every report.
    const anyThin = retained.some((p) => typeof p.content.isThinContent === "boolean");
    expect(anyThin).toBeTrue();
    expect(retained.some((p) => p.content.wordCount > 0)).toBeTrue();
    // And the fields site rules actually read must survive too.
    expect(retained.some((p) => p.meta.title !== null)).toBeTrue();
    expect(retained.some((p) => p.links.length > 0)).toBeTrue();

    await run(storage.close());
  }, T);
});
