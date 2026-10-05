// Index-presentation rules skip noindex pages, pub#457.
//
// A page its owner keeps out of the index (robots meta or X-Robots-Tag noindex)
// was still graded on its title, description, H1, duplicate titles and orphan
// status. Those rules now skip it: three page rules through the runner's
// `skipOnNoindex` gate, four site rules by leaving noindex pages out of their page
// set. When the homepage itself is noindex (a staging or preview host) nothing is
// skipped, and the publish resolution signal treats a noindex skip as a verdict so
// an old finding on that page resolves instead of being carried forever.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { resolutionCheckKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { parsePage } from "@squirrelscan/parser";
import { normalizeUrl } from "@squirrelscan/utils/url";

import { duplicateDescriptionRule } from "../src/content/duplicate-description";
import { DEFAULT_FOLD_LIMITS, foldOverflowChecks } from "../src/fold";
import { duplicateTitleRule } from "../src/content/duplicate-title";
import { titleUniqueRule } from "../src/core/title-unique";
import { orphanPagesRule } from "../src/links/orphan-pages";
import { loadAllRules } from "../src/loader";
import { buildResolutionSignal } from "../src/resolution";
import { RuleRunner, type RulesConfig } from "../src/runner";
import { isSiteIndexable, noindexSource } from "../src/shared/noindex";
import type { PageData, ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

const GATED = ["core/meta-title", "core/meta-description", "core/h1"];
// Rules that must keep running on a noindex page.
const UNGATED = [
  "a11y/landmark-one-main",
  "security/https",
  "core/robots-meta",
  "crawl/indexability",
];

function html(opts: { robots?: string; title?: string; description?: string; h1?: string }) {
  const robots = opts.robots ? `<meta name="robots" content="${opts.robots}">` : "";
  const desc = opts.description ? `<meta name="description" content="${opts.description}">` : "";
  const h1 = opts.h1 ? `<h1>${opts.h1}</h1>` : "";
  return `<!doctype html><html lang="en"><head><title>${opts.title ?? "Short"}</title>${robots}${desc}</head><body>${h1}<p>text</p></body></html>`;
}

function pageData(url: string, body: string, headers: Record<string, string> = {}): PageData {
  return { url, html: body, statusCode: 200, loadTime: 0, headers };
}

function makeRunner(enable: string[]): RuleRunner {
  const config: RulesConfig = { rule_options: {}, rules: { enable } };
  return new RuleRunner({ config });
}

function site(siteIndexable?: boolean): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: [],
    robotsTxt: null,
    sitemaps: null,
    ...(siteIndexable === undefined ? {} : { siteIndexable }),
  };
}

async function runPage(page: PageData, siteData?: SiteData) {
  const { ruleResults } = await makeRunner([...GATED, ...UNGATED]).runPageRules(page, siteData);
  return (id: string): CheckResult[] => ruleResults.get(id)?.checks ?? [];
}

describe("the skip list is explicit and conservative", () => {
  test("exactly core/meta-title, core/meta-description and core/h1 declare skipOnNoindex", () => {
    const declared = [...loadAllRules().values()]
      .filter((r) => r.meta.skipOnNoindex)
      .map((r) => r.meta.id)
      .sort();
    expect(declared).toEqual(["core/h1", "core/meta-description", "core/meta-title"]);
  });

  test("no accessibility, security, performance or link rule declares it", () => {
    for (const rule of loadAllRules().values()) {
      if (["a11y", "security", "perf", "links"].includes(rule.meta.category)) {
        expect(rule.meta.skipOnNoindex).toBeUndefined();
      }
    }
  });
});

