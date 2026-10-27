// links/no-contextual-inbound — pages linked only from sitewide chrome (#109).
//
// The two fixtures the acceptance criteria name are the first two tests: a page
// linked ONLY from the sitewide footer must warn here and must NOT be reported by
// links/orphan-pages, and a page linked once from body copy must not warn.
// links/orphan-pages runs over the SAME fixtures throughout, so any drift in the
// two rules' division of labour fails here rather than in production.

import { describe, expect, test } from "bun:test";

import { noContextualInboundRule } from "../src/links/no-contextual-inbound";
import { orphanPagesRule } from "../src/links/orphan-pages";
import { weakInternalLinksRule } from "../src/links/weak-internal-links";
import type { CheckResult, ParsedPage, Rule, RuleContext, RuleResult } from "../src/types";
import {
  CRAWL_CAPPED_SKIP_REASON,
  NOT_CHECKED_SKIP_REASONS,
  type LinkData,
} from "@squirrelscan/core-contracts";

const BASE = "https://example.com/";

/** A body-copy (contextual) internal link. */
function body(url: string): LinkData {
  return { url, text: "read more", isInternal: true, isChrome: false };
}
/** A sitewide-chrome internal link (nav/header/footer/aside anchor). */
function chrome(url: string): LinkData {
  return { url, text: "nav", isInternal: true, isChrome: true };
}
/** A link from a crawl stored before `isChrome` existed. */
function legacyLink(url: string): LinkData {
  return { url, text: "old", isInternal: true };
}

interface PageSpec {
  url: string;
  links: LinkData[];
}

function ctx(pages: PageSpec[], options: Record<string, unknown> = {}): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: pages.map((p) => ({
        url: p.url,
        finalUrl: p.url,
        statusCode: 200,
        parsed: { links: p.links } as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
    options: { minInboundLinks: 2, excludePatterns: [], ...options },
  } as unknown as RuleContext;
}

/** All three rules under test are synchronous on the legacy path. */
function check(rule: Rule, c: RuleContext): CheckResult {
  return (rule.run(c) as RuleResult).checks[0]!;
}

function ids(c: CheckResult): string[] {
  return (c.items ?? []).map((i) => String(i.id));
}

// Three content pages all cross-link each other in body copy; /pricing is reached
// ONLY through the sitewide footer that every page carries.
const FOOTER_ONLY: PageSpec[] = [
  { url: BASE, links: [body("/a"), body("/b"), chrome("/pricing")] },
  { url: "https://example.com/a", links: [body("/b"), chrome("/pricing")] },
  { url: "https://example.com/b", links: [body("/a"), chrome("/pricing")] },
  { url: "https://example.com/pricing", links: [chrome("/pricing")] },
];

describe("links/no-contextual-inbound — the acceptance fixtures", () => {
  test("a page linked only from the sitewide footer warns", () => {
    const result = check(noContextualInboundRule, ctx(FOOTER_ONLY));

    expect(result.status).toBe("warn");
    expect(ids(result)).toEqual(["https://example.com/pricing"]);
    expect(result.details).toEqual({ total: 1 });
    expect(result.value).toBe("/pricing");
    expect(result.message).toBe("1 page(s) are linked only from sitewide chrome");
  });

  test("…and links/orphan-pages does NOT report it (the blind spot)", () => {
    // 4 footer links (one per page) put /pricing well above the orphan threshold.
    const orphans = check(orphanPagesRule, ctx(FOOTER_ONLY));
    expect(orphans.status).toBe("pass");
    // Nor does weak-internal-links: its raw count is 4, not 1.
    expect(check(weakInternalLinksRule, ctx(FOOTER_ONLY)).status).toBe("pass");
  });

  test("a page linked once from body copy does not warn", () => {
    // /deep has exactly ONE inbound link, and it is contextual.
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), body("/b")] },
      { url: "https://example.com/a", links: [body("/b"), body("/deep")] },
      { url: "https://example.com/b", links: [body("/a")] },
      { url: "https://example.com/deep", links: [] },
    ];

    const result = check(noContextualInboundRule, ctx(pages));
    expect(result.status).toBe("pass");
    expect(result.message).toBe("All pages have at least one contextual inbound link");

    // It IS an orphan though — that page belongs to orphan-pages, not to us.
    expect(ids(check(orphanPagesRule, ctx(pages)))).toContain("https://example.com/deep");
  });
});

