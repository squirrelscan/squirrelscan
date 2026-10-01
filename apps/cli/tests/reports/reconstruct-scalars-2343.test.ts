// repo#2343: the report's page walk reads the per-page scalars the rules phase
// stored (`page_features.report_scalars`) instead of re-parsing every page, and
// reads a page's BODY only when it has no scalars to read.
//
// Two things are pinned here. Parity: a report built from the stored scalars is
// the report the old parse produced, field for field, so the change is invisible
// in output. Cost: the scalar path reads no bodies from the content store, which
// is what took the report phase from ~1.8 GB of footprint to ~0.65 GB on 1,000
// 1.5 MB pages. The parse path (an audit stored before schema v30, or a page with
// no features row) is the positive control: it must still read every body.

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

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");

/** Every report scalar varies across these, so a swapped field shows up. */
const PAGES: Array<{ path: string; html: string }> = [
  {
    path: "/full",
    html: `<html><head><title>Full page</title>
      <meta name="description" content="A full description">
      <meta name="robots" content="index,follow">
      <link rel="canonical" href="${SITE}/full">
      <meta property="og:title" content="OG full"><meta property="og:image" content="${SITE}/i.jpg">
      <meta property="og:description" content="OG desc"><meta property="og:url" content="${SITE}/full">
      <meta property="og:type" content="product"><meta property="og:site_name" content="Example">
      <meta name="twitter:card" content="summary">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"x"}</script>
      </head><body><h1>One</h1><p>${words(600)}</p></body></html>`,
  },
  {
    path: "/bare",
    html: `<html><head></head><body><h1>A</h1><h1>B</h1><p>short</p></body></html>`,
  },
  {
    path: "/og-image-only",
    html: `<html><head><title>Only image</title><meta property="og:image" content="${SITE}/o.jpg">
      </head><body><h1>x</h1><p>${words(400)}</p></body></html>`,
  },
  {
    // og:title without og:description: an og field read from the wrong scalar
    // moves this page into or out of missingOgTags.
    path: "/og-title-only",
    html: `<html><head><title>Only title</title><meta property="og:title" content="T">
      <meta name="twitter:card" content="summary_large_image">
      </head><body><h1>x</h1><p>${words(400)}</p></body></html>`,
  },
  {
    // Stored with NO features row: a page outside the rule universe. It must
    // still be summarised, by parsing its body as before.
    path: "/outside-universe",
    html: `<html><head><title>Outside</title></head><body><p>${words(50)}</p></body></html>`,
  },
];

function page(path: string, html: string): PageRecord {
  const url = `${SITE}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
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

/**
 * A crawl stored the way the CLI stores one: bodies in a content store, and a
 * features row per in-universe page, written from the parse the rules phase
 * holds. `scalars: false` stores the rows as a pre-v30 binary did.
 */
async function storedAudit(scalars: boolean) {
  const bodies = new Map<string, string>();
  const counter = { bodyReads: 0 };
  const contentStore = {
    put(content: string) {
      const hash = `cs-${bodies.size}`;
      bodies.set(hash, content);
      return hash;
    },
    getString(hash: string) {
      counter.bodyReads++;
      return bodies.get(hash) ?? null;
    },
  };
  const store = new SQLiteStorage(":memory:", contentStore);
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
        pagesTotal: PAGES.length,
        pagesFetched: PAGES.length,
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
  for (const { path, html } of PAGES) {
    const record = page(path, html);
    await run(store.upsertPage(crawlId, record));
    if (path === "/outside-universe") continue;
    const row = extractPageFeatures(record, parsePageRecord(record)!);
    await run(
      store.upsertPageFeatures(crawlId, {
        ...row,
        reportScalars: scalars ? row.reportScalars : null,
      })
    );
  }
  return { store, crawlId, counter };
}

async function report(scalars: boolean) {
  const { store, crawlId, counter } = await storedAudit(scalars);
  counter.bodyReads = 0;
  const built = await run(reconstructReport(store, crawlId, undefined));
  const bodyReads = counter.bodyReads;
  await run(store.close());
  return { built, bodyReads };
}

describe("reconstructReport reads stored report scalars (#2343)", () => {
  test("the report from stored scalars is the report the parse produced", async () => {
    const fromScalars = (await report(true)).built;
    const fromParse = (await report(false)).built;

    expect(fromScalars.summary).toEqual(fromParse.summary);
    expect(fromScalars.pages).toEqual(fromParse.pages);
    // Non-vacuous: the fixture really exercises the summary lists.
    expect(fromParse.summary.missingTitles).toEqual([`${SITE}/bare`]);
    expect(fromParse.summary.multipleH1s).toEqual([`${SITE}/bare`]);
    expect(fromParse.summary.missingOgTags).toContain(`${SITE}/bare`);
    expect(fromParse.summary.missingTwitterCards).toHaveLength(3);
    expect(fromParse.summary.missingOgTags).not.toContain(
      `${SITE}/og-title-only`
    );
    expect(fromParse.pages.find((p) => p.url.endsWith("/full"))!.og).toEqual({
      title: "OG full",
      description: "OG desc",
      url: `${SITE}/full`,
      type: "product",
      image: `${SITE}/i.jpg`,
      siteName: "Example",
    });
  });

  test("reads a body only for the page with no stored scalars", async () => {
    // One page sits outside the rule universe, so it has no features row and
    // is parsed as before; every other page is read from its scalars.
    expect((await report(true)).bodyReads).toBe(1);
    // The control: an audit stored before v30 parses every page, so the walk
    // has to read every body. Without this the 1 above could pass because the
    // counter is not wired to anything.
    expect((await report(false)).bodyReads).toBe(PAGES.length);
  });
});
