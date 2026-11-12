// local/nap-consistency and social/asset-divergence leave noindex pages out (#1773).
//
// A noindex page (staging copy, thank-you page) can carry deliberately different
// details, so it neither votes nor counts. Both engine paths run over one fixture
// and must agree: the legacy path decides from parsed meta + headers
// (`noindexSource`), the streaming path from `page_features.robotsNoindex`.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { extractNapSignal } from "@squirrelscan/utils";

import { napConsistencyRule } from "../src/local/nap-consistency";
import { assetDivergenceRule, extractSiteChromeSignal } from "../src/social/asset-divergence";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

interface Spec {
  path: string;
  phone: string;
  favicon: string;
  /** Meta robots noindex. */
  noindex?: boolean;
  /** X-Robots-Tag noindex header. */
  headerNoindex?: boolean;
  status?: number;
}

const BASE = "https://example.com";
const GOOD_PHONE = "+1 (555) 123-4567";
const OTHER_PHONE = "+1 (555) 999-0000";

function url(path: string): string {
  return `${BASE}${path}`;
}

function html(spec: Spec): string {
  const robots = spec.noindex ? `<meta name="robots" content="noindex,follow">` : "";
  return (
    `<html><head>${robots}<link rel="icon" href="${spec.favicon}">` +
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Acorn Hardware",
    })}</script></head><body><a href="tel:${spec.phone}">${spec.phone}</a></body></html>`
  );
}

function parsed(spec: Spec): ParsedPage {
  return parsePage(html(spec), url(spec.path)) as ParsedPage;
}

const headersFor = (spec: Spec): Record<string, string> =>
  spec.headerNoindex ? { "x-robots-tag": "noindex" } : {};

const isNoindex = (spec: Spec): boolean => !!(spec.noindex || spec.headerNoindex);

const baseCtx = {
  page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as ParsedPage,
  options: {},
};

function legacyCtx(specs: Spec[], siteIndexable: boolean | undefined): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: `${BASE}/`,
      pages: specs.map((spec) => ({
        url: url(spec.path),
        statusCode: spec.status ?? 200,
        parsed: parsed(spec),
        headers: headersFor(spec),
      })),
      robotsTxt: null,
      sitemaps: null,
      siteIndexable,
    },
  };
}

function featureRow(spec: Spec): PageFeatureRow {
  const page = parsed(spec);
  const nap = extractNapSignal(page);
  const chrome = extractSiteChromeSignal(page, url(spec.path));
  return {
    normalizedUrl: url(spec.path),
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: "unknown",
    schemaTypes: page.schema?.types ?? [],
    robotsNoindex: isNoindex(spec),
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: [],
    napName: nap.name,
    napPhones: nap.phones,
    napPhoneFormats: nap.phoneFormats,
    napAddress: nap.address,
    napAddressFormat: nap.addressFormat,
    napTelLink: nap.telLink,
    napMailtoLink: nap.mailtoLink,
    faviconHref: chrome.faviconHref,
    themeColor: chrome.themeColor,
    ogImage: chrome.ogImage,
    hreflangAlternates: null,
  };
}

function streamingCtx(specs: Spec[], siteIndexable: boolean | undefined): RuleContext {
  const rows = specs.map(featureRow);
  const unused = (): never => {
    throw new Error("unexpected SiteQuery method");
  };
  const siteQuery: SiteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (row: PageFeatureRow) => boolean) {
      for (const row of rows) if (pred(row)) yield row;
    },
  };
  return {
    ...baseCtx,
    site: {
      baseUrl: `${BASE}/`,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      siteIndexable,
    },
    siteQuery,
  };
}

/** Run both paths, assert identical output, return it. */
async function bothPaths(
  rule: Rule,
  specs: Spec[],
  siteIndexable: boolean | undefined,
): Promise<CheckResult[]> {
  const legacy = (await Promise.resolve(rule.run(legacyCtx(specs, siteIndexable)))).checks;
  const streamed = (await Promise.resolve(rule.run(streamingCtx(specs, siteIndexable)))).checks;
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  return legacy as CheckResult[];
}

function named(list: CheckResult[], name: string): CheckResult {
  const found = list.find((c) => c.name === name);
  if (!found) throw new Error(`no check ${name} in [${list.map((c) => c.name).join(", ")}]`);
  return found;
}

/** 12 indexable pages sharing one phone and one favicon. */
function indexable(count = 12): Spec[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `/page-${String(i).padStart(3, "0")}`,
    phone: GOOD_PHONE,
    favicon: "/favicon.ico",
  }));
}

describe("local/nap-consistency noindex pages (#1773)", () => {
  const noisy = (extra: Partial<Spec>): Spec[] =>
    Array.from({ length: 6 }, (_, i) => ({
      path: `/staging-${i}`,
      phone: OTHER_PHONE,
      favicon: "/favicon.ico",
      ...extra,
    }));

  test("meta noindex pages with a different phone are not reported or counted", async () => {
    const checks = await bothPaths(napConsistencyRule, [...indexable(), ...noisy({ noindex: true })], true);
    const phone = named(checks, "phone-consistency");
    expect(phone.status).toBe("pass");
    expect(phone.message).toContain("12 pages");
  });

  test("X-Robots-Tag noindex pages are left out too", async () => {
    const checks = await bothPaths(napConsistencyRule, [
      ...indexable(),
      ...noisy({ headerNoindex: true }),
    ], true);
    expect(named(checks, "phone-consistency").status).toBe("pass");
  });

  test("the same pages without noindex still report the conflict", async () => {
    const checks = await bothPaths(napConsistencyRule, [...indexable(), ...noisy({})], true);
    expect(named(checks, "phone-consistency").status).not.toBe("pass");
  });

  test("a noindex-everywhere site (siteIndexable false or unknown) is judged as before", async () => {
    for (const siteIndexable of [false, undefined]) {
      const checks = await bothPaths(
        napConsistencyRule,
        [...indexable(), ...noisy({ noindex: true })],
        siteIndexable,
      );
      expect(named(checks, "phone-consistency").status).not.toBe("pass");
    }
  });

  test("every compared page noindex is not applicable, not a pass", async () => {
    // The only pages that answered 2xx are noindex; the entry page redirected.
    const specs: Spec[] = [
      { path: "/", phone: GOOD_PHONE, favicon: "/f.ico", status: 301 },
      ...noisy({ noindex: true }),
    ];
    const checks = await bothPaths(napConsistencyRule, specs, true);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.skipReason).toBe("not-applicable");
    expect(checks[0]!.details?.skippedNoindexPages).toBe(6);
  });
});

describe("social/asset-divergence noindex pages (#1773)", () => {
  const stale = (extra: Partial<Spec>): Spec[] =>
    Array.from({ length: 5 }, (_, i) => ({
      path: `/staging-${i}`,
      phone: GOOD_PHONE,
      favicon: "/staging.ico",
      ...extra,
    }));

  test("meta noindex pages with another favicon are not reported or counted", async () => {
    const checks = await bothPaths(assetDivergenceRule, [...indexable(), ...stale({ noindex: true })], true);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
  });

  test("X-Robots-Tag noindex pages are left out too", async () => {
    const checks = await bothPaths(assetDivergenceRule, [
      ...indexable(),
      ...stale({ headerNoindex: true }),
    ], true);
    expect(checks[0]!.status).toBe("pass");
  });

  test("the same pages without noindex are reported", async () => {
    const checks = await bothPaths(assetDivergenceRule, [...indexable(), ...stale({})], true);
    expect(checks[0]!.status).not.toBe("pass");
  });

  test("noindex pages do not count toward the site floor", async () => {
    const checks = await bothPaths(assetDivergenceRule, [
      ...indexable(8),
      ...stale({ noindex: true }),
    ], true);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.message).toContain("Only 8 page(s) crawled");
  });

  test("a noindex-everywhere site (siteIndexable false or unknown) is judged as before", async () => {
    for (const siteIndexable of [false, undefined]) {
      const checks = await bothPaths(
        assetDivergenceRule,
        [...indexable(), ...stale({ noindex: true })],
        siteIndexable,
      );
      expect(checks[0]!.status).not.toBe("pass");
    }
  });

  test("every compared page noindex is not applicable, not a pass", async () => {
    const specs: Spec[] = [
      { path: "/", phone: GOOD_PHONE, favicon: "/f.ico", status: 301 },
      ...stale({ noindex: true }),
    ];
    const checks = await bothPaths(assetDivergenceRule, specs, true);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.skipReason).toBe("not-applicable");
    expect(checks[0]!.details?.skippedNoindexPages).toBe(5);
  });
});
