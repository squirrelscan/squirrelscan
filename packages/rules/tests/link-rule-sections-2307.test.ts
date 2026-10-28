// #2307: the link rules say where on the page the links they flag sit ("linked in the footer") and
// carry the counts in `meta.sections`. A crawl whose links carry no section keeps every item as it
// was. One case per rule here that has no test file of its own: https-downgrade, nofollow-internal,
// invalid-links and weak-internal-links.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";
import { extractLinks, toLinkData } from "@squirrelscan/parser/extractors";

import { httpsDowngradeRule } from "../src/links/https-downgrade";
import { invalidLinksRule } from "../src/links/invalid-links";
import { nofollowInternalRule } from "../src/links/nofollow-internal";
import { weakInternalLinksRule } from "../src/links/weak-internal-links";
import type { LinkData } from "@squirrelscan/core-contracts";
import type { ParsedPage, RuleContext } from "../src/types";

const URL_ = "https://example.com/";
const BASE = "https://example.com";

function pageCtx(html: string, strip = false): RuleContext {
  const parsed = parsePage(html, URL_);
  if (strip) for (const link of parsed.links) delete link.section;
  return {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed,
    options: {},
  } as unknown as RuleContext;
}

const body = (inner: string) =>
  `<!doctype html><html><head><title>t</title></head><body>${inner}</body></html>`;

describe("links/https-downgrade — link sections", () => {
  const html = body(
    '<footer><a href="http://other.example/x">x</a></footer><p><a href="http://other.example/y">y</a></p>'
  );

  test("an item says where its link sits; an unplaced one stays bare", () => {
    const { checks } = httpsDowngradeRule.run(pageCtx(html));

    expect(checks[0]!.items).toEqual([
      {
        id: "http://other.example/x",
        label: "http://other.example/x, linked in the footer",
        meta: { sections: { footer: 1 } },
        // pub#846: one page per section, for the report's region scope.
        regions: { footer: 1 },
      },
      { id: "http://other.example/y" },
    ]);
  });

  test("without section data every item is bare", () => {
    expect(httpsDowngradeRule.run(pageCtx(html, true)).checks[0]!.items).toEqual([
      { id: "http://other.example/x" },
      { id: "http://other.example/y" },
    ]);
  });
});

/** A context whose links come from the extractor a crawl uses, which records `rel` and nofollow. */
function crawlCtx(html: string, strip = false): RuleContext {
  const document = parseHTML(html).document;
  const links = extractLinks(document, URL_).map(toLinkData);
  if (strip) for (const link of links) delete link.section;
  return {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document, links } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
}

describe("links/nofollow-internal — link sections", () => {
  // /x is nofollowed in the navigation and followed in the page content: only the nofollowed
  // link counts, so the content link does not change the answer.
  const html = body(
    '<nav><a href="/x" rel="nofollow">x</a></nav><main><a href="/x">x again</a></main>'
  );

  test("an item says where the nofollowed link sits, not where the followed one does", () => {
    const { checks } = nofollowInternalRule.run(crawlCtx(html));

    expect(checks[0]!.items).toEqual([
      {
        id: "/x",
        label: "/x, linked in the navigation",
        meta: { sections: { navigation: 1 } },
        regions: { navigation: 1 },
      },
    ]);
  });

  test("without section data the item is bare", () => {
    expect(nofollowInternalRule.run(crawlCtx(html, true)).checks[0]!.items).toEqual([{ id: "/x" }]);
  });

  test("a link marked only sponsored or ugc is not counted as a nofollowed one", () => {
    const mixed = body(
      '<nav><a href="/x" rel="nofollow">x</a></nav><footer><a href="/x" rel="sponsored">x</a></footer>'
    );

    expect(nofollowInternalRule.run(crawlCtx(mixed)).checks[0]!.items?.[0]).toMatchObject({
      label: "/x, linked in the navigation",
      meta: { sections: { navigation: 1 } },
    });
  });
});

