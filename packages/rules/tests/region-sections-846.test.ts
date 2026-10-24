// pub#846: the first-slice rules record where the offending element sits, so the report can say
// "In the site footer, on 49 of 53 pages" instead of listing every page. A page-scope rule sets
// `regions` to one page per section on its own page; a link rule counts pages per section across
// the site; the fold adds them up, once per page. A parse without sections records nothing.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";

import { linkTextRule } from "../src/a11y/link-text";
import { staleCopyrightRule } from "../src/content/stale-copyright";
import { foldOverflowChecks, sampleChecksForPublish, unfoldAggregateCheck } from "../src/fold";
import { anchorTextRule } from "../src/links/anchor-text";
import { brokenLinksRule } from "../src/links/broken-links";
import { telMailtoRule } from "../src/links/tel-mailto";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

function pageCtx(body: string, strip = false): RuleContext {
  const html = `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
  const parsed = parsePage(html, `${BASE}/`);
  if (strip) for (const link of parsed.links) delete link.section;
  return {
    page: { url: `${BASE}/`, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed,
    options: {},
  } as unknown as RuleContext;
}

const check = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("a11y/link-text records the section of each flagged link", () => {
  const body =
    '<header><a href="/a">read more</a></header>' +
    '<main><p>Story <a href="/b">read more</a></p></main>' +
    '<div><a href="/c">read more</a></div>' +
    '<footer><a href="/d"><i class="icon-x"></i></a></footer>';

  test("a header link and a content link; a link with no landmark adds nothing", () => {
    const checks = linkTextRule.run(pageCtx(body)).checks;
    expect(check(checks, "link-text-generic")!.items).toEqual([
      { id: "read more", regions: { header: 1, content: 1 } },
    ]);
    expect(check(checks, "link-text-empty")!.items).toEqual([
      { id: "/d", label: "icon-font", regions: { footer: 1 } },
    ]);
  });

  test("the same link repeated in two parts of the page is matched to each in order", () => {
    const checks = linkTextRule.run(
      pageCtx('<nav><a href="/x">learn more</a></nav><main><a href="/x">learn more</a></main>'),
    ).checks;
    expect(check(checks, "link-text-generic")!.items).toEqual([
      { id: "learn more", regions: { navigation: 1, content: 1 } },
    ]);
  });

  test("an anchor the link extractor leaves out does not take another's placement", () => {
    const checks = linkTextRule.run(
      pageCtx('<header><a href="#">click here</a></header><footer><a href="https://example.com/#">click here</a></footer>'),
    ).checks;
    expect(check(checks, "link-text-generic")!.items).toEqual([
      { id: "click here", regions: { footer: 1 } },
    ]);
  });

  test("a parse without sections records no region, and the items are as before", () => {
    const checks = linkTextRule.run(pageCtx(body, true)).checks;
    expect(check(checks, "link-text-generic")!.items).toEqual([{ id: "read more" }]);
    expect(check(checks, "link-text-empty")!.items).toEqual([{ id: "/d", label: "icon-font" }]);
  });
});

describe("page-scope link rules with section labels add regions", () => {
  test("links/anchor-text", () => {
    const checks = anchorTextRule.run(pageCtx('<footer><a href="/x">click here</a></footer>')).checks;
    expect(check(checks, "generic-anchor")!.items![0]).toMatchObject({ regions: { footer: 1 } });
  });

  test("links/tel-mailto", () => {
    const checks = telMailtoRule.run(
      pageCtx('<footer><a href="tel:+61299999999">Call 02 1234 5678</a></footer>'),
    ).checks;
    expect(check(checks, "tel-mismatch")!.items![0]).toMatchObject({ regions: { footer: 1 } });
  });
});

describe("content/stale-copyright names the footer", () => {
  test("a stale year is a footer finding", () => {
    const { document } = parseHTML("<html><body><footer>© 2019 Acme</footer></body></html>");
    const ctx = {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document } as unknown as ParsedPage,
      options: { current_year: 2026 },
    } as unknown as RuleContext;
    expect(staleCopyrightRule.run(ctx).checks[0]).toMatchObject({
      status: "warn",
      details: { region: "footer" },
    });
  });
});

describe("links/broken-links counts pages per section", () => {
  test("a footer link on every page, and a content link on two of them", () => {
    const gone = `${BASE}/gone`;
    const pages = Array.from({ length: 10 }, (_, k) => ({
      url: `${BASE}/p${k}`,
      statusCode: 200,
      parsed: {
        links: [
          { url: gone, text: "", isInternal: true, section: "footer" },
          ...(k < 2 ? [{ url: gone, text: "", isInternal: true, section: "content" }] : []),
        ],
      },
    }));
    const ctx = {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {},
      site: {
        baseUrl: BASE,
        robotsTxt: null,
        sitemaps: null,
        pages: [...pages, { url: gone, statusCode: 404, parsed: { links: [] } }],
      },
      options: {},
    } as unknown as RuleContext;
    const item = check(brokenLinksRule.run(ctx).checks, "broken-links")!.items![0]!;
    expect(item.regions).toEqual({ footer: 10, content: 2 });
  });
});

describe("the fold adds per-page regions once per page", () => {
  test("pages per section summed, an id repeated on one page counted once", () => {
    const checks: CheckResult[] = Array.from({ length: 6 }, (_, k) => ({
      name: "link-text-empty",
      status: "fail",
      message: "1 link(s) with no accessible text",
      pageUrl: `${BASE}/p${k}`,
      items: [
        { id: "/", label: "icon-font", regions: { header: 1 } },
        // The same id again on the same page, in the footer this time.
        ...(k === 0 ? [{ id: "/", label: "icon-font", regions: { header: 1, footer: 1 } }] : []),
      ],
    }));
    const [aggregate] = foldOverflowChecks(checks, {
      maxChecks: 1,
      maxPagesPerCheck: 100,
      maxItemsPerCheck: 100,
      maxSourcePagesPerItem: 4,
    });
    const item = aggregate!.items![0]!;
    expect(item.regions).toEqual({ header: 6, footer: 1 });
    expect(item.sourcePages).toHaveLength(4);
    expect(item.pageCount).toBe(6);
    expect(item.sources?.find((s) => s.page === `${BASE}/p0`)?.sections).toEqual({ header: 1, footer: 1 });
  });

  test("an aggregate unfolded and folded again keeps its counts", () => {
    const checks: CheckResult[] = Array.from({ length: 12 }, (_, k) => ({
      name: "link-text-generic",
      status: "warn",
      message: "1 link(s) with generic text",
      pageUrl: `${BASE}/p${String(k).padStart(2, "0")}`,
      items: [{ id: "read more", regions: { footer: 1 } }],
    }));
    const limits = { maxChecks: 1, maxPagesPerCheck: 100, maxItemsPerCheck: 100, maxSourcePagesPerItem: 100 };
    const [aggregate] = foldOverflowChecks(checks, limits);
    expect(aggregate!.items![0]!.regions).toEqual({ footer: 12 });
    const [again] = foldOverflowChecks(unfoldAggregateCheck(aggregate!), limits);
    expect(again!.items![0]!.regions).toEqual({ footer: 12 });
  });

  test("a check that only reads the footer keeps naming it when folded", () => {
    const checks: CheckResult[] = Array.from({ length: 3 }, (_, k) => ({
      name: "footer-copyright-year",
      status: "warn",
      message: "Footer copyright year is 2019, behind the current year 2026",
      pageUrl: `${BASE}/p${k}`,
      details: { region: "footer" },
    }));
    const [aggregate] = foldOverflowChecks(checks, {
      maxChecks: 1,
      maxPagesPerCheck: 100,
      maxItemsPerCheck: 100,
      maxSourcePagesPerItem: 100,
    });
    expect(aggregate!.details).toMatchObject({ region: "footer" });
  });

  test("the publish sample keeps the page count it cuts", () => {
    const sourcePages = Array.from({ length: 52 }, (_, k) => `${BASE}/p${k}`);
    const [check] = sampleChecksForPublish([
      {
        name: "broken-links",
        status: "fail",
        message: "1 broken internal link(s) (4xx/5xx)",
        items: [{ id: `${BASE}/gone`, sourcePages, regions: { footer: 49 } }],
      },
    ]);
    expect(check!.items![0]).toMatchObject({ pageCount: 52, regions: { footer: 49 } });
  });
});
