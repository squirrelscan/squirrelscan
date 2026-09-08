// Template cluster key on page_features (#1949).
//
// `page_features.template_fp` shipped as an indexed column that `extractPageFeatures`
// set to `null` on every row, with no reader anywhere. This is the gate for
// populating it: the key has to be a deterministic, order-insensitive function of
// the chrome fingerprint `fingerprintPage` already builds, it has to reach the
// column, `GROUP BY template_fp` has to cluster on it, and the streamed loop has to
// get it from the fingerprint it ALREADY computes rather than walking each DOM a
// second time.
//
// Named `*golden*` deliberately: that glob is what the "Audit engine golden tests"
// CI job runs. `fingerprint-parity.test.ts` holds the other pinned hash in this
// package and is NOT matched by it, so it has never run in CI (public #229) — a
// mistake worth not repeating for a key that #1951 will fan rule verdicts across.
//
// The cluster counts this key has to reproduce are measured on REAL crawls, not
// here: gymshark.com 247 pages → 13 clusters (8 multi-page, 94.7% redundant),
// openelectricity.org.au 100 pages → 12 clusters (3 multi-page, 88.0%). Reproduce
// with `apps/cli/scripts/template-cluster-census.ts`. They cannot be asserted from
// a fixture in this repo, and specifically not from the synthetic bench corpora:
// those are generated from 1-6 templates, so every clustering definition collapses
// to ~99% redundancy on them and agrees for the wrong reason. Proving the key
// clusters REAL multi-page templates the way running per page would is #1950's
// parity gate, not this file's job.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import {
  buildCollectedPageSignal,
  createRunner,
  fingerprintPage,
  fingerprintWalkCount,
  resetFingerprintWalkCount,
} from "@squirrelscan/rules";
import type { PageFingerprint, ParsedPage, SiteData } from "@squirrelscan/rules";
import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery, extractPageFeatures, templateFingerprintKey } from "../src/index";
import { parseHtmlForRules } from "../src/adapter";
import { streamPageRules, type SharedPageSignals } from "../src/streaming";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";

