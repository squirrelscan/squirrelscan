// Planning's Nut Shop "worked" cases, pinned as engine-level regression fixtures over a 40-page site.
// A real engine run (pre-rules, then the streaming rule pass) over stored pages, then the report's own grouping
// and the report diff, so each statement is about what a reader of the report sees:
//   1. a footer link that 404s on every page is ONE finding, linked from every page, not N findings;
//   2. a missing meta description on 37 product pages is ONE finding listing 37 pages;
//   3. a fixed `lang` fault that comes back is reported as new rows by the diff, not as unchanged.

import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { runStreamingRules } from "@squirrelscan/audit-engine";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { groupIssuesByCategory } from "@squirrelscan/report";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { AuditReport } from "@/types";

import { buildIssueInstances, diffReports } from "@/reports/diff";

import { runStreamingPreRules } from "../../../../packages/audit-engine/src/streaming-pre-rules";

const BASE = "https://nutshop.test";
const PRODUCTS = 37;
const RULES = [
  "links/broken-links",
  "core/meta-description",
  "i18n/lang-attribute",
];
const CONFIG = {
  rule_options: {},
  rules: { enable: RULES },
  crawler: { max_pages: 100, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: true },
} as unknown as Config;

const DESCRIPTION =
  "Roasted almonds, cashews and pecans from small growers, packed to order and shipped fresh to your door every week of the year.";

function record(path: string, html: string, status = 200): PageRecord {
  const url = BASE + path;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: path === "/" ? 0 : 1,
    status,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `h${path}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

const FOOTER = `<footer><a href="/legal/old-terms">Terms</a></footer>`;

function html(
  title: string,
  { lang, description }: { lang: boolean; description: boolean }
): string {
  return `<!doctype html><html${lang ? ' lang="en"' : ""}><head><title>${title}</title>${
    description ? `<meta name="description" content="${DESCRIPTION}">` : ""
  }</head><body><main><h1>${title}</h1><p>${title} page.</p></main>${FOOTER}</body></html>`;
}

/** The site: home and about (complete), 37 product pages, and the dead footer target as a 404. */
function site(opts: { productLang: boolean }): PageRecord[] {
  const full = { lang: true, description: true };
  return [
    record("/", html("Home", full)),
    record("/about", html("About", full)),
    ...Array.from({ length: PRODUCTS }, (_, i) =>
      record(
        `/products/p-${i}`,
        html(`Product ${i}`, { lang: opts.productLang, description: false })
      )
    ),
    // The 404 page is a complete page of the site's template (footer included), as a shop's own 404 is.
    record("/legal/old-terms", html("Not found", full), 404),
  ];
}

async function audit(pages: PageRecord[]) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {
          pagesTotal: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      } as never);
      for (const page of pages) yield* storage.upsertPage(crawlId, page);
      const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
      const ran = yield* runStreamingRules(
        storage,
        crawlId,
        CONFIG,
        pre.assets
      );
      return ran.ruleResultsMap;
    }).pipe(
      Effect.ensuring(storage.close().pipe(Effect.orDie))
    ) as Effect.Effect<Map<string, never>, never, never>
  );
}

function reportOf(ruleResults: Map<string, unknown>): AuditReport {
  return {
    baseUrl: BASE,
    timestamp: new Date().toISOString(),
    totalPages: PRODUCTS + 3,
    ruleResults,
  } as unknown as AuditReport;
}

type Check = {
  name: string;
  status: string;
  items?: Array<{ id: string; meta?: Record<string, unknown> }>;
};

describe("Nut Shop regression fixtures over a 40-page site", () => {
  test("a footer link that 404s on every page is ONE finding linked from every page", async () => {
    const results = await audit(site({ productLang: true }));
    const checks = (
      results.get("links/broken-links") as unknown as { checks: Check[] }
    ).checks.filter((c) => c.name === "broken-links");
    expect(checks.map((c) => c.status)).toEqual(["fail"]);
    expect(checks[0]!.items).toHaveLength(1);
    expect(checks[0]!.items![0]!.id).toBe(`${BASE}/legal/old-terms`);
    // Every page that carries the footer: home, about, the 37 products and the 404 page's own template.
    expect(checks[0]!.items![0]!.meta?.linkedFrom).toBe(PRODUCTS + 3);

    // The report groups it as one check, and the diff sees one finding, not one per page.
    const groups = groupIssuesByCategory(results as never)
      .flatMap((c) => c.rules)
      .filter((r) => r.id === "links/broken-links");
    expect(
      groups.flatMap((r) => r.checks.filter((c) => c.status === "fail"))
    ).toHaveLength(1);
    const instances = buildIssueInstances(reportOf(results)).filter(
      (i) => i.ruleId === "links/broken-links"
    );
    expect(instances).toHaveLength(1);
  }, 30_000);

  test("a missing meta description on 37 product pages is ONE finding listing 37 pages", async () => {
    const results = await audit(site({ productLang: true }));
    const rules = groupIssuesByCategory(results as never)
      .flatMap((c) => c.rules)
      .filter((r) => r.id === "core/meta-description");
    const missing = rules
      .flatMap((r) => r.checks)
      .filter((c) => c.status !== "pass");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.count).toBe(PRODUCTS);
    expect(new Set(missing[0]!.pages).size).toBe(PRODUCTS);
    expect(missing[0]!.pages.every((p) => p.includes("/products/"))).toBe(true);
  }, 30_000);

  test("a fixed lang fault that comes back is reported as new rows", async () => {
    const broken = reportOf(await audit(site({ productLang: false })));
    const fixed = reportOf(await audit(site({ productLang: true })));
    const regressed = reportOf(await audit(site({ productLang: false })));

    const langOf = <T extends { ruleId: string }>(rows: T[]) =>
      rows.filter((r) => r.ruleId === "i18n/lang-attribute");
    const fix = diffReports(broken, fixed);
    expect(langOf(fix.removed)).toHaveLength(PRODUCTS);
    expect(langOf(fix.added)).toHaveLength(0);

    const back = diffReports(fixed, regressed);
    // Not "unchanged": every product page's lang fault is a NEW row against the fixed audit.
    expect(langOf(back.added)).toHaveLength(PRODUCTS);
    expect(langOf(back.removed)).toHaveLength(0);
    // And they are the same rows the first audit had, so nothing about them is page-order luck.
    const first = new Set(
      langOf(buildIssueInstances(broken)).map((r) => r.fingerprint)
    );
    expect(langOf(back.added).every((r) => first.has(r.fingerprint))).toBe(
      true
    );
  }, 60_000);
});
