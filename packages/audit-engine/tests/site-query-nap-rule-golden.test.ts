// local/nap-consistency dual-path golden (#1373).
//
// The chain under test: parsePage(html) -> extractPageFeatures -> the v20
// page_features NAP columns -> createSiteQuery -> the rule's streaming branch.
// The legacy branch re-derives the same NAP from the SAME parsed pages, so a
// deep-equal here proves the stored scalars and the live extraction agree — the
// one invariant that could silently rot, since the two live in different packages.
//
// The streaming run is given an EMPTY `site.pages`, so passing also proves the
// streaming branch reads nothing off the resident page array.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import { extractNapSignal } from "@squirrelscan/utils";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery, extractPageFeatures } from "../src/index";
import { parseHtmlForRules } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";

const napConsistencyRule = loadAllRules().get("local/nap-consistency")!;

interface Spec {
  normalizedUrl: string;
  /** Rendered phone; also the tel: href payload. */
  phone: string | null;
  /** JSON-LD streetAddress. */
  street: string | null;
}

function specHtml(spec: Spec): string {
  const head = spec.street
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        name: "Acorn Hardware",
        address: {
          "@type": "PostalAddress",
          streetAddress: spec.street,
          addressLocality: "Sydney",
          postalCode: "2000",
        },
      })}</script>`
    : "";
  const body = spec.phone ? `<a href="tel:${spec.phone}">${spec.phone}</a>` : "<p>hi</p>";
  return `<html><head>${head}</head><body>${body}</body></html>`;
}

function mkPage(spec: Spec): { page: PageRecord; parsed: ParsedPage } {
  const html = specHtml(spec);
  const page = {
    url: spec.normalizedUrl,
    normalizedUrl: spec.normalizedUrl,
    finalUrl: spec.normalizedUrl,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h:${spec.normalizedUrl}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
  } as unknown as PageRecord;

  return { page, parsed: parsePage(html, spec.normalizedUrl) as ParsedPage };
}

// normalized_url ASC (== the getPageFeaturesPage cursor order). 12 pages so the
// 10-page floor is cleared: 9 share one number, 3 render it differently, and one
// address deviates outright — so the run exercises warn AND fail in one pass.
const FIXTURE: Spec[] = [
  { normalizedUrl: "https://example.com/p01", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p02", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p03", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p04", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p05", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p06", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p07", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p08", phone: "+1 (555) 123-4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p09", phone: "+1 (555) 123-4567", street: "123 Main Street" },
  { normalizedUrl: "https://example.com/p10", phone: "555.123.4567", street: "123 Main St" },
  { normalizedUrl: "https://example.com/p11", phone: "555.123.4567", street: "123 Main St" },
  // Genuinely different address, and no phone at all.
  { normalizedUrl: "https://example.com/p12", phone: null, street: "77 Other Rd" },
];

async function seedAndRun(rule: Rule) {
  const store = await freshStore();
  const built = FIXTURE.map(mkPage);

  for (const { page, parsed } of built) {
    await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));
  }

  const sitePages = [...built]
    .sort((a, b) => (a.page.normalizedUrl < b.page.normalizedUrl ? -1 : 1))
    .map(({ page, parsed }) => ({
      url: page.normalizedUrl,
      statusCode: page.status,
      parsed,
    }));

  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options: {},
  };

  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: sitePages, robotsTxt: null, sitemaps: null },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    // EMPTY — the streaming path must read only page_features.
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;

  await run(store.close());
  return { legacy, streamed };
}

describe("dual-path golden — local/nap-consistency (extractor → v20 columns → siteQuery)", () => {
  test("streaming path is deep-equal to legacy, with the expected drift verdicts", async () => {
    const { legacy, streamed } = await seedAndRun(napConsistencyRule);

    expect(streamed).toEqual(legacy);

    const byName = new Map(legacy.map((c) => [c.name, c]));
    expect([...byName.keys()]).toEqual([
      "local-business-schema",
      "phone-consistency",
      "address-consistency",
    ]);

    // 11 pages declare a phone; one number, two renderings → format drift.
    const phone = byName.get("phone-consistency")!;
    expect(phone.status).toBe("warn");
    expect(phone.message).toBe(
      "The same phone number is formatted 2 different ways across 11 pages",
    );
    expect(phone.items?.map((i) => [i.id, i.meta?.pageCount])).toEqual([
      ["+1 (555) 123-4567", 9],
      ["555.123.4567", 2],
    ]);

    // 12 pages declare an address; "St"/"Street" fold together, so the norm holds
    // 11/12 and /p12 is a genuine conflict — a fail outranks the format drift.
    const address = byName.get("address-consistency")!;
    expect(address.status).toBe("fail");
    expect(address.details).toEqual({
      norm: "123 Main St, Sydney, 2000",
      normPages: 11,
      deviantValues: 1,
      deviantPages: 1,
      samplePages: 12,
    });
    expect(address.items?.[0]?.sourcePages).toEqual(["https://example.com/p12"]);
  });
});

describe("parseHtmlForRules carries contactLinks", () => {
  // There are TWO parsers producing a ParsedPage: `parsePage` (crawler) and
  // `parseHtmlForRules` (this package — what `parsePageRecord` and the #263
  // page-rule workers actually run). A field added to only one of them is
  // invisible in production while every direct-parser test still passes, so pin
  // that both agree.
  const HTML =
    `<html><body><a href="tel:+1 (555) 123-4567">+1 (555) 123-4567</a>` +
    `<a href="mailto:hi@example.com">Email</a><a href="/about">about</a></body></html>`;

  test("both parse paths produce the same contact links", () => {
    const viaAdapter = parseHtmlForRules(HTML, BASE);
    const viaParser = parsePage(HTML, BASE);

    expect(viaAdapter.contactLinks).toEqual([
      { scheme: "tel", value: "+1 (555) 123-4567", text: "+1 (555) 123-4567" },
      { scheme: "mailto", value: "hi@example.com", text: "Email" },
    ]);
    expect(viaAdapter.contactLinks).toEqual(viaParser.contactLinks);
  });

  test("a NAP signal survives the adapter parse path", () => {
    const nap = extractNapSignal(parseHtmlForRules(HTML, BASE));
    expect(nap.phones).toEqual(["1234567"]);
    expect(nap.phoneFormats).toEqual(["+1 (555) 123-4567"]);
    expect(nap.telLink).toBe(true);
    expect(nap.mailtoLink).toBe(true);
  });
});