describe("links/no-contextual-inbound — scoping", () => {
  test("the homepage is never flagged even when only chrome links to it", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), body("/b")] },
      { url: "https://example.com/a", links: [chrome(BASE), body("/b")] },
      { url: "https://example.com/b", links: [chrome(BASE), body("/a")] },
    ];
    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
  });

  test("excludePatterns are honoured, same as links/orphan-pages", () => {
    const excluded = ctx(FOOTER_ONLY, { excludePatterns: ["/pricing"] });
    expect(check(noContextualInboundRule, excluded).status).toBe("pass");
  });

  test("a chrome-only page BELOW the orphan threshold is left to orphan-pages", () => {
    // Only one page carries the footer link, so /pricing's raw count is 1 (< 2).
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), chrome("/pricing")] },
      { url: "https://example.com/a", links: [body(BASE)] },
      { url: "https://example.com/pricing", links: [] },
    ];

    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
    expect(ids(check(orphanPagesRule, ctx(pages)))).toContain("https://example.com/pricing");
  });

  test("minInboundLinks moves the handoff point in step with orphan-pages", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), chrome("/pricing")] },
      { url: "https://example.com/a", links: [body(BASE)] },
      { url: "https://example.com/pricing", links: [] },
    ];
    // At a threshold of 1, /pricing (raw 1) is no longer an orphan — so it becomes
    // ours. Neither rule may drop it.
    const opts = { minInboundLinks: 1 };
    expect(check(orphanPagesRule, ctx(pages, opts)).status).toBe("pass");
    expect(ids(check(noContextualInboundRule, ctx(pages, opts)))).toEqual([
      "https://example.com/pricing",
    ]);
  });

  test("nofollow chrome links do not count on either side of the comparison", () => {
    // /pricing's only inbound links are nofollowed chrome → raw 0 → an orphan,
    // not our case.
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), { ...chrome("/pricing"), isNofollow: true }] },
      { url: "https://example.com/a", links: [body(BASE), { ...chrome("/pricing"), isNofollow: true }] },
      { url: "https://example.com/pricing", links: [] },
    ];
    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
  });

  test("a crawl with <2 pages is skipped", () => {
    const result = check(noContextualInboundRule, ctx([{ url: BASE, links: [] }]));
    expect(result.status).toBe("skipped");
  });

  test("links stored without isChrome (pre-#109 crawls) count as contextual", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [legacyLink("/a"), legacyLink("/pricing")] },
      { url: "https://example.com/a", links: [legacyLink("/pricing")] },
      { url: "https://example.com/pricing", links: [] },
    ];
    // Degrades to the pre-#109 behaviour: no site-wide false alarm.
    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
  });

  test("the reported sample is capped at 5 while details.total stays exact", () => {
    // Home links to 7 chrome-only pages; each of the 7 also carries the chrome
    // link, so every one has a raw count of 8 — comfortably above the threshold.
    const targets = Array.from({ length: 7 }, (_, i) => `/c${i}`);
    const chromeLinks = targets.map((t) => chrome(t));
    const pages: PageSpec[] = [
      { url: BASE, links: chromeLinks },
      ...targets.map((t) => ({ url: `https://example.com${t}`, links: chromeLinks })),
    ];

    const result = check(noContextualInboundRule, ctx(pages));
    expect(result.status).toBe("warn");
    expect(result.details).toEqual({ total: 7 });
    expect(ids(result)).toHaveLength(7);
    expect(result.value).toBe("/c0\n/c1\n/c2\n/c3\n/c4\n+2 more");
  });
});

describe("links/no-contextual-inbound — a capped crawl", () => {
  function capped(pagesCrawled: number, maxPages: number): RuleContext {
    const c = ctx(FOOTER_ONLY);
    c.site!.crawlLimits = { pagesCrawled, maxPages };
    return c;
  }

  test("skips when the crawl stopped at its page cap", () => {
    for (const rule of [noContextualInboundRule, orphanPagesRule, weakInternalLinksRule]) {
      const result = check(rule, capped(4, 4));
      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe(CRAWL_CAPPED_SKIP_REASON);
      expect(result.items).toBeUndefined();
    }
  });

  test("the reason is a not-checked one, with the text published reports carry (#1144)", () => {
    expect(CRAWL_CAPPED_SKIP_REASON).toBe("Crawl capped before the frontier was exhausted");
    expect(NOT_CHECKED_SKIP_REASONS.has(CRAWL_CAPPED_SKIP_REASON)).toBe(true);
  });

  test("still warns when the crawl finished under its cap", () => {
    const result = check(noContextualInboundRule, capped(4, 10));
    expect(result.status).toBe("warn");
    expect(ids(result)).toEqual(["https://example.com/pricing"]);
  });
});

