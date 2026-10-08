// Reciprocal hreflang region variants are not duplicates, on BOTH paths
// (squirrelscan/squirrelscan#489).
//
// core/title-unique, content/duplicate-title and content/duplicate-description
// merge two pages that list each other as same-language hreflang alternates
// (en-gb / en-us) before deciding whether a title or description is shared. The
// legacy path reads `parsed.hreflangAlternates` + `parsed.meta.canonical`; the
// streaming path reads the same values back from `page_features`. Every page here
// goes through the real `parsePage` and `extractPageFeatures`, so the stored row
// is exactly what an audit writes, and each rule must give one answer both ways.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import type { ParsedPage, Rule, RuleContext } from "@squirrelscan/rules";
import type { PageFeatureRow, PageRecord } from "@squirrelscan/core-contracts";

import { extractPageFeatures } from "../src/page-features";
import { createSiteQuery } from "../src/site-query";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";
const ORIGIN = "http://127.0.0.1:8791";
const BASE = `${ORIGIN}/`;

const TITLE = "Organic cotton shirt in navy blue for summer | Brand";
const DESCRIPTION =
  "Organic cotton shirt in navy blue, breathable and light for summer days. Free returns.";

const rules = loadAllRules();

interface Spec {
  path: string;
  /** "self", another path, or null for no canonical tag. */
  canonical: "self" | string | null;
  /** [hreflang, path] pairs, in document order. */
  alternates: Array<[string, string]>;
  lang?: string;
}

// The reporter's repro page, with the canonical and alternates per spec.
function html(s: Spec): string {
  const canonical =
    s.canonical === null
      ? ""
      : `<link rel="canonical" href="${ORIGIN}${s.canonical === "self" ? s.path : s.canonical}"> <!-- self, per page -->\n`;
  const alternates = s.alternates
    .map(([lang, path]) => `<link rel="alternate" hreflang="${lang}" href="${ORIGIN}${path}">`)
    .join("\n");
  return `<!doctype html><html lang="${s.lang ?? "en"}"><head><meta charset="utf-8">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
${canonical}${alternates}
</head><body><h1>Organic cotton shirt</h1></body></html>`;
}

function pageRecord(s: Spec): PageRecord {
  const url = `${ORIGIN}${s.path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: 512,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h:${s.path}`,
    html: html(s),
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

interface Fixture {
  store: SQLiteStorage;
  legacyPages: Array<{
    url: string;
    statusCode: number;
    parsed: ParsedPage;
    headers: Record<string, string>;
  }>;
}

/**
 * One store and one legacy page list from the same parse. `stale` drops the
 * alternates from both, the shape of a page parsed or cached before #489.
 */
async function fixture(specs: Spec[], opts: { stale?: boolean } = {}): Promise<Fixture> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  const legacyPages: Fixture["legacyPages"] = [];
  const features: PageFeatureRow[] = [];
  for (const s of [...specs].sort((a, b) => a.path.localeCompare(b.path))) {
    const record = pageRecord(s);
    const parsed = parsePage(record.html!, record.url) as unknown as ParsedPage;
    if (opts.stale) delete parsed.hreflangAlternates;
    await run(store.upsertPage(CRAWL, record));
    const row = extractPageFeatures(record, parsed);
    if (opts.stale) delete (row as Partial<PageFeatureRow>).hreflangAlternates;
    features.push(row);
    legacyPages.push({ url: record.normalizedUrl, statusCode: 200, parsed, headers: {} });
  }
  await run(store.upsertPageFeaturesBatch(CRAWL, features));
  return { store, legacyPages };
}

async function runBothWays(f: Fixture, rule: Rule) {
  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options: {},
  };
  const legacyCtx: RuleContext = {
    ...base,
    site: { baseUrl: BASE, pages: f.legacyPages, robotsTxt: null, sitemaps: null },
  };
  const legacy = (await Promise.resolve(rule.run(legacyCtx))).checks;

  const siteQuery = await run(createSiteQuery(f.store, CRAWL));
  const streamedCtx: RuleContext = {
    ...base,
    // EMPTY pages: the streaming path must not read them.
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
  const streamed = (await Promise.resolve(rule.run(streamedCtx))).checks;
  return { legacy, streamed };
}

const RULE_IDS = ["core/title-unique", "content/duplicate-title", "content/duplicate-description"];