describe("runner noindex gate", () => {
  test("meta noindex: gated rules skip naming the meta tag, the rest still run", async () => {
    const checks = await runPage(
      pageData("https://example.com/thanks", html({ robots: "noindex,nofollow" })),
      site(true),
    );
    for (const id of GATED) {
      expect(checks(id)).toEqual([
        {
          name: id,
          status: "skipped",
          message: "Skipped: page is set to noindex via robots meta tag",
          skipReason: "noindex",
          details: { foldKey: "noindex" },
        },
      ]);
    }
    for (const id of UNGATED) {
      expect(checks(id).length).toBeGreaterThan(0);
      expect(checks(id).every((c) => c.skipReason !== "noindex")).toBe(true);
    }
  });

  test("X-Robots-Tag noindex, including the googlebot-scoped form, skips naming the header", async () => {
    for (const value of ["noindex", "googlebot: noindex"]) {
      const checks = await runPage(
        pageData("https://example.com/hdr", html({}), { "x-robots-tag": value }),
        site(true),
      );
      for (const id of GATED) {
        expect(checks(id)[0]?.status).toBe("skipped");
        expect(checks(id)[0]?.message).toBe(
          "Skipped: page is set to noindex via X-Robots-Tag header",
        );
      }
    }
  });

  test("an indexable page runs every rule", async () => {
    const checks = await runPage(pageData("https://example.com/a", html({})), site(true));
    for (const id of GATED) {
      expect(checks(id).length).toBeGreaterThan(0);
      expect(checks(id).some((c) => c.status === "skipped")).toBe(false);
    }
  });

  test("a noindex homepage (staging or preview host) keeps every rule running", async () => {
    const checks = await runPage(
      pageData("https://example.com/thanks", html({ robots: "noindex" })),
      site(false),
    );
    for (const id of GATED) {
      expect(checks(id).some((c) => c.status === "skipped")).toBe(false);
    }
    expect(checks("core/h1")[0]?.status).toBe("fail");
  });

  test("an unknown site (no SiteData, or siteIndexable unset) skips nothing", async () => {
    const page = pageData("https://example.com/x", html({ robots: "noindex" }));
    for (const siteData of [undefined, site()]) {
      const checks = await runPage(page, siteData);
      expect(checks("core/h1")[0]?.status).toBe("fail");
    }
  });

  test("index, follow is not noindex", async () => {
    const checks = await runPage(
      pageData("https://example.com/x", html({ robots: "index, follow" })),
      site(true),
    );
    expect(checks("core/h1")[0]?.status).toBe("fail");
  });
});