// pub#796: a root that redirects to `/en/` lands the crawl on `/en/`, which the
// redirect leads to rather than a link: the site's front door. All three
// inbound-link rules skip it, as they skip the homepage.
describe("the page the crawl started on is never flagged (pub#796)", () => {
  const EN = "https://example.com/en/";
  // /en/ is reached only from every page's logo (chrome): three raw links and
  // no contextual one, so with no exemption it is flagged as chrome-only.
  const pages: PageSpec[] = [
    { url: EN, links: [body("/en/a"), chrome("/en/")] },
    { url: "https://example.com/en/a", links: [body("/en/b"), chrome("/en/")] },
    { url: "https://example.com/en/b", links: [body("/en/a"), chrome("/en/")] },
    { url: "https://example.com/en/c", links: [body("/en/a"), body("/en/b")] },
  ];
  const withEntry = (c: RuleContext): RuleContext => ({
    ...c,
    site: { ...c.site!, entryUrls: [EN, "https://example.com/"] },
  });

  test("no-contextual-inbound: control flags the landing page; with entryUrls it does not", () => {
    expect(ids(check(noContextualInboundRule, ctx(pages)))).toContain(EN);
    expect(ids(check(noContextualInboundRule, withEntry(ctx(pages))))).not.toContain(EN);
  });

  test("weak-internal-links: a landing page linked once is not weak once it is the entry", () => {
    const once: PageSpec[] = [
      { url: EN, links: [body("/en/a")] },
      { url: "https://example.com/en/a", links: [body("/en/")] },
    ];
    expect(ids(check(weakInternalLinksRule, ctx(once)))).toContain(EN);
    expect(ids(check(weakInternalLinksRule, withEntry(ctx(once))))).not.toContain(EN);
  });

  test("orphan-pages: an unlinked landing page is not an orphan once it is the entry", () => {
    const unlinked: PageSpec[] = [
      { url: EN, links: [body("/en/a"), body("/en/b")] },
      { url: "https://example.com/en/a", links: [body("/en/b")] },
      { url: "https://example.com/en/b", links: [body("/en/a")] },
    ];
    expect(ids(check(orphanPagesRule, ctx(unlinked)))).toContain(EN);
    expect(ids(check(orphanPagesRule, withEntry(ctx(unlinked))))).not.toContain(EN);
  });
});

