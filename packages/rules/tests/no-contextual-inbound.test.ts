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
import type { LinkData } from "@squirrelscan/core-contracts";

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

// Three content pages all cross-link each other in body copy; /legal is reached
// ONLY through the sitewide footer that every page carries.
const FOOTER_ONLY: PageSpec[] = [
  { url: BASE, links: [body("/a"), body("/b"), chrome("/legal")] },
  { url: "https://example.com/a", links: [body("/b"), chrome("/legal")] },
  { url: "https://example.com/b", links: [body("/a"), chrome("/legal")] },
  { url: "https://example.com/legal", links: [chrome("/legal")] },
];

describe("links/no-contextual-inbound — the acceptance fixtures", () => {
  test("a page linked only from the sitewide footer warns", () => {
    const result = check(noContextualInboundRule, ctx(FOOTER_ONLY));

    expect(result.status).toBe("warn");
    expect(ids(result)).toEqual(["https://example.com/legal"]);
    expect(result.details).toEqual({ total: 1 });
    expect(result.value).toBe("/legal");
    expect(result.message).toBe("1 page(s) are linked only from sitewide chrome");
  });

  test("…and links/orphan-pages does NOT report it (the blind spot)", () => {
    // 4 footer links (one per page) put /legal well above the orphan threshold.
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
    const excluded = ctx(FOOTER_ONLY, { excludePatterns: ["/legal"] });
    expect(check(noContextualInboundRule, excluded).status).toBe("pass");
  });

  test("a chrome-only page BELOW the orphan threshold is left to orphan-pages", () => {
    // Only one page carries the footer link, so /legal's raw count is 1 (< 2).
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), chrome("/legal")] },
      { url: "https://example.com/a", links: [body(BASE)] },
      { url: "https://example.com/legal", links: [] },
    ];

    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
    expect(ids(check(orphanPagesRule, ctx(pages)))).toContain("https://example.com/legal");
  });

  test("minInboundLinks moves the handoff point in step with orphan-pages", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), chrome("/legal")] },
      { url: "https://example.com/a", links: [body(BASE)] },
      { url: "https://example.com/legal", links: [] },
    ];
    // At a threshold of 1, /legal (raw 1) is no longer an orphan — so it becomes
    // ours. Neither rule may drop it.
    const opts = { minInboundLinks: 1 };
    expect(check(orphanPagesRule, ctx(pages, opts)).status).toBe("pass");
    expect(ids(check(noContextualInboundRule, ctx(pages, opts)))).toEqual([
      "https://example.com/legal",
    ]);
  });

  test("nofollow chrome links do not count on either side of the comparison", () => {
    // /legal's only inbound links are nofollowed chrome → raw 0 → an orphan,
    // not our case.
    const pages: PageSpec[] = [
      { url: BASE, links: [body("/a"), { ...chrome("/legal"), isNofollow: true }] },
      { url: "https://example.com/a", links: [body(BASE), { ...chrome("/legal"), isNofollow: true }] },
      { url: "https://example.com/legal", links: [] },
    ];
    expect(check(noContextualInboundRule, ctx(pages)).status).toBe("pass");
  });

  test("a crawl with <2 pages is skipped", () => {
    const result = check(noContextualInboundRule, ctx([{ url: BASE, links: [] }]));
    expect(result.status).toBe("skipped");
  });

  test("links stored without isChrome (pre-#109 crawls) count as contextual", () => {
    const pages: PageSpec[] = [
      { url: BASE, links: [legacyLink("/a"), legacyLink("/legal")] },
      { url: "https://example.com/a", links: [legacyLink("/legal")] },
      { url: "https://example.com/legal", links: [] },
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
