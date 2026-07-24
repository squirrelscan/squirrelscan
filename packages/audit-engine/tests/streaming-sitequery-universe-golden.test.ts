// createSiteQuery universe-reconciliation golden (#1021 E-E2 (b)). The streaming
// site pass passes v1's assembled `site.pages` order as `universe` so the
// incoming-link graph matches v1 exactly. This isolates that param against the
// three edge pages the raw stored-pages set would otherwise mishandle: a
// WAF-challenge page (has parsedData but v1 drops it), a redirect hop (no HTML),
// and a non-HTML asset. Membership, iteration ORDER, and link SOURCES must all be
// bounded to the universe. Matched by the Engine Golden Gates CI glob.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import type { LinkData, PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery } from "../src/site-query";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";
const BASE = "https://example.com/";

const EMPTY_HEADERS = {
  contentType: null,
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
} as const;
const EMPTY_SECURITY_HEADERS = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
} as const;

function link(url: string): LinkData {
  return { url, text: "l", isInternal: true };
}

function pageRow(
  normalizedUrl: string,
  status: number,
  contentType: string | null,
  links: LinkData[] | null
): PageRecord {
  return {
    url: normalizedUrl,
    normalizedUrl,
    finalUrl: normalizedUrl,
    depth: normalizedUrl === BASE ? 0 : 1,
    status,
    contentType,
    sizeBytes: links ? 128 : 0,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: links ? "<html></html>" : null,
    parsedData: links ? JSON.stringify({ links }) : null,
    headers: { ...EMPTY_HEADERS },
    securityHeaders: { ...EMPTY_SECURITY_HEADERS },
  };
}

// Fixture: three real HTML pages, one WAF page (parsedData present but v1 excludes
// it), one redirect hop (no HTML), one non-HTML asset, and one 4xx page.
// Every page links to /a — so /a's incoming count is the discriminator: the WAF
// page's link must NOT count when the universe is enforced.
const A = "https://example.com/a";
const B = "https://example.com/b";
const WAF = "https://example.com/waf";
const REDIR = "https://example.com/redir";
const ASSET = "https://example.com/asset.pdf";
const ERR = "https://example.com/err";

const FIXTURE: PageRecord[] = [
  pageRow(BASE, 200, "text/html", [link("/a"), link("/b")]),
  pageRow(A, 200, "text/html", [link("/b")]),
  pageRow(B, 200, "text/html", [link("/a")]),
  pageRow(WAF, 200, "text/html", [link("/a")]), // WAF: has links, but not in universe
  pageRow(REDIR, 301, null, null), // redirect hop: no HTML
  pageRow(ASSET, 200, "application/pdf", null), // non-HTML asset
  pageRow(ERR, 404, "text/html", null), // 4xx: appended to universe, no links
];

// v1's assembled site.pages order: HTML 200 pages in crawl order, then the 4xx
// page appended (WAF/redirect/non-HTML dropped).
const UNIVERSE = [BASE, A, B, ERR];

async function seed(store: SQLiteStorage): Promise<void> {
  for (const p of FIXTURE) await run(store.upsertPage(CRAWL, p));
}

describe("createSiteQuery universe reconciliation (E-E2 (b))", () => {
  test("with `universe`, incoming-link membership/order/sources match v1's site.pages", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await seed(store);

    const sq = await run(createSiteQuery(store, CRAWL, { universe: UNIVERSE }));
    const counts = sq.incomingLinkCounts();

    // Membership + ORDER: exactly the universe, in universe order (WAF/redirect/
    // non-HTML pages excluded even though two carry parsedData).
    expect([...counts.keys()]).toEqual([BASE, A, B, ERR]);

    // Link SOURCES restricted to the universe: /a is linked by home, /b, AND /waf,
    // but /waf is not in the universe so it must not count → 2, not 3.
    expect(counts.get(A)).toBe(2);
    expect(counts.get(B)).toBe(2); // home + /a
    expect(counts.get(BASE)).toBe(0);
    expect(counts.get(ERR)).toBe(0);

    await run(store.close());
  });

  test("without `universe`, the raw stored-pages set diverges (proves the param matters)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await seed(store);

    const sq = await run(createSiteQuery(store, CRAWL));
    const counts = sq.incomingLinkCounts();

    // Raw universe includes the WAF/redirect/non-HTML pages…
    expect([...counts.keys()]).toEqual([BASE, A, ASSET, B, ERR, REDIR, WAF]);
    // …and the WAF page's link to /a IS counted → 3, the exact divergence the
    // universe param removes.
    expect(counts.get(A)).toBe(3);

    await run(store.close());
  });
});