// #2307: where the inbound links sit. A crawl whose links carry a `section` says so; one whose
// links do not keeps the bare items it always had.
describe("links/no-contextual-inbound — link sections", () => {
  /** A footer link: sitewide chrome, in the footer. */
  function footer(url: string): LinkData {
    return { ...chrome(url), section: "footer" };
  }
  /** A navigation link: sitewide chrome, in the navigation. */
  function nav(url: string): LinkData {
    return { ...chrome(url), section: "navigation" };
  }

  // /pricing is linked from the footer on three pages and the navigation on one.
  const SECTIONED: PageSpec[] = [
    { url: BASE, links: [body("/a"), body("/b"), footer("/pricing")] },
    { url: "https://example.com/a", links: [body("/b"), nav("/pricing")] },
    { url: "https://example.com/b", links: [body("/a"), footer("/pricing")] },
    { url: "https://example.com/pricing", links: [footer("/pricing")] },
  ];
  const PRICING = "https://example.com/pricing";

  /** The streaming path's inputs for SECTIONED, by hand: what `createSiteQuery` would hold. */
  function streaming(
    pages: PageSpec[],
    inboundSectionCounts?: () => Map<string, Record<string, number>>
  ): RuleContext {
    const c = ctx(pages);
    const urls = pages.map((p) => p.url);
    const all = new Map(urls.map((u) => [u, 0]));
    const contextual = new Map(urls.map((u) => [u, 0]));
    for (const page of pages) {
      for (const link of page.links) {
        const target = new URL(link.url, page.url).href;
        const key = urls.find((u) => u === target || u === `${target}/`);
        if (key === undefined) continue;
        all.set(key, (all.get(key) ?? 0) + 1);
        if (!link.isChrome) contextual.set(key, (contextual.get(key) ?? 0) + 1);
      }
    }
    c.siteQuery = {
      incomingLinkCounts: () => all,
      contextualIncomingLinkCounts: () => contextual,
      ...(inboundSectionCounts ? { inboundSectionCounts } : {}),
    } as unknown as RuleContext["siteQuery"];
    return c;
  }

  test("names the sections the inbound links sit in, and carries the counts", () => {
    const result = check(noContextualInboundRule, ctx(SECTIONED));

    expect(result.status).toBe("warn");
    expect(result.items).toEqual([
      {
        id: PRICING,
        label: `${PRICING}, linked only from the footer and the navigation`,
        meta: { sections: { footer: 3, navigation: 1 } },
      },
    ]);
    // The message and the sampled value are as they were.
    expect(result.message).toBe("1 page(s) are linked only from sitewide chrome");
    expect(result.value).toBe("/pricing");
  });

  test("says 'from', not 'only from', when some inbound links carry no section", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), footer("/pricing")] },
      { url: "https://example.com/a", links: [body(BASE), chrome("/pricing")] },
      { url: "https://example.com/b", links: [footer("/pricing")] },
      { url: PRICING, links: [] },
    ];
    const result = check(noContextualInboundRule, ctx(pages));

    expect(result.items).toEqual([
      {
        id: PRICING,
        label: `${PRICING}, linked from the footer`,
        meta: { sections: { footer: 2 } },
      },
    ]);
  });

  test("leaves the items bare when no inbound link has a section", () => {
    // The exact fixture and the exact assertion the crawls before link sections had.
    expect(check(noContextualInboundRule, ctx(FOOTER_ONLY)).items).toEqual([
      { id: PRICING },
    ]);
    // `unknown` is no answer either.
    const unknown: PageSpec[] = FOOTER_ONLY.map((p) => ({
      ...p,
      links: p.links.map((l) => (l.isChrome ? { ...l, section: "unknown" as const } : l)),
    }));
    expect(check(noContextualInboundRule, ctx(unknown)).items).toEqual([{ id: PRICING }]);
  });

  test("more than three sections read as the first three and a count", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), footer("/pricing")] },
      { url: "https://example.com/a", links: [nav("/pricing")] },
      { url: "https://example.com/b", links: [{ ...chrome("/pricing"), section: "sidebar" }] },
      { url: "https://example.com/c", links: [{ ...chrome("/pricing"), section: "header" }] },
      { url: PRICING, links: [] },
    ];
    const result = check(noContextualInboundRule, ctx(pages));

    expect(result.items?.[0]?.label).toBe(
      `${PRICING}, linked only from the footer, the header, the navigation and 1 more`
    );
  });

  test("three sections are all named", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), footer("/pricing")] },
      { url: "https://example.com/a", links: [nav("/pricing")] },
      { url: "https://example.com/b", links: [{ ...chrome("/pricing"), section: "breadcrumbs" }] },
      { url: PRICING, links: [] },
    ];

    expect(check(noContextualInboundRule, ctx(pages)).items?.[0]?.label).toBe(
      `${PRICING}, linked only from the breadcrumbs, the footer and the navigation`
    );
  });

  // A post's own <footer> inside <main> holds a "Back to the journal" link: chrome by tag (isChrome),
  // content by section. The page is still chrome-only, so the label may not say it is linked
  // "only from the page content"; it counts those as template links.
  describe("template links inside the page content", () => {
    /** A link in a block's own footer: chrome by landmark, `content` by section. */
    function templateLink(url: string): LinkData {
      return { ...chrome(url), section: "content" };
    }
    const BLOG = "https://example.com/blog";

    test("names the chrome sections, then counts the content links apart", () => {
      const pages: PageSpec[] = [
        { url: BASE, links: [body("/a"), footer("/blog"), nav("/blog")] },
        { url: "https://example.com/a", links: [footer("/blog"), nav("/blog"), templateLink("/blog")] },
        { url: "https://example.com/b", links: [footer("/blog"), templateLink("/blog")] },
        { url: BLOG, links: [{ ...chrome("/blog"), section: "breadcrumbs" }] },
      ];
      const result = check(noContextualInboundRule, ctx(pages));

      expect(result.items).toEqual([
        {
          id: BLOG,
          label: `${BLOG}, linked only from the footer, the navigation and the breadcrumbs, and 2 template links inside the page content`,
          meta: { sections: { footer: 3, navigation: 2, breadcrumbs: 1, content: 2 } },
        },
      ]);
    });

    test("a single template link reads in the singular", () => {
      const pages: PageSpec[] = [
        { url: BASE, links: [body("/a"), footer("/blog")] },
        { url: "https://example.com/a", links: [footer("/blog"), templateLink("/blog")] },
        { url: BLOG, links: [] },
      ];

      expect(check(noContextualInboundRule, ctx(pages)).items?.[0]?.label).toBe(
        `${BLOG}, linked only from the footer, and 1 template link inside the page content`
      );
    });

    test("content links alone never read as a place the page is linked from", () => {
      const pages: PageSpec[] = [
        { url: BASE, links: [body("/a"), templateLink("/blog")] },
        { url: "https://example.com/a", links: [templateLink("/blog")] },
        { url: BLOG, links: [] },
      ];
      const label = check(noContextualInboundRule, ctx(pages)).items?.[0]?.label;

      expect(label).toBe(`${BLOG}, linked only by 2 template links inside the page content`);
      expect(label).not.toMatch(/from [^,]*the page content/);
    });

    test("with some inbound links unplaced the label drops 'only' but keeps the split", () => {
      const pages: PageSpec[] = [
        { url: BASE, links: [body("/a"), footer("/blog")] },
        { url: "https://example.com/a", links: [chrome("/blog"), templateLink("/blog")] },
        { url: "https://example.com/b", links: [footer("/blog")] },
        { url: BLOG, links: [] },
      ];

      expect(check(noContextualInboundRule, ctx(pages)).items?.[0]?.label).toBe(
        `${BLOG}, linked from the footer, and 1 template link inside the page content`
      );
    });
  });

  test("the streaming path reads siteQuery.inboundSectionCounts and gets the same item", () => {
    const legacy = check(noContextualInboundRule, ctx(SECTIONED));
    const viaQuery = check(
      noContextualInboundRule,
      streaming(SECTIONED, () => new Map([[PRICING, { footer: 3, navigation: 1 }]]))
    );

    expect(viaQuery.items).toEqual(legacy.items);
    expect(viaQuery.items?.[0]?.label).toBe(
      `${PRICING}, linked only from the footer and the navigation`
    );
  });

  test("a siteQuery without inboundSectionCounts leaves the items bare", () => {
    const result = check(noContextualInboundRule, streaming(SECTIONED));

    expect(result.status).toBe("warn");
    expect(result.items).toEqual([{ id: PRICING }]);
  });
});