/** Run all three rules both ways; assert the paths agree and return each status. */
async function statuses(specs: Spec[], opts: { stale?: boolean } = {}) {
  const f = await fixture(specs, opts);
  const out: Record<string, { status: string; pages: string[] }> = {};
  for (const id of RULE_IDS) {
    const { legacy, streamed } = await runBothWays(f, rules.get(id)!);
    expect(streamed).toEqual(legacy);
    expect(legacy).toHaveLength(1);
    out[id] = {
      status: legacy[0]!.status,
      pages: (legacy[0]!.items ?? []).flatMap((item) => item.sourcePages ?? []),
    };
  }
  await run(f.store.close());
  return out;
}

const GB = "/en-gb/shirt.html";
const US = "/en-us/shirt.html";

// The reporter's repro: both pages list en-gb, en-us and x-default.
const REPRO_ALTERNATES: Array<[string, string]> = [
  ["en-gb", GB],
  ["en-us", US],
  ["x-default", GB],
];

function expectAll(result: Awaited<ReturnType<typeof statuses>>, status: "pass" | "warn") {
  for (const id of RULE_IDS) expect(result[id]!.status, id).toBe(status);
}

describe("reciprocal hreflang region variants, identically on both paths", () => {
  test("the issue's repro (explicit self canonicals) gets no finding", async () => {
    const result = await statuses([
      { path: GB, canonical: "self", alternates: REPRO_ALTERNATES },
      { path: US, canonical: "self", alternates: REPRO_ALTERNATES },
    ]);
    expectAll(result, "pass");
  });

  test("a reciprocal pair with no canonical on either page gets no finding", async () => {
    const result = await statuses([
      { path: GB, canonical: null, alternates: REPRO_ALTERNATES },
      { path: US, canonical: null, alternates: REPRO_ALTERNATES },
    ]);
    expectAll(result, "pass");
  });

  test("de-de, de-at and de-ch variants of one page get no finding", async () => {
    const alternates: Array<[string, string]> = [
      ["de-de", "/de-de/hemd.html"],
      ["de-at", "/de-at/hemd.html"],
      ["de-ch", "/de-ch/hemd.html"],
    ];
    const result = await statuses(
      alternates.map(([, path]) => ({ path, canonical: "self", alternates, lang: "de" })),
    );
    expectAll(result, "pass");
  });

  test("unrelated pages with an identical title and description are reported", async () => {
    const result = await statuses([
      { path: "/a.html", canonical: "self", alternates: [] },
      { path: "/b.html", canonical: "self", alternates: [] },
    ]);
    expectAll(result, "warn");
  });

  test("an unrelated page sharing a variant pair's title is still reported", async () => {
    const result = await statuses([
      { path: GB, canonical: "self", alternates: REPRO_ALTERNATES },
      { path: US, canonical: "self", alternates: REPRO_ALTERNATES },
      { path: "/other.html", canonical: "self", alternates: [] },
    ]);
    expectAll(result, "warn");
    expect(result["content/duplicate-title"]!.pages).toEqual([
      `${ORIGIN}${GB}`,
      `${ORIGIN}${US}`,
      `${ORIGIN}/other.html`,
    ]);
  });

  test("a one-way hreflang reference is reported", async () => {
    const result = await statuses([
      { path: GB, canonical: "self", alternates: REPRO_ALTERNATES },
      { path: US, canonical: "self", alternates: [["en-us", US]] },
    ]);
    expectAll(result, "warn");
  });

  test("a reciprocal pair where one page canonicalises to the other is reported", async () => {
    const result = await statuses([
      { path: GB, canonical: "self", alternates: REPRO_ALTERNATES },
      { path: US, canonical: GB, alternates: REPRO_ALTERNATES },
    ]);
    expectAll(result, "warn");
  });

  test("a reciprocal de/en pair with an identical title is reported", async () => {
    const alternates: Array<[string, string]> = [
      ["de", "/de/shirt.html"],
      ["en", "/en/shirt.html"],
    ];
    const result = await statuses([
      { path: "/de/shirt.html", canonical: "self", alternates, lang: "de" },
      { path: "/en/shirt.html", canonical: "self", alternates },
    ]);
    expectAll(result, "warn");
  });

  // Crawl reuse replays the stored parse and the rule cache replays the stored
  // features, so a page from before #489 reaches the rules without alternates.
  test("pages stored without alternates fall back to the old answer", async () => {
    const result = await statuses(
      [
        { path: GB, canonical: "self", alternates: REPRO_ALTERNATES },
        { path: US, canonical: "self", alternates: REPRO_ALTERNATES },
      ],
      { stale: true },
    );
    expectAll(result, "warn");
  });
});
