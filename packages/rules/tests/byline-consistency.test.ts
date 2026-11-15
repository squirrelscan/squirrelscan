// eeat/byline-consistency: pages that break the site's own byline convention (#1364).
//
// The rule's value is mostly in what it does NOT say, so most of this file defends
// the silence cases: a small crawl, a page type with too few pages, a mixed group,
// and a site that never uses bylines at all. The positive cases pin the one thing
// it is for: a page without the byline or date that its page type carries almost
// everywhere else. The precedence block proves such a page is reported once, here,
// and not again by eeat/author-byline or eeat/content-dates.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import { authorBylineRule } from "../src/eeat/author-byline";
import { ISSUE_PENALTY_THRESHOLD } from "@squirrelscan/utils/constants";

import {
  BYLINE_CONSISTENCY_RULE_ID,
  BYLINE_NORM_MAX_ITEMS,
  BYLINE_NORM_MIN_GROUP_PAGES,
  BYLINE_NORM_MIN_PAGES,
  bylineConsistencyDeviants,
  bylineConsistencyRule,
} from "../src/eeat/byline-consistency";
import { contentDatesRule } from "../src/eeat/content-dates";
import { rules as eeatRules } from "../src/eeat";
import { getAllRuleIds, type RuleNamespace } from "../src/loader";
import { RuleRunner } from "../src/runner";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

interface PageSpec {
  pageType: string | null;
  author?: boolean;
  date?: boolean;
  status?: number;
  /** Meta robots noindex (legacy parsed meta) / robotsNoindex (streaming row). */
  noindex?: boolean;
  /** JSON-LD Article type with no author or dates: content to the per-page rules. */
  articleSchema?: boolean;
}

function url(i: number): string {
  return `https://example.com/blog/p${String(i).padStart(3, "0")}`;
}

/** N pages of one type with the same byline state. */
function pages(count: number, spec: PageSpec): PageSpec[] {
  return Array.from({ length: count }, () => ({ ...spec }));
}

const baseCtx = {
  page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as ParsedPage,
  options: {},
};

function parsedFor(spec: PageSpec): ParsedPage {
  return {
    pageType: spec.pageType,
    visibleAuthor: spec.author ? "Jane Writer" : null,
    visibleDatePublished: spec.date ? "2026-01-02" : null,
    visibleDateModified: null,
    author: null,
    schema: { types: spec.articleSchema ? ["Article"] : [], raw: null },
    meta: { robots: spec.noindex ? "noindex,follow" : null },
  } as unknown as ParsedPage;
}

/** Legacy path: specs become `ctx.site.pages` in crawl (url ascending) order. */
function legacyCtx(
  specs: PageSpec[],
  opts: { siteIndexable?: boolean; ruleEnabled?: (id: string) => boolean } = {},
): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: "https://example.com/",
      pages: specs.map((spec, i) => ({
        url: url(i),
        statusCode: spec.status ?? 200,
        parsed: parsedFor(spec),
        headers: {} as Record<string, string>,
      })),
      robotsTxt: null,
      sitemaps: null,
      siteIndexable: opts.siteIndexable,
    },
    ...(opts.ruleEnabled ? { ruleEnabled: opts.ruleEnabled } : {}),
  };
}

function featureRow(spec: PageSpec, i: number): PageFeatureRow {
  return {
    normalizedUrl: url(i),
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: spec.pageType,
    schemaTypes: [],
    robotsNoindex: !!spec.noindex,
    canonical: null,
    visibleAuthor: !!spec.author,
    visibleDate: !!spec.date,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: !!spec.noindex,
    indexableReasons: [],
    richResultTypes: [],
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
    faviconHref: null,
    themeColor: null,
    ogImage: null,
    hreflangAlternates: null,
    reportScalars: null,
  };
}

/**
 * Streaming path: the rule only ever calls `pagesMatching` + `pageCount`, so the
 * rest of the SiteQuery surface throws. A stub that silently returned empties
 * could hide the rule reading something it must not.
 */
function siteQueryCtx(specs: PageSpec[], siteIndexable?: boolean): RuleContext {
  const rows = specs.map(featureRow);
  const unused = (): never => {
    throw new Error("byline-consistency must not use this SiteQuery method");
  };
  const siteQuery: SiteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    contextualIncomingLinkCounts: unused,
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
    // EMPTY pages: the streaming path must not read them.
    site: {
      baseUrl: "https://example.com/",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      siteIndexable,
    },
    siteQuery,
  };
}