describe("noindexSource and isSiteIndexable", () => {
  const parsed = (body: string) => parsePage(body, "https://example.com/") as ParsedPage;
  const noindex = { statusCode: 200, parsed: parsed(html({ robots: "noindex" })) };
  const indexable = { statusCode: 200, parsed: parsed(html({})) };
  const BASE_URL = "https://example.com";

  test("meta wins over header when both are set; nothing is null", () => {
    expect(noindexSource(parsed(html({ robots: "noindex" })), { "x-robots-tag": "noindex" })).toBe(
      "robots meta tag",
    );
    expect(noindexSource(parsed(html({})), { "x-robots-tag": "noindex" })).toBe(
      "X-Robots-Tag header",
    );
    expect(noindexSource(parsed(html({})), {})).toBeNull();
    expect(noindexSource(null, { "x-robots-tag": "noindex" })).toBeNull();
  });

  test("the homepage decides: noindex (meta or header) is false, indexable is true", () => {
    expect(isSiteIndexable([{ url: "https://example.com/", ...noindex }], BASE_URL)).toBe(false);
    expect(
      isSiteIndexable(
        [{ url: "https://example.com/", ...indexable, headers: { "x-robots-tag": "noindex" } }],
        BASE_URL,
      ),
    ).toBe(false);
    // One noindex page elsewhere does not make the site noindex.
    expect(
      isSiteIndexable(
        [
          { url: "https://example.com/", ...indexable },
          { url: "https://example.com/thanks", ...noindex },
        ],
        BASE_URL,
      ),
    ).toBe(true);
  });

  test("a noindex query page or another host's root never stands in for the homepage", () => {
    // An internal search page at /?s=term is commonly noindex.
    expect(
      isSiteIndexable(
        [
          { url: "https://example.com/", ...indexable },
          { url: "https://example.com/?s=term", ...noindex },
        ],
        BASE_URL,
      ),
    ).toBe(true);
    expect(isSiteIndexable([{ url: "https://cdn.example.net/", ...noindex }], BASE_URL)).toBe(
      undefined,
    );
    // www and apex, http and https are the same homepage.
    expect(isSiteIndexable([{ url: "http://www.example.com/", ...noindex }], BASE_URL)).toBe(false);
  });

  test("without a fetched homepage the entry page decides, matched by url or final url", () => {
    const deep = (extra: object) => ({ url: "https://example.com/docs/start", ...extra });
    expect(isSiteIndexable([deep(noindex)], BASE_URL, ["https://example.com/docs/start"])).toBe(
      false,
    );
    expect(isSiteIndexable([deep(indexable)], BASE_URL, ["https://example.com/docs/start"])).toBe(
      true,
    );
    expect(
      isSiteIndexable(
        [{ ...deep(indexable), finalUrl: "https://example.com/docs/start/" }],
        BASE_URL,
        [undefined, "https://example.com/docs/start/"],
      ),
    ).toBe(true);
    // A homepage that answered with an error is not fetched: the entry page decides.
    expect(
      isSiteIndexable(
        [{ url: "https://example.com/", ...indexable, statusCode: 500 }, deep(noindex)],
        BASE_URL,
        ["https://example.com/docs/start"],
      ),
    ).toBe(false);
    // An unparseable base still lets the entry page decide.
    expect(
      isSiteIndexable([deep(indexable)], "not a url", ["https://example.com/docs/start"]),
    ).toBe(true);
  });

  test("neither the homepage nor the entry page fetched is unknown", () => {
    expect(isSiteIndexable([], BASE_URL)).toBeUndefined();
    expect(
      isSiteIndexable([{ url: "https://example.com/docs/a", ...noindex }], BASE_URL, [
        "https://example.com/docs/missing",
      ]),
    ).toBeUndefined();
    expect(
      isSiteIndexable(
        [{ url: "https://example.com/docs/start", ...indexable, statusCode: 404 }],
        BASE_URL,
        ["https://example.com/docs/start"],
      ),
    ).toBeUndefined();
  });
});

// ── site rules, legacy `site.pages` path (the streaming path is covered in
// audit-engine's noindex-site-rules-dual-path test) ─────────────────────────────

const BASE = "https://example.com/";

function sitePage(
  path: string,
  opts: {
    title?: string;
    description?: string;
    robots?: string;
    header?: string;
    links?: string[];
  },
) {
  const url = `https://example.com${path}`;
  const parsed = {
    meta: {
      title: opts.title ?? null,
      description: opts.description ?? null,
      robots: opts.robots ?? null,
    },
    links: (opts.links ?? []).map((href) => ({ url: href, text: "l", isInternal: true })),
  } as unknown as ParsedPage;
  return {
    url,
    statusCode: 200,
    parsed,
    headers: opts.header ? { "x-robots-tag": opts.header } : {},
  };
}

// Two indexable pages sharing a title/description, and two noindex pages (meta,
// header) sharing the same title/description with them and with each other.
const PAGES = [
  sitePage("/", { title: "Home", description: "Home page", links: ["/a", "/a", "/b", "/b"] }),
  sitePage("/a", { title: "Shared", description: "Shared desc", links: ["/b"] }),
  sitePage("/b", { title: "Shared", description: "Shared desc", links: ["/a"] }),
  sitePage("/meta", { title: "Hidden", description: "Hidden desc", robots: "noindex" }),
  sitePage("/hdr", { title: "Hidden", description: "Hidden desc", header: "googlebot: noindex" }),
];

async function runSiteRule(
  rule: Rule,
  siteIndexable: boolean | undefined,
  options: Record<string, unknown> = {},
) {
  const ctx: RuleContext = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: PAGES, robotsTxt: null, sitemaps: null, siteIndexable },
    options,
  };
  return (await Promise.resolve(rule.run(ctx))).checks[0]!;
}