describe("links/invalid-links — link sections", () => {
  function invalidCtx(section?: LinkData["section"]): RuleContext {
    return {
      page: { url: URL_, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {
        links: [
          {
            url: "http://[bad",
            text: "t",
            isInternal: false,
            error: "Invalid URL format",
            ...(section ? { section } : {}),
          },
        ],
      } as unknown as ParsedPage,
      options: {},
    } as unknown as RuleContext;
  }

  test("the item says where the link sits", () => {
    expect(invalidLinksRule.run(invalidCtx("footer")).checks[0]!.items).toEqual([
      {
        id: "http://[bad",
        label: "Invalid URL format, linked in the footer",
        meta: { text: "t", error: "Invalid URL format", sections: { footer: 1 } },
        regions: { footer: 1 },
      },
    ]);
  });

  test("without a section the item is as it was", () => {
    expect(invalidLinksRule.run(invalidCtx()).checks[0]!.items).toEqual([
      {
        id: "http://[bad",
        label: "Invalid URL format",
        meta: { text: "t", error: "Invalid URL format" },
      },
    ]);
  });
});

describe("links/weak-internal-links — link sections", () => {
  const LONE = `${BASE}/lone`;

  /** /lone has exactly one inbound link, from `section`; /a and /b link each other and home. */
  function legacyCtx(section?: LinkData["section"]): RuleContext {
    const link = (url: string, s?: LinkData["section"]) =>
      ({ url, text: "l", isInternal: true, ...(s ? { section: s } : {}) }) as LinkData;
    const pages = [
      { url: `${BASE}/`, links: [link("/a"), link("/b"), link("/lone", section)] },
      { url: `${BASE}/a`, links: [link("/b")] },
      { url: `${BASE}/b`, links: [link("/a")] },
      { url: LONE, links: [] },
    ];
    return {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
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
      options: { excludePatterns: [] },
    } as unknown as RuleContext;
  }

  test("the legacy path says where the one link sits", () => {
    const { checks } = weakInternalLinksRule.run(legacyCtx("navigation")) as {
      checks: Array<{ items?: unknown[] }>;
    };

    expect(checks[0]!.items).toEqual([
      { id: LONE, label: `${LONE}, linked in the navigation`, meta: { sections: { navigation: 1 } } },
    ]);
  });

  test("the streaming path reads siteQuery.inboundSectionCounts and gets the same item", () => {
    const c = legacyCtx("navigation");
    c.siteQuery = {
      incomingLinkCounts: () =>
        new Map([
          [`${BASE}/`, 0],
          [`${BASE}/a`, 2],
          [`${BASE}/b`, 2],
          [LONE, 1],
        ]),
      inboundSectionCounts: () => new Map([[LONE, { navigation: 1 }]]),
    } as unknown as RuleContext["siteQuery"];
    const viaQuery = weakInternalLinksRule.run(c) as { checks: Array<{ items?: unknown[] }> };
    const legacy = weakInternalLinksRule.run(legacyCtx("navigation")) as {
      checks: Array<{ items?: unknown[] }>;
    };

    expect(viaQuery.checks[0]!.items).toEqual(legacy.checks[0]!.items);
  });

  test("without section data the item is bare, on both paths", () => {
    const legacy = weakInternalLinksRule.run(legacyCtx()) as { checks: Array<{ items?: unknown[] }> };
    expect(legacy.checks[0]!.items).toEqual([{ id: LONE }]);

    const c = legacyCtx();
    c.siteQuery = {
      incomingLinkCounts: () => new Map([[`${BASE}/`, 0], [`${BASE}/a`, 2], [LONE, 1]]),
    } as unknown as RuleContext["siteQuery"];
    const streamed = weakInternalLinksRule.run(c) as { checks: Array<{ items?: unknown[] }> };
    expect(streamed.checks[0]!.items).toEqual([{ id: LONE }]);
  });
});