async function checks(rule: Rule, ctx: RuleContext): Promise<CheckResult[]> {
  return (await Promise.resolve(rule.run(ctx))).checks;
}

/** Run BOTH paths over one fixture, assert byte-identical output, return it. */
async function bothPaths(specs: PageSpec[], siteIndexable?: boolean): Promise<CheckResult> {
  const legacy = await checks(bylineConsistencyRule, legacyCtx(specs, { siteIndexable }));
  const streamed = await checks(bylineConsistencyRule, siteQueryCtx(specs, siteIndexable));
  expect(streamed).toEqual(legacy);
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

const BYLINED = { pageType: "article", author: true, date: true } as const;

describe("eeat/byline-consistency: registration", () => {
  test("is registered through the eeat namespace in the loader", () => {
    expect(getAllRuleIds()).toContain(BYLINE_CONSISTENCY_RULE_ID);
    expect(eeatRules).toContain(bylineConsistencyRule);
    expect(bylineConsistencyRule.meta.scope).toBe("site");
    expect(bylineConsistencyRule.meta.category).toBe("eeat");
  });

  test("is weighted lighter than the per-page E-E-A-T rules it can overlap", () => {
    expect(bylineConsistencyRule.meta.weight).toBeLessThan(authorBylineRule.meta.weight);
    expect(bylineConsistencyRule.meta.weight).toBeLessThan(contentDatesRule.meta.weight);
  });
});

describe("eeat/byline-consistency: silence guards (skipped)", () => {
  test("skips a crawl below the site page floor", async () => {
    const specs = [...pages(BYLINE_NORM_MIN_PAGES - 2, BYLINED), { pageType: "article" }];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${BYLINE_NORM_MIN_PAGES} needed`);
  });

  test("skips a single-page site", async () => {
    const check = await bothPaths([{ pageType: "article" }]);
    expect(check.status).toBe("skipped");
  });

  test("skips when no page type has enough comparable pages", async () => {
    const specs = [
      ...pages(BYLINE_NORM_MIN_GROUP_PAGES - 1, BYLINED),
      ...pages(BYLINE_NORM_MIN_GROUP_PAGES - 1, { pageType: "product" }),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${BYLINE_NORM_MIN_GROUP_PAGES}+ comparable pages`);
  });

  test("a site that never uses bylines stays clean (no-false-positive fixture)", async () => {
    const specs = [
      ...pages(20, { pageType: "article" }),
      ...pages(12, { pageType: "product" }),
      { pageType: "home" },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("no byline convention");
    expect(check.items).toBeUndefined();
    // And so nothing is handed to the per-page rules as a deviant.
    const deviants = bylineConsistencyDeviants(legacyCtx(specs).site);
    expect(deviants.author.size).toBe(0);
    expect(deviants.date.size).toBe(0);
  });

  test("skips a mixed group below the agreement threshold", async () => {
    // 6 of 10 = 60%: half the site bylines, half does not. No convention.
    const specs = [...pages(6, BYLINED), ...pages(4, { pageType: "article" })];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
  });

  test("unknown and untyped pages never vote", async () => {
    const specs = [
      ...pages(12, { pageType: "unknown", author: true, date: true }),
      ...pages(12, { pageType: null, author: true, date: true }),
      { pageType: "unknown" },
      { pageType: null },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
  });
});

describe("eeat/byline-consistency: verdicts", () => {
  test("passes when every page of the type follows its convention", async () => {
    const check = await bothPaths(pages(12, BYLINED));
    expect(check.status).toBe("pass");
    expect(check.message).toContain("article author 100%");
    expect(check.message).toContain("article date 100%");
    expect(check.value).toBe(12);
  });

  test("warns on the few pages that break a clear convention, and states it", async () => {
    // 19 of 20 articles carry a visible author and date; one does not.
    const specs = [...pages(19, BYLINED), { pageType: "article" }];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.value).toBe(1);
    expect(check.message).toBe(
      "1 of 20 page(s) break the site's own byline convention (article author 95%, article date 95%)",
    );
    expect(check.items).toHaveLength(2);
    expect(check.items![0]!.id).toBe("article:author");
    expect(check.items![0]!.label).toBe(
      "1 of 20 article page(s) have no visible author byline, which 19 (95%) of article pages carry",
    );
    expect(check.items![0]!.sourcePages).toEqual([url(19)]);
    expect(check.items![1]!.id).toBe("article:date");
    expect(check.items![1]!.label).toContain("have no visible date");
  });

  test("judges author and date independently", async () => {
    // Every article is dated; 18 of 20 have an author.
    const specs = [
      ...pages(18, BYLINED),
      ...pages(2, { pageType: "article", date: true }),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items![0]!.meta).toEqual({
      pageType: "article",
      signal: "author",
      convention: 0.9,
      pageCount: 2,
    });
  });

  test("fails when the breaks reach the fail share", async () => {
    // 7 of 10 = exactly the 70% convention; 3 of 10 pages (30%) break it.
    const specs = [...pages(7, BYLINED), ...pages(3, { pageType: "article" })];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.value).toBe(3);
  });

  test("never reports a page that HAS a byline, even in a mostly unbylined type", async () => {
    // Products rarely carry bylines; the two that do are not deviants. Articles do.
    const specs = [
      ...pages(10, { pageType: "product" }),
      ...pages(2, { pageType: "product", author: true, date: true }),
      ...pages(10, BYLINED),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.message).not.toContain("product");
  });

  test("conventions are per page type", async () => {
    const specs = [
      ...pages(10, { pageType: "product" }),
      ...pages(9, BYLINED),
      { pageType: "article" },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    for (const item of check.items!) expect(item.meta?.pageType).toBe("article");
  });

  test("ignores non-2xx pages", async () => {
    const specs = [...pages(12, BYLINED), { pageType: "article", status: 404 }];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("leaves noindex pages out on an indexable site, but judges them otherwise", async () => {
    const specs = [...pages(12, BYLINED), { pageType: "article", noindex: true }];
    expect((await bothPaths(specs, true)).status).toBe("pass");
    expect((await bothPaths(specs, undefined)).status).toBe("warn");
  });

  test("output does not depend on crawl order", async () => {
    const specs = [
      ...pages(9, BYLINED),
      { pageType: "article" },
      ...pages(9, { pageType: "recipe", author: true, date: true }),
      { pageType: "recipe", date: true },
    ];
    const forward = await bothPaths(specs);
    const reversedLegacy = await checks(
      bylineConsistencyRule,
      // Same urls, reversed crawl order.
      (() => {
        const ctx = legacyCtx(specs);
        ctx.site!.pages.reverse();
        return ctx;
      })(),
    );
    expect(JSON.stringify(reversedLegacy[0])).toBe(JSON.stringify(forward));
  });

  test("caps items and urls", async () => {
    // Six page types, each with 30 of 40 pages bylined (75%): twelve broken
    // conventions, ten deviant pages each.
    const types = ["article", "event", "media", "profile", "recipe", "faq"];
    const specs = types.flatMap((pageType) => [
      ...pages(30, { pageType, author: true, date: true }),
      ...pages(10, { pageType }),
    ]);
    const check = await bothPaths(specs);
    expect(check.items).toHaveLength(BYLINE_NORM_MAX_ITEMS);
    expect(check.details?.brokenConventions).toBe(12);
    expect(check.details!.norms as unknown[]).toHaveLength(12);
    for (const item of check.items!) expect(item.sourcePages).toHaveLength(10);
  });

  test("a fail alone never reaches the scorer's issue-density threshold", () => {
    // Each item of a failed check is one issue unit (audit-engine scoring, #683).
    expect(BYLINE_NORM_MAX_ITEMS).toBeLessThan(ISSUE_PENALTY_THRESHOLD);
  });
});

describe("eeat/byline-consistency: precedence over the per-page E-E-A-T rules", () => {
  // 19 bylined, dated articles and one with neither (its Article schema carries no
  // author or date). author-byline and content-dates would each count the last
  // article as missing; byline-consistency reports it. It must be reported once.
  const specs = [...pages(19, BYLINED), { pageType: "article", articleSchema: true }];
  const deviant = url(19);

  test("the deviant page is reported by byline-consistency", async () => {
    const check = await bothPaths(specs);
    expect(check.items!.flatMap((i) => i.sourcePages ?? [])).toContain(deviant);
  });

  test("eeat/author-byline does not count the page byline-consistency reports", async () => {
    const [check] = await checks(authorBylineRule, legacyCtx(specs));
    expect(check!.status).toBe("pass");
    expect(check!.message).toBe("100% of content pages have author attribution");
    expect(check!.value).toBe("19/19 pages");
    expect(check!.details).toEqual({ deferredToBylineConsistency: 1 });
  });

  test("eeat/content-dates does not count the page byline-consistency reports", async () => {
    const result = await checks(contentDatesRule, legacyCtx(specs));
    const published = result.find((c) => c.name === "date-published")!;
    expect(published.status).toBe("pass");
    expect(published.message).toBe("100% of content has datePublished");
    expect(published.details).toEqual({ deferredToBylineConsistency: 1 });
  });

  test("with byline-consistency disabled, the per-page rules count the page again", async () => {
    const disabled = (id: string): boolean => id !== BYLINE_CONSISTENCY_RULE_ID;
    const [author] = await checks(authorBylineRule, legacyCtx(specs, { ruleEnabled: disabled }));
    expect(author!.value).toBe("19/20 pages");
    expect(author!.details).toBeUndefined();
    const dates = await checks(contentDatesRule, legacyCtx(specs, { ruleEnabled: disabled }));
    expect(dates.find((c) => c.name === "date-published")!.message).toBe(
      "95% of content has datePublished",
    );
  });

  test("a page breaking no convention is still the per-page rule's", async () => {
    // No convention (6 of 10): nothing deferred, author-byline counts all 10.
    const mixed = [...pages(6, BYLINED), ...pages(4, { pageType: "article" })];
    const [author] = await checks(authorBylineRule, legacyCtx(mixed));
    expect(author!.value).toBe("Consider adding authors to more content");
    expect(author!.message).toBe("60% of content pages have author attribution");
    expect(author!.details).toBeUndefined();
  });
});

describe("eeat/byline-consistency: precedence through the real runner", () => {
  const specs = [...pages(19, BYLINED), { pageType: "article", articleSchema: true }];
  const deviant = url(19);

  let observed: boolean | undefined;
  // Reset and read through functions so TS does not narrow `observed` to the
  // reset value across the awaited runs that assign it from the probe.
  const reset = (): void => {
    observed = undefined;
  };
  const read = (): boolean | undefined => observed;
  const probe: Rule = {
    meta: {
      id: "test/rule-enabled-probe",
      name: "ruleEnabled probe (test)",
      description: "records ctx.ruleEnabled for byline-consistency",
      category: "eeat",
      scope: "site",
      severity: "info",
      weight: 1,
    },
    run(ctx) {
      observed = ctx.ruleEnabled?.(BYLINE_CONSISTENCY_RULE_ID);
      return { checks: [{ name: "probe", status: "pass", message: "ok" }] };
    },
  };
  const testNamespace: RuleNamespace = { name: "test", rules: [probe] };

  function runner(enable: string[], disable: string[] = []): RuleRunner {
    return new RuleRunner({
      config: { rule_options: {}, rules: { enable, disable } },
      additionalNamespaces: [testNamespace],
    });
  }

  test("ctx.ruleEnabled reflects the run's resolved rule set", async () => {
    const site = legacyCtx(specs).site!;
    reset();
    await runner(["test/*", BYLINE_CONSISTENCY_RULE_ID]).runSiteRules(site);
    expect(read()).toBe(true);
    reset();
    await runner(["test/*"]).runSiteRules(site);
    expect(read()).toBe(false);
    reset();
    await runner(["*"], [BYLINE_CONSISTENCY_RULE_ID]).runSiteRules(site);
    expect(read()).toBe(false);
  });

  test("a deviant page is reported once across the E-E-A-T rules", async () => {
    const result = await runner(["eeat/*"]).runSiteRules(legacyCtx(specs).site!);
    const byline = result.ruleResults.get(BYLINE_CONSISTENCY_RULE_ID)!.checks[0]!;
    expect(byline.status).toBe("warn");
    expect(byline.items!.flatMap((i) => i.sourcePages ?? [])).toContain(deviant);
    const author = result.ruleResults.get("eeat/author-byline")!.checks[0]!;
    expect(author.value).toBe("19/19 pages");
    expect(author.details).toEqual({ deferredToBylineConsistency: 1 });
    const published = result.ruleResults
      .get("eeat/content-dates")!
      .checks.find((c) => c.name === "date-published")!;
    expect(published.status).toBe("pass");
    expect(published.details).toEqual({ deferredToBylineConsistency: 1 });
  });

  test("with byline-consistency excluded from the run, the per-page rules report the page", async () => {
    const result = await runner(["eeat/*"], [BYLINE_CONSISTENCY_RULE_ID]).runSiteRules(
      legacyCtx(specs).site!,
    );
    expect(result.ruleResults.has(BYLINE_CONSISTENCY_RULE_ID)).toBe(false);
    const author = result.ruleResults.get("eeat/author-byline")!.checks[0]!;
    expect(author.value).toBe("19/20 pages");
    expect(author.details).toBeUndefined();
  });
});