const itemPages = (c: CheckResult) => (c.items ?? []).map((i) => i.sourcePages);

describe("site rules leave noindex pages out", () => {
  test("content/duplicate-title", async () => {
    const c = await runSiteRule(duplicateTitleRule, true);
    expect(c.message).toBe("1 duplicate title(s) found across 2 pages");
    expect(itemPages(c)).toEqual([["https://example.com/a", "https://example.com/b"]]);

    const all = await runSiteRule(duplicateTitleRule, false);
    expect(all.message).toBe("2 duplicate title(s) found across 4 pages");
    // Unknown (neither homepage nor entry page fetched) counts every page too.
    const unknown = await runSiteRule(duplicateTitleRule, undefined);
    expect(unknown.message).toBe("2 duplicate title(s) found across 4 pages");
  });

  test("content/duplicate-description", async () => {
    const c = await runSiteRule(duplicateDescriptionRule, true);
    expect(c.message).toBe("1 duplicate description(s) found across 2 pages");
    const all = await runSiteRule(duplicateDescriptionRule, false);
    expect(all.message).toBe("2 duplicate description(s) found across 4 pages");
  });

  test("core/title-unique", async () => {
    const c = await runSiteRule(titleUniqueRule, true);
    expect(c.message).toBe("1 duplicate title(s) affecting 2 pages");
    const all = await runSiteRule(titleUniqueRule, false);
    expect(all.message).toBe("2 duplicate title(s) affecting 4 pages");
  });

  test("links/orphan-pages", async () => {
    const options = { minInboundLinks: 2, excludePatterns: [] };
    const c = await runSiteRule(orphanPagesRule, true, options);
    // /a and /b have 3 inbound each; /meta and /hdr have none but are noindex.
    expect(c.status).toBe("pass");
    const all = await runSiteRule(orphanPagesRule, false, options);
    expect(all.status).toBe("warn");
    expect((all.items ?? []).map((i) => i.id)).toEqual([
      "https://example.com/meta",
      "https://example.com/hdr",
    ]);
  });
});

