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
