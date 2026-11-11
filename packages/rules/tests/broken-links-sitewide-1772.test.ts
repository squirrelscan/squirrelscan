// #1772: a broken link in the header, navigation or footer of most pages is its own check, so it can be
// prioritised and closed apart from a broken link in one page's content. Internal and external links.
//
// Threshold: a link is site-wide when at least 3 pages carry it in a header, navigation or footer AND those
// pages are at least half of the pages the audit crawled. So a link on both pages of a 2 page site is not
// site-wide (under 3 pages), a link on every page of a 3 or 4 page site is, and one footer link on 1 of 70
// pages is not.

import { describe, expect, test } from "bun:test";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { brokenLinksRule } from "../src/links/broken-links";
import type { CheckResult, ExternalLinkCheckData, RuleContext } from "../src/types";

const BASE = "https://example.com";
const footerGone = `${BASE}/gone-footer`;
const bodyGone = `${BASE}/gone-body`;

type L = { url: string; section?: string };

function site(n: number, linksOf: (i: number) => L[]) {
  return Array.from({ length: n }, (_, i) => ({
    url: i === 0 ? `${BASE}/` : `${BASE}/p/${i}`,
    statusCode: 200,
    parsed: {
      links: linksOf(i).map((l) => ({ url: l.url, text: "", isInternal: true, section: l.section })),
    },
  }));
}

function ctx(pages: ReturnType<typeof site>, statuses: Record<string, number> = {}): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: [
        ...pages,
        ...Object.entries(statuses).map(([url, statusCode]) => ({ url, statusCode, parsed: { links: [] } })),
      ],
    },
    options: {},
  } as unknown as RuleContext;
}

const run = (c: RuleContext) => (brokenLinksRule.run(c) as { checks: CheckResult[] }).checks;
const named = (checks: CheckResult[], name: string) => checks.filter((c) => c.name === name);

const STATUSES = { [footerGone]: 404, [bodyGone]: 404 };