describe("resolution signal: a noindex skip resolves, it does not carry", () => {
  const P1 = "https://x.test/";
  const P2 = "https://x.test/thanks";
  const h = (url: string) => resolutionUrlHash(normalizeUrl(url));

  test("the skipped page counts as evaluated for every key the rule emits", () => {
    const signal = buildResolutionSignal(
      {
        "core/h1": {
          checks: [
            { name: "h1", status: "fail", message: "No H1 tag found", pageUrl: P1 },
            {
              name: "core/h1",
              status: "skipped",
              message: "Skipped: page is set to noindex via robots meta tag",
              skipReason: "noindex",
              pageUrl: P2,
            },
          ],
        },
      },
      [P1, P2],
    )!;
    expect(signal.failing[resolutionCheckKey("core/h1", "h1")]).toEqual([h(P1)]);
    // P2 is NOT listed as not-evaluated, so a prior "No H1" on it resolves.
    expect(signal.notEvaluated?.[resolutionCheckKey("core/h1", "h1")]).toBeUndefined();
  });

  test("only the skipped page is marked: other pages of the same rule are untouched", () => {
    const P3 = "https://x.test/unchecked";
    const signal = buildResolutionSignal(
      {
        "core/h1": {
          checks: [
            { name: "h1", status: "fail", message: "No H1 tag found", pageUrl: P1 },
            {
              name: "core/h1",
              status: "skipped",
              message: "x",
              skipReason: "noindex",
              details: { foldKey: "noindex" },
              pageUrl: P2,
            },
          ],
        },
      },
      // P3 was crawled but the rule produced nothing for it.
      [P1, P2, P3],
    )!;
    expect(signal.failing[resolutionCheckKey("core/h1", "h1")]).toEqual([h(P1)]);
    expect(signal.notEvaluated?.[resolutionCheckKey("core/h1", "h1")]).toEqual([h(P3)]);
  });

  test("a folded aggregate of noindex skips counts the same way", () => {
    const signal = buildResolutionSignal(
      {
        "core/h1": {
          checks: [
            { name: "h1", status: "pass", message: "ok", pageUrl: P1 },
            {
              name: "core/h1",
              status: "skipped",
              message: "Skipped: page is set to noindex via robots meta tag",
              skipReason: "noindex",
              pages: [P2],
              details: { aggregated: true, foldKey: "noindex" },
            },
          ],
        },
      },
      [P1, P2],
    )!;
    expect(signal.notEvaluated?.[resolutionCheckKey("core/h1", "h1")]).toBeUndefined();
  });

  test("folding keeps noindex skips apart from another gate's skips of the same rule", () => {
    const P3 = "https://x.test/gone";
    const skip = (url: string, reason: string, foldKey?: string): CheckResult => ({
      name: "core/h1",
      status: "skipped",
      message: reason,
      skipReason: reason,
      pageUrl: url,
      ...(foldKey ? { details: { foldKey } } : {}),
    });
    // A soft-404 skip first, so an untyped group would keep ITS reason; then two
    // noindex skips shaped exactly as the runner emits them.
    const folded = foldOverflowChecks(
      [
        { name: "h1", status: "fail", message: "No H1 tag found", pageUrl: P1 },
        skip(P3, "soft-404"),
        skip(P2, "noindex", "noindex"),
        skip("https://x.test/thanks-2", "noindex", "noindex"),
      ],
      // Four checks over a cap of three folds each class to one check.
      { ...DEFAULT_FOLD_LIMITS, maxChecks: 3 },
    );
    const noindexAggregate = folded.find((c) => c.skipReason === "noindex");
    expect(noindexAggregate?.details?.aggregated).toBe(true);
    expect(noindexAggregate?.pages).toEqual([P2, "https://x.test/thanks-2"]);

    const signal = buildResolutionSignal({ "core/h1": { checks: folded } }, [
      P1,
      P2,
      P3,
      "https://x.test/thanks-2",
    ])!;
    // Only the soft-404 page is left unevaluated.
    expect(signal.notEvaluated?.[resolutionCheckKey("core/h1", "h1")]).toEqual([h(P3)]);
  });

  test("an aggregate without the noindex fold key is not trusted", () => {
    const signal = buildResolutionSignal(
      {
        "core/h1": {
          checks: [
            { name: "h1", status: "pass", message: "ok", pageUrl: P1 },
            {
              name: "core/h1",
              status: "skipped",
              message: "x",
              skipReason: "noindex",
              pages: [P2],
              details: { aggregated: true },
            },
          ],
        },
      },
      [P1, P2],
    )!;
    expect(signal.notEvaluated?.[resolutionCheckKey("core/h1", "h1")]).toEqual([h(P2)]);
  });

  test("any other skip still carries (soft-404 is not a verdict)", () => {
    const signal = buildResolutionSignal(
      {
        "core/h1": {
          checks: [
            { name: "h1", status: "fail", message: "No H1 tag found", pageUrl: P1 },
            {
              name: "core/h1",
              status: "skipped",
              message: "x",
              skipReason: "soft-404",
              pageUrl: P2,
            },
          ],
        },
      },
      [P1, P2],
    )!;
    expect(signal.notEvaluated?.[resolutionCheckKey("core/h1", "h1")]).toEqual([h(P2)]);
  });

  test("a noindex skip of one rule does not mark another rule's keys", () => {
    const signal = buildResolutionSignal(
      {
        "core/h1": {
          checks: [
            {
              name: "core/h1",
              status: "skipped",
              message: "x",
              skipReason: "noindex",
              pageUrl: P2,
            },
          ],
        },
        "core/meta-title": {
          checks: [{ name: "meta-title", status: "pass", message: "ok", pageUrl: P1 }],
        },
      },
      [P1, P2],
    )!;
    expect(signal.notEvaluated?.[resolutionCheckKey("core/meta-title", "meta-title")]).toEqual([
      h(P2),
    ]);
  });
});
