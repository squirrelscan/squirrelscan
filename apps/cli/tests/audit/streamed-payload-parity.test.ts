// #1913: the audit controller no longer holds a whole-crawl site context, so
// every consumer that used to read one now collects during the streamed
// pre-rules walk instead. This pins the two that produce user-visible output —
// the cloud-prefetch request payloads and the tech-detect page sample — to the
// whole-array builders they replaced, batch boundaries and all.
//
// The batching is the part worth testing: each collector's caps are carried
// state, so a cap that reset per batch, or a home page found in a later batch
// than the sample it belongs in front of, changes what the cloud is asked.

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { TechDetectPagePayload } from "@squirrelscan/core-contracts";
import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import { SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  buildSiteContext,
  releaseSiteContextDocuments,
} from "../../src/audit/adapter";
import {
  absorbExternalLinkUrls,
  buildCloudPagePayloads,
  buildMetadataPayload,
  createCloudPrefetchCollector,
  createTechDetectSampleCollector,
  detectLocalTechnologies,
  runCloudTechDetect,
} from "../../src/audit/cloud";
import { buildBlocklistPayload } from "../../src/audit/cloud-payloads-blocklist";
import { buildGapsPayloads } from "../../src/audit/cloud-payloads-gaps";
import { getDefaultConfig } from "../../src/config";

const BASE = "https://example.com/";

function pageRecord(
  url: string,
  html: string,
  overrides: Partial<PageRecord> = {}
): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${url}`,
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
    ...overrides,
  };
}

/** A page with per-page-distinct links, images, scripts, ids and classes. */
function html(i: number): string {
  return `<!doctype html><html lang="en"><head>
<title>Page ${i} | Example</title>
<meta name="description" content="Description for page ${i}">
<meta property="og:title" content="OG ${i}">
<link rel="alternate" hreflang="en-${i}" href="https://example.com/en-${i}">
<script type="application/ld+json">{"@type":"Organization","name":"Acme ${i}"}</script>
<script src="https://cdn${i}.example.net/tracker.js"></script>
</head><body>
<h1>Heading ${i}</h1>
<div id="wrap${i}" class="layout col${i}">
<a href="https://outbound${i}.example.org/a">out ${i}</a>
<a href="mailto:hi${i}@example.com">mail ${i}</a>
<a href="/internal/${i}">internal ${i}</a>
<img src="https://img${i}.example.net/p.png" alt="img ${i}">
<p>${`body copy for page ${i}. `.repeat(20)}</p>
</div></body></html>`;
}

/**
 * 30 pages: the base URL is deliberately LAST, past both the metadata sample
 * prefix (6) and the tech-detect prefix (12), so the "home page lives in a
 * batch the prefix never reached" path is the one under test. Two pages are
 * non-2xx and one is a non-HTML asset, so the usable-page filters have
 * something to drop.
 */
function corpus(): PageRecord[] {
  const pages: PageRecord[] = [];
  for (let i = 0; i < 29; i++) {
    const url = `https://example.com/p/${String(i).padStart(2, "0")}`;
    if (i === 5) {
      pages.push(pageRecord(url, html(i), { status: 404 }));
    } else if (i === 9) {
      pages.push(
        pageRecord(url, "body { color: red }", {
          contentType: "text/css",
          headers: {
            ...pageRecord(url, "").headers,
            contentType: "text/css",
          },
        })
      );
    } else {
      pages.push(pageRecord(url, html(i)));
    }
  }
  // normalized_url ASC puts "/" after "/p/..." only if we say so; the walk
  // visits whatever order storage returns, and the collectors must not care.
  pages.push(pageRecord(BASE, html(99)));
  return pages;
}

const context = (pages: PageRecord[]) =>
  Effect.runSync(buildSiteContext(pages));

/** Feed a collector the corpus one batch at a time, releasing like the walk does. */
function streamed<
  T extends { absorb: (ctx: ReturnType<typeof context>) => void },
>(collector: T, pages: PageRecord[], batchSize: number): T {
  for (let offset = 0; offset < pages.length; offset += batchSize) {
    const batch = context(pages.slice(offset, offset + batchSize));
    collector.absorb(batch);
    releaseSiteContextDocuments(batch);
  }
  return collector;
}