// pub#981: legal pages are footer-only by design, so they are not reported.
describe("links/no-contextual-inbound: legal pages", () => {
  const LEGAL_PATHS = [
    "/impressum",
    "/datenschutz",
    "/agb",
    "/legal",
    "/en/legal",
    "/privacy-policy",
    "/terms-of-service",
    "/imprint",
    "/legal-notice",
  ];

  // Every page carries the footer; `target` is reached only through it.
  function footerOnly(target: string): PageSpec[] {
    return [
      { url: BASE, links: [body("/a"), body("/b"), chrome(target)] },
      { url: "https://example.com/a", links: [body("/b"), chrome(target)] },
      { url: "https://example.com/b", links: [body("/a"), chrome(target)] },
      { url: `https://example.com${target}`, links: [chrome(target)] },
    ];
  }

  test.each(LEGAL_PATHS)("%s linked only from the footer is not reported", (path) => {
    const result = check(noContextualInboundRule, ctx(footerOnly(path)));
    expect(result.status).toBe("pass");
    expect(ids(result)).toEqual([]);
  });

  test("the reporter's repro: three footer-only legal pages report nothing", () => {
    const footer = [chrome("/impressum"), chrome("/datenschutz"), chrome("/agb")];
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/about"), ...footer] },
      { url: "https://example.com/about", links: [...footer] },
      { url: "https://example.com/impressum", links: [...footer] },
      { url: "https://example.com/datenschutz", links: [...footer] },
      { url: "https://example.com/agb", links: [...footer] },
    ];
    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
  });

  test("a non-legal page linked only from the footer is still reported", () => {
    const result = check(noContextualInboundRule, ctx(footerOnly("/pricing")));
    expect(result.status).toBe("warn");
    expect(ids(result)).toEqual(["https://example.com/pricing"]);
  });

  test("a slug that merely contains a legal word is still reported", () => {
    const result = check(noContextualInboundRule, ctx(footerOnly("/legalese-guide")));
    expect(ids(result)).toEqual(["https://example.com/legalese-guide"]);
  });
});