function fp(over: Partial<PageFingerprint> = {}): PageFingerprint {
  return {
    assetHosts: new Set(["cdn.example.com"]),
    bodyClasses: new Set(["theme-a", "page"]),
    cssVars: new Set(["--brand"]),
    stylesheetHrefs: new Set(["/theme.css"]),
    hasNav: true,
    hasFooter: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The key itself
// ---------------------------------------------------------------------------

describe("templateFingerprintKey", () => {
  test("is 16 hex chars and deterministic across calls", () => {
    const key = templateFingerprintKey(fp());
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(templateFingerprintKey(fp())).toBe(key);
  });

  test("is independent of set iteration order", () => {
    // The failure this exists for: `Set` iterates in INSERTION order, which is
    // document order, so two pages off one template that list their stylesheets
    // or classes in a different order would land in different clusters. Every
    // set is built here in the reverse order of the baseline.
    const forward = fp({
      assetHosts: new Set(["a.example.com", "b.example.com"]),
      bodyClasses: new Set(["one", "two", "three"]),
      cssVars: new Set(["--a", "--b"]),
      stylesheetHrefs: new Set(["/1.css", "/2.css"]),
    });
    const reversed = fp({
      assetHosts: new Set(["b.example.com", "a.example.com"]),
      bodyClasses: new Set(["three", "two", "one"]),
      cssVars: new Set(["--b", "--a"]),
      stylesheetHrefs: new Set(["/2.css", "/1.css"]),
    });
    expect([...forward.bodyClasses]).not.toEqual([...reversed.bodyClasses]); // orders really differ
    expect(templateFingerprintKey(reversed)).toBe(templateFingerprintKey(forward));
  });

  test("every marker is part of the key", () => {
    const base = templateFingerprintKey(fp());
    const changed = [
      fp({ assetHosts: new Set(["other.example.com"]) }),
      fp({ bodyClasses: new Set(["theme-b", "page"]) }),
      fp({ cssVars: new Set(["--other"]) }),
      fp({ stylesheetHrefs: new Set(["/other.css"]) }),
      fp({ hasNav: false }),
      fp({ hasFooter: false }),
    ].map(templateFingerprintKey);
    for (const key of changed) expect(key).not.toBe(base);
    expect(new Set(changed).size).toBe(changed.length); // and they differ from each other
  });

  test("markers cannot migrate between fields without changing the key", () => {
    // A delimiter-joined encoding would let a marker forge a different field
    // boundary; the JSON-of-arrays encoding is injective for this shape.
    const asHost = templateFingerprintKey(
      fp({ assetHosts: new Set(["x"]), bodyClasses: new Set() }),
    );
    const asClass = templateFingerprintKey(
      fp({ assetHosts: new Set(), bodyClasses: new Set(["x"]) }),
    );
    expect(asClass).not.toBe(asHost);

    const split = templateFingerprintKey(fp({ bodyClasses: new Set(["a", "b"]) }));
    const joined = templateFingerprintKey(fp({ bodyClasses: new Set(['a","b']) }));
    expect(joined).not.toBe(split);
  });

  test("a page with no document has no key, so it joins no cluster", () => {
    // `getPageFeatureTemplateClusters` filters `IS NOT NULL AND != ''`, so null
    // is the value that keeps an unfingerprintable page out of every cluster.
    expect(templateFingerprintKey(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reaching the column
// ---------------------------------------------------------------------------

const CHROME_A = `<link rel="stylesheet" href="/theme-a.css"><script src="https://cdn.a.test/app.js"></script><style>:root{--brand-a:#111}</style>`;
const CHROME_B = `<link rel="stylesheet" href="/theme-b.css"><script src="https://cdn.b.test/app.js"></script><style>:root{--brand-b:#222}</style>`;

function html(chrome: string, bodyClass: string, body: string): string {
  return `<html><head><title>T</title>${chrome}</head><body class="${bodyClass}"><nav>n</nav>${body}<footer>f</footer></body></html>`;
}

function mkPage(url: string, pageHtml: string): { page: PageRecord; parsed: ParsedPage } {
  const page = {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: pageHtml.length,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h:${url}`,
    html: pageHtml,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
  } as unknown as PageRecord;
  return { page, parsed: parseHtmlForRules(pageHtml, url) };
}

describe("extractPageFeatures — template_fp", () => {
  test("two pages of one template share a key; different chrome does not", () => {
    // Bodies differ the way real template siblings differ (a product page with a
    // different number of variants), which is exactly the case an exact DOM
    // skeleton splits and chrome clustering does not.
    const a1 = mkPage("https://example.com/p1", html(CHROME_A, "tpl-a", "<p>one</p>"));
    const a2 = mkPage(
      "https://example.com/p2",
      html(CHROME_A, "tpl-a", "<p>one</p><p>two</p><ul><li>x</li><li>y</li></ul>"),
    );
    const b1 = mkPage("https://example.com/q1", html(CHROME_B, "tpl-b", "<p>one</p>"));

    const keyA1 = extractPageFeatures(a1.page, a1.parsed).templateFp;
    const keyA2 = extractPageFeatures(a2.page, a2.parsed).templateFp;
    const keyB1 = extractPageFeatures(b1.page, b1.parsed).templateFp;

    expect(keyA1).toMatch(/^[0-9a-f]{16}$/);
    expect(keyA2).toBe(keyA1);
    expect(keyB1).not.toBe(keyA1);
  });

  test("re-extracting an unchanged page gives the same key", () => {
    const first = mkPage("https://example.com/p1", html(CHROME_A, "tpl-a", "<p>one</p>"));
    const second = mkPage("https://example.com/p1", html(CHROME_A, "tpl-a", "<p>one</p>"));
    expect(extractPageFeatures(second.page, second.parsed).templateFp).toBe(
      extractPageFeatures(first.page, first.parsed).templateFp,
    );
  });

  test("a supplied fingerprint is used verbatim, and an explicit null clears the key", () => {
    // The streamed loop supplies one; this is what proves it is USED rather than
    // silently recomputed, and it is why the option is `PageFingerprint`-shaped
    // instead of a pre-hashed string.
    const a = mkPage("https://example.com/p1", html(CHROME_A, "tpl-a", "<p>one</p>"));
    const b = mkPage("https://example.com/q1", html(CHROME_B, "tpl-b", "<p>one</p>"));
    const bFingerprint = fingerprintPage(b.parsed, b.page.normalizedUrl);

    expect(extractPageFeatures(a.page, a.parsed, { fingerprint: bFingerprint }).templateFp).toBe(
      extractPageFeatures(b.page, b.parsed).templateFp,
    );
    expect(extractPageFeatures(a.page, a.parsed, { fingerprint: null }).templateFp).toBeNull();
    // Omitting the option is NOT the same as passing null: it computes.
    expect(extractPageFeatures(a.page, a.parsed, {}).templateFp).not.toBeNull();
  });

  test("a page with no document gets a null key rather than a shared one", () => {
    const bare = {
      meta: { title: "T", description: null, canonical: null, robots: null },
      schemas: { types: [], valid: true, errors: [], raw: null },
      content: { wordCount: 0 },
    } as unknown as ParsedPage;
    const { page } = mkPage("https://example.com/x", html(CHROME_A, "tpl-a", "<p>x</p>"));
    expect(extractPageFeatures(page, bare).templateFp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GROUP BY
// ---------------------------------------------------------------------------

describe("templateClusters over the stored key", () => {
  test("groups the pages of a template and leaves singletons out", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());

    const pages = [
      mkPage("https://example.com/a1", html(CHROME_A, "tpl-a", "<p>1</p>")),
      mkPage("https://example.com/a2", html(CHROME_A, "tpl-a", "<p>1</p><p>2</p>")),
      mkPage("https://example.com/a3", html(CHROME_A, "tpl-a", "<h2>x</h2>")),
      mkPage("https://example.com/b1", html(CHROME_B, "tpl-b", "<p>1</p>")),
      mkPage("https://example.com/b2", html(CHROME_B, "tpl-b", "<p>2</p>")),
      // Its own chrome: one page, so not a cluster.
      mkPage("https://example.com/solo", html(`<link rel="stylesheet" href="/solo.css">`, "tpl-c", "<p>s</p>")),
    ];
    for (const { page, parsed } of pages) {
      await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));
    }

    const clusters = await run(createSiteQuery(store, CRAWL)).then((sq) => sq.templateClusters());
    expect(clusters.map((c) => c.count)).toEqual([3, 2]);
    expect(clusters.map((c) => c.urls)).toEqual([
      ["https://example.com/a1", "https://example.com/a2", "https://example.com/a3"],
      ["https://example.com/b1", "https://example.com/b2"],
    ]);
    // Distinct groups, and the singleton is absent (HAVING count > 1).
    expect(new Set(clusters.map((c) => c.fp)).size).toBe(2);
    expect(clusters.flatMap((c) => c.urls)).not.toContain("https://example.com/solo");

    await run(store.close());
  });
});

// ---------------------------------------------------------------------------
// One fingerprint per page, two consumers
// ---------------------------------------------------------------------------

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const EMPTY_SITE_DATA = {
  baseUrl: "http://synthetic.test",
  pages: [],
  robotsTxt: null,
  sitemaps: null,
} as unknown as SiteData;

describe("streamPageRules — the fingerprint is built once and shared", () => {
  test("the stored key is the reduction of the fingerprint the collector was handed", async () => {
    // Value agreement between the two consumers. It does NOT prove the walk was
    // paid once — a recomputed fingerprint of the same DOM is equal and hashes
    // identically — which is what the walk-budget test below is for.
    //
    // The synthetic fixture is fine here and only here: this asserts a per-page
    // invariant, not a cluster count, so it does not care that the generator's
    // pages nearly all share one template.
    const { storage, crawlId } = await writeCrawlToStorage(
      generateSiteModel({ seed: 11, pageCount: 6 }),
      ":memory:",
    );

    const seen: Array<{ url: string; shared: SharedPageSignals; live: PageFingerprint | null }> = [];
    const streamed = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), EMPTY_SITE_DATA, {
        batchSize: 4,
        collectors: [
          {
            id: "capture",
            collect(page, parsed, shared) {
              seen.push({
                url: page.normalizedUrl,
                shared,
                // Recomputed from the still-live DOM, to compare against.
                live: fingerprintPage(parsed, page.normalizedUrl),
              });
            },
          },
        ],
      }),
    );

    expect(seen.length).toBe(streamed.extractedCount);
    expect(seen.length).toBeGreaterThan(0);

    for (const { url, shared, live } of seen) {
      const stored = await run(storage.getPageFeatures(crawlId, url));
      expect(stored).not.toBeNull();
      // (a) the column holds the reduction of the fingerprint the collector saw…
      expect(stored!.templateFp).toBe(templateFingerprintKey(shared.fingerprint));
      // (b) …and that fingerprint is what a live walk of the same DOM produces,
      // so `template-discontinuity` still compares exactly what it always did.
      expect(shared.fingerprint).toEqual(live);
      expect(shared.fingerprint).not.toBeNull();
    }

    await run(storage.close());
  }, 120_000);

  test("the streamed loop walks each DOM exactly once, whatever the collectors do", async () => {
    // The residency/timing claim in #1949 is "a hash, not a second DOM walk", and
    // no assertion on the OUTPUT can check it: walking the same document twice
    // returns an equal fingerprint and the same key, so a loop that quietly stopped
    // sharing would keep every other test in this file green. The walk counter is
    // the only thing that separates them.
    //
    // The collector here is production's: `runStreamingRules` registers exactly one
    // ("site-dom-signals"), and it builds a CollectedPageSignal from the shared
    // fingerprint. Budget = one walk per scored page. Two failures it catches:
    // `extractPageFeatures(page, parsed)` dropping the shared argument, and a
    // collector calling `buildCollectedPageSignal` without threading it — each of
    // which doubles the count.
    const { storage, crawlId } = await writeCrawlToStorage(
      generateSiteModel({ seed: 12, pageCount: 6 }),
      ":memory:",
    );

    resetFingerprintWalkCount();
    const streamed = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), EMPTY_SITE_DATA, {
        batchSize: 4,
        collectors: [
          {
            id: "site-dom-signals-shape",
            collect(page, parsed, shared) {
              buildCollectedPageSignal({
                url: page.normalizedUrl,
                finalUrl: page.finalUrl,
                parsed,
                fingerprint: shared.fingerprint,
              });
            },
          },
        ],
      }),
    );

    expect(streamed.extractedCount).toBeGreaterThan(0);
    expect(fingerprintWalkCount()).toBe(streamed.extractedCount);

    await run(storage.close());
  }, 120_000);

  test("buildCollectedPageSignal takes the supplied fingerprint instead of walking again", () => {
    // The other half of the sharing: a collector that passes `shared.fingerprint`
    // must not pay for a second walk. A sentinel that could not have been derived
    // from this page is the only way to see the difference.
    const { page, parsed } = mkPage("https://example.com/p1", html(CHROME_A, "tpl-a", "<p>1</p>"));
    const sentinel = fp({ assetHosts: new Set(["sentinel.invalid"]) });

    const supplied = buildCollectedPageSignal({
      url: page.normalizedUrl,
      parsed,
      fingerprint: sentinel,
    });
    expect(supplied.fingerprint).toBe(sentinel);

    // Omitted → computed, as before this change.
    const computed = buildCollectedPageSignal({ url: page.normalizedUrl, parsed });
    expect(computed.fingerprint).toEqual(fingerprintPage(parsed, page.normalizedUrl));
    expect(computed.fingerprint).not.toBe(sentinel);

    // An explicit null is honored too (a page whose DOM is gone).
    expect(
      buildCollectedPageSignal({ url: page.normalizedUrl, parsed, fingerprint: null }).fingerprint,
    ).toBeNull();
  });
});