describe("streamed cloud-prefetch payload collection (#1913)", () => {
  for (const batchSize of [1, 4, 7, 1000]) {
    test(`batch=${batchSize} produces the whole-array payloads`, () => {
      const pages = corpus();
      const whole = context(pages);
      const config = getDefaultConfig();

      const expectedPages = buildCloudPagePayloads(whole);
      const expectedBlocklist = buildBlocklistPayload(whole);
      const expectedGaps = buildGapsPayloads(whole, BASE, config);
      const expectedMetadata = buildMetadataPayload(whole, BASE);

      const built = streamed(
        createCloudPrefetchCollector(BASE),
        pages,
        batchSize
      ).build();

      expect(built.pages).toEqual(expectedPages);
      expect(built.blocklist).toEqual(expectedBlocklist);
      expect(built.metadataPages).toEqual(expectedMetadata);
      // The gaps payloads are seeds plus config, so compare the dispatched shape.
      expect(
        Object.keys(expectedGaps).length > 0
          ? expectedGaps["keyword-gaps"]?.seedKeywords
          : []
      ).toEqual(built.gapsSeeds);
    });
  }

  test("the retained metadata sample is bounded, not page-scaled", () => {
    const built = streamed(
      createCloudPrefetchCollector(BASE),
      corpus(),
      4
    ).build();
    expect(built.metadataPages.length).toBeLessThanOrEqual(
      SERVICE_LIMITS.metadataMaxPages
    );
    // The home page leads it even though it was crawled last.
    expect(built.metadataPages[0]?.url).toBe(BASE);
  });

  test("the dead-links estimate counts the same urls batched or not", () => {
    const pages = corpus();
    const batched = new Set<string>();
    for (let offset = 0; offset < pages.length; offset += 3) {
      absorbExternalLinkUrls(batched, context(pages.slice(offset, offset + 3)));
    }
    const wholePass = new Set<string>();
    absorbExternalLinkUrls(wholePass, context(pages));

    expect([...batched].sort()).toEqual([...wholePass].sort());
    // Each html page carries one distinct outbound host.
    expect(batched.size).toBeGreaterThan(0);
  });
});

describe("streamed tech-detect sample (#1913)", () => {
  test("local detection over the sample equals detection over the crawl", () => {
    const pages = corpus();
    const scripts = [
      { url: "https://cdn0.example.net/tracker.js", content: "var x = 1;" },
    ];
    const expected = detectLocalTechnologies({
      baseUrl: BASE,
      siteContext: context(pages),
      scripts,
    });
    const sample = streamed(
      createTechDetectSampleCollector(BASE),
      pages,
      5
    ).build();
    expect(
      detectLocalTechnologies({ baseUrl: BASE, siteContext: sample, scripts })
    ).toEqual(expected);
  });

  test("the cloud tech-detect body is the same pages in the same order", async () => {
    const pages = corpus();
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.technologies = true;

    const captured: TechDetectPagePayload[][] = [];
    const client = {
      detectTechnologies: async (req: { pages: TechDetectPagePayload[] }) => {
        captured.push(req.pages);
        return {
          technologies: [],
          added: [],
          removed: [],
          firstScan: true,
        };
      },
    } as unknown as CloudServicesClient;

    const run = (siteContext: ReturnType<typeof context>) =>
      runCloudTechDetect({
        client,
        config,
        auditId: "audit-1",
        baseUrl: BASE,
        siteContext,
        scripts: [],
      });

    await run(context(pages));
    await run(
      streamed(createTechDetectSampleCollector(BASE), pages, 5).build()
    );

    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual(captured[0]!);
    expect(captured[0]?.[0]?.url).toBe(BASE);
    expect(captured[0]!.length).toBeLessThanOrEqual(
      SERVICE_LIMITS.techDetectMaxPages
    );
  });

  test("the sample is bounded by techDetectMaxPages plus the home page", () => {
    const sample = streamed(
      createTechDetectSampleCollector(BASE),
      corpus(),
      5
    ).build();
    expect(sample.length).toBeLessThanOrEqual(
      SERVICE_LIMITS.techDetectMaxPages + 1
    );
  });
});