describe("links/broken-links: site-wide chrome (#1772)", () => {
  // The nut shop shape: 70 pages, a footer link on every one, a body link on one product page.
  const pages = site(70, (i) => [
    { url: footerGone, section: "footer" },
    ...(i === 5 ? [{ url: bodyGone, section: "content" }] : []),
  ]);
  const checks = run(ctx(pages, STATUSES));

  test("the footer link is its own check, with the section and the page count in the message", () => {
    const [wide] = named(checks, "broken-links-sitewide");
    expect(wide?.status).toBe("fail");
    expect(wide?.message).toBe("1 broken internal link in the footer of 70 pages (4xx/5xx)");
    expect(wide?.items?.map((i) => i.id)).toEqual([footerGone]);
    expect(wide?.items?.[0]?.meta).toMatchObject({ linkedFrom: 70, sections: { footer: 70 } });
  });

  test("the body link stays in broken-links, and its message counts only its own links", () => {
    const [content] = named(checks, "broken-links");
    expect(content?.status).toBe("fail");
    expect(content?.message).toBe("1 broken internal link in page content (4xx/5xx)");
    expect(content?.items?.map((i) => i.id)).toEqual([bodyGone]);
  });

  test("a link is in exactly one of the two checks, so the penalty is not doubled", () => {
    const ids = checks.flatMap((c) => c.items?.map((i) => i.id) ?? []);
    expect(ids.sort()).toEqual([bodyGone, footerGone].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("only a site-wide link: one failing check and no pass row beside it, as before", () => {
    const only = run(ctx(site(70, () => [{ url: footerGone, section: "footer" }]), STATUSES));
    expect(only.map((c) => `${c.name}:${c.status}`)).toEqual(["broken-links-sitewide:fail"]);
  });

  test("no site-wide link: the checks and messages are exactly as before", () => {
    const content = run(ctx(site(70, (i) => (i === 1 ? [{ url: bodyGone, section: "content" }] : [])), STATUSES));
    expect(named(content, "broken-links-sitewide")).toHaveLength(0);
    expect(named(content, "broken-links")[0]?.message).toBe("1 broken internal link(s) (4xx/5xx)");
    const none = run(ctx(site(70, () => []), {}));
    expect(named(none, "broken-links")[0]?.message).toBe("No broken internal links detected");
  });

  test("several links across several chrome sections say how many and where", () => {
    const wide = run(
      ctx(
        site(60, () => [
          { url: footerGone, section: "footer" },
          { url: bodyGone, section: "navigation" },
        ]),
        STATUSES,
      ),
    );
    expect(named(wide, "broken-links-sitewide")[0]?.message).toBe(
      "2 broken internal links in the site-wide footer and navigation, each on at least 60 pages (4xx/5xx)",
    );
  });
});

describe("the threshold (#1772)", () => {
  const wideFor = (n: number, carrying: number): number => {
    const c = ctx(site(n, (i) => (i < carrying ? [{ url: footerGone, section: "footer" }] : [])), {
      [footerGone]: 404,
    });
    return named(run(c), "broken-links-sitewide").length;
  };

  test("a link in the footer of one page of seventy is not site-wide", () => {
    expect(wideFor(70, 1)).toBe(0);
  });
  test("under three pages is never site-wide, even on every page of a two page site", () => {
    expect(wideFor(2, 2)).toBe(0);
  });
  test("every page of a three page site is site-wide", () => {
    expect(wideFor(3, 3)).toBe(1);
  });
  test("exactly half of the crawled pages is site-wide, one page under half is not", () => {
    // The dead target (a 404) is not a page a footer is read on, so 10 pages are 10.
    expect(wideFor(10, 5)).toBe(1);
    expect(wideFor(10, 4)).toBe(0);
  });
  test("a link in the page content of every page is not chrome, so not site-wide", () => {
    const checks = run(
      ctx(site(20, () => [{ url: bodyGone, section: "content" }]), { [bodyGone]: 404 }),
    );
    expect(named(checks, "broken-links-sitewide")).toHaveLength(0);
    expect(named(checks, "broken-links")[0]?.status).toBe("fail");
  });
});

describe("links/broken-external-links: site-wide chrome (#1772)", () => {
  const external = (href: string, section: string, pages: number): ExternalLinkCheckData => ({
    href,
    status: 404,
    error: null,
    sourcePages: Array.from({ length: pages }, (_, i) => (i === 0 ? `${BASE}/` : `${BASE}/p/${i}`)),
    // the section each page placed it in is read from the parsed links below
    section,
  } as unknown as ExternalLinkCheckData);

  function externalCtx(total: number, links: Array<{ href: string; section: string; pages: number }>): RuleContext {
    const pages = Array.from({ length: total }, (_, i) => ({
      url: i === 0 ? `${BASE}/` : `${BASE}/p/${i}`,
      statusCode: 200,
      parsed: {
        links: links
          .filter((l) => i < l.pages)
          .map((l) => ({ url: l.href, text: "", isInternal: false, section: l.section })),
      },
    }));
    return {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {},
      site: {
        baseUrl: BASE,
        pages,
        robotsTxt: null,
        sitemaps: null,
        externalLinks: links.map((l) => external(l.href, l.section, l.pages)),
      },
      options: {},
    } as unknown as RuleContext;
  }

  const checks = (c: RuleContext) => (brokenExternalLinksRule.run(c) as { checks: CheckResult[] }).checks;

  test("a dead link in the footer of every page is its own check; a body link stays", () => {
    const out = checks(
      externalCtx(40, [
        { href: "https://dead.example-live.net/partner", section: "footer", pages: 40 },
        { href: "https://dead.example-live.net/post", section: "content", pages: 1 },
      ]),
    );
    const [wide] = named(out, "broken-external-links-sitewide");
    expect(wide?.status).toBe("fail");
    expect(wide?.message).toBe("1 broken external link in the footer of 40 pages: 1 with 404");
    expect(wide?.items?.map((i) => i.id)).toEqual(["https://dead.example-live.net/partner"]);
    const [content] = named(out, "broken-external-links");
    expect(content?.message).toBe("1 broken external link in page content: 1 with 404");
    expect(content?.items?.map((i) => i.id)).toEqual(["https://dead.example-live.net/post"]);
  });

  test("without a site-wide link nothing changes", () => {
    const out = checks(
      externalCtx(40, [{ href: "https://dead.example-live.net/post", section: "content", pages: 1 }]),
    );
    expect(named(out, "broken-external-links-sitewide")).toHaveLength(0);
    expect(named(out, "broken-external-links")[0]?.message).toBe("1 broken external link(s): 1 with 404");
  });
});

describe("what counts toward site-wide (#1772 review)", () => {
  const run2 = (c: RuleContext) => (brokenLinksRule.run(c) as { checks: CheckResult[] }).checks;

  test("redirect entries, error pages and files are not pages a footer is read on", () => {
    // 10 real pages with the dead link in every footer, plus 12 redirect-source entries and a PDF.
    const real = site(10, () => [{ url: footerGone, section: "footer" }]);
    const redirects = Array.from({ length: 12 }, (_, i) => ({
      url: `${BASE}/old/${i}`,
      statusCode: 301,
      redirectSource: true,
      parsed: { links: [] },
    }));
    const pdf = {
      url: `${BASE}/file.pdf`,
      statusCode: 200,
      headers: { "content-type": "application/pdf" },
      parsed: { links: [] },
    };
    const c = ctx([...real, ...redirects, pdf] as never, { [footerGone]: 404 });
    expect(named(run2(c), "broken-links-sitewide")).toHaveLength(1);
  });

  const withConfidence = (source: string | undefined, confidence: number | undefined) =>
    ctx(
      Array.from({ length: 20 }, (_, i) => ({
        url: i === 0 ? `${BASE}/` : `${BASE}/p/${i}`,
        statusCode: 200,
        parsed: {
          links: [
            {
              url: footerGone,
              text: "",
              isInternal: true,
              section: "footer",
              ...(source ? { sectionSource: source, sectionConfidence: confidence } : {}),
            },
          ],
        },
      })) as never,
      { [footerGone]: 404 },
    );

  test("a footer the markup named is chrome", () => {
    expect(named(run2(withConfidence(undefined, undefined)), "broken-links-sitewide")).toHaveLength(1);
  });

  test("a footer only the classifier named, at low confidence, stays content", () => {
    const checks = run2(withConfidence("model", 0.5));
    expect(named(checks, "broken-links-sitewide")).toHaveLength(0);
    expect(named(checks, "broken-links")[0]?.status).toBe("fail");
  });

  test("a footer the classifier named confidently is chrome", () => {
    expect(named(run2(withConfidence("model", 0.9)), "broken-links-sitewide")).toHaveLength(1);
  });
});
