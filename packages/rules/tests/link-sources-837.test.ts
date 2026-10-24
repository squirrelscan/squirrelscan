// pub#837: a link finding lists each source page once, with how many of its links point at the
// target and where on that page they sit. `sourcePages` holds each page once; `sources` holds the
// per-page detail; `meta.linkedFrom` counts pages, as the report's page count does.

import { describe, expect, test } from "bun:test";

import type { RedirectChain } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { brokenAnchorsRule } from "../src/links/broken-anchors";
import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { brokenLinksRule } from "../src/links/broken-links";
import { redirectChainsRule } from "../src/links/redirect-chains";
import type { CheckResult, ExternalLinkCheckData, RuleContext } from "../src/types";

const BASE = "https://example.com";
const gone = `${BASE}/gone`;

type L = { url: string; section?: string; isInternal?: boolean };

function site(
  pages: { url: string; status?: number; links: L[]; finalUrl?: string; redirectChain?: RedirectChain }[],
  extra: Record<string, unknown> = {},
): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: pages.map((p) => ({
        url: p.url,
        statusCode: p.status ?? 200,
        finalUrl: p.finalUrl,
        redirectChain: p.redirectChain,
        parsed: {
          links: p.links.map((l) => ({
            url: l.url,
            text: "",
            isInternal: l.isInternal ?? true,
            section: l.section,
          })),
        },
      })),
      ...extra,
    },
    options: {},
  } as unknown as RuleContext;
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name)!;

describe("links/broken-links: one row per source page (pub#837)", () => {
  const checks = brokenLinksRule.run(
    site([
      {
        url: `${BASE}/a`,
        links: [
          { url: gone, section: "content" },
          { url: gone, section: "content" },
        ],
      },
      { url: `${BASE}/b`, links: [{ url: gone, section: "footer" }] },
      { url: `${BASE}/c`, links: [{ url: gone }] },
      { url: gone, status: 404, links: [] },
    ]),
  ).checks;
  const item = named(checks, "broken-links").items![0]!;

  test("a page that links twice is listed once, with a link count", () => {
    expect(item.sourcePages).toEqual([`${BASE}/a`, `${BASE}/b`, `${BASE}/c`]);
    expect(item.sources).toEqual([
      { page: `${BASE}/a`, links: 2, sections: { content: 2 } },
      { page: `${BASE}/b`, links: 1, sections: { footer: 1 } },
      { page: `${BASE}/c`, links: 1 },
    ]);
  });

  test("linkedFrom counts pages, and the label keeps the sections of all of them", () => {
    expect(item.meta).toMatchObject({ linkedFrom: 3, sections: { content: 2, footer: 1 } });
    expect(item.label).toBe(`${gone} (404), linked in the page content and the footer`);
  });

  test("refused and rate-limited targets list each page once too", () => {
    const refused = `${BASE}/private`;
    const throttled = `${BASE}/busy`;
    const { checks } = brokenLinksRule.run(
      site(
        [
          {
            url: `${BASE}/`,
            links: [{ url: refused }, { url: refused, section: "header" }, { url: throttled }, { url: throttled }],
          },
        ],
        {
          linkTargetStatuses: [
            { url: refused, status: 403 },
            { url: throttled, status: 429, rateLimited: true },
          ],
        },
      ),
    );
    expect(named(checks, "refused-links").items![0]).toMatchObject({
      sourcePages: [`${BASE}/`],
      sources: [{ page: `${BASE}/`, links: 2, sections: { header: 1 } }],
    });
    expect(named(checks, "rate-limited-links").items![0]).toMatchObject({
      sourcePages: [`${BASE}/`],
      sources: [{ page: `${BASE}/`, links: 2 }],
    });
  });
});

describe("links/redirect-chains: links-to-redirect per source page (pub#837)", () => {
  const moved = `${BASE}/old`;
  const chain: RedirectChain = {
    sourceUrl: moved,
    finalUrl: `${BASE}/new`,
    hops: [
      { url: moved, statusCode: 301, type: "http" },
      { url: `${BASE}/new`, statusCode: 200, type: "http" },
    ],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };

  test("each source page once, with its links and sections", () => {
    const { checks } = redirectChainsRule.run(
      site([
        { url: moved, finalUrl: `${BASE}/new`, redirectChain: chain, links: [] },
        {
          url: `${BASE}/a`,
          links: [
            { url: moved, section: "navigation" },
            { url: moved, section: "footer" },
          ],
        },
        { url: `${BASE}/b`, links: [{ url: moved }] },
      ]),
    );
    expect(named(checks, "links-to-redirect").items![0]).toMatchObject({
      sourcePages: [`${BASE}/a`, `${BASE}/b`],
      sources: [
        { page: `${BASE}/a`, links: 2, sections: { navigation: 1, footer: 1 } },
        { page: `${BASE}/b`, links: 1 },
      ],
    });
  });
});

describe("links/broken-anchors: per source page (pub#837)", () => {
  test("a page that links the missing id twice is one source with two links", () => {
    const target = `${BASE}/doc`;
    const sourceHtml =
      '<html><body><nav><a href="/doc#missing">a</a></nav><main><a href="/doc#missing">b</a></main></body></html>';
    const ctx = {
      site: {
        baseUrl: BASE,
        robotsTxt: null,
        sitemaps: null,
        pages: [
          { url: `${BASE}/a`, statusCode: 200, parsed: parsePage(sourceHtml, `${BASE}/a`) },
          {
            url: target,
            statusCode: 200,
            parsed: parsePage('<html><body><h2 id="present">x</h2></body></html>', target),
          },
        ],
      },
    } as unknown as RuleContext;
    const item = named(brokenAnchorsRule.run(ctx).checks, "broken-anchors").items![0]!;
    expect(item.sourcePages).toEqual([`${BASE}/a`]);
    expect(item.sources).toEqual([
      { page: `${BASE}/a`, links: 2, sections: { navigation: 1, content: 1 } },
    ]);
    expect(item.meta).toMatchObject({ linkedFrom: 1 });
  });

  test("same-page links to a missing id count every link, on both engines", () => {
    const url = `${BASE}/faq`;
    const html =
      '<html><body><a href="#gone">a</a><a href="#gone">b</a><a href="#gone">c</a><h2 id="here">x</h2></body></html>';
    const parsed = parsePage(html, url);
    const dom = {
      site: {
        baseUrl: BASE,
        robotsTxt: null,
        sitemaps: null,
        pages: [{ url, statusCode: 200, parsed }],
      },
    } as unknown as RuleContext;
    const stream = {
      site: {
        ...dom.site,
        pages: [{ url, statusCode: 200, parsed: { ...parsed, document: null } }],
      },
      collectedSignals: { pages: [buildCollectedPageSignal({ url, parsed, rendered: false })] },
    } as unknown as RuleContext;
    for (const ctx of [dom, stream]) {
      const item = named(brokenAnchorsRule.run(ctx).checks, "broken-anchors").items![0]!;
      expect(item.sources).toEqual([{ page: url, links: 3 }]);
    }
  });
});

describe("links/broken-external-links: per source page (pub#837)", () => {
  const dead = "https://partner.example/gone";

  test("each source page once, with its links and sections there", () => {
    const { checks } = brokenExternalLinksRule.run(
      site(
        [
          {
            url: `${BASE}/a`,
            links: [
              { url: dead, isInternal: false, section: "content" },
              { url: dead, isInternal: false, section: "footer" },
            ],
          },
          { url: `${BASE}/b`, links: [{ url: dead, isInternal: false }] },
        ],
        {
          externalLinks: [
            { href: dead, status: 404, error: null, sourcePages: [`${BASE}/a`, `${BASE}/b`] },
          ] as ExternalLinkCheckData[],
        },
      ),
    );
    const item = named(checks, "broken-external-links").items![0]!;
    expect(item.sourcePages).toEqual([`${BASE}/a`, `${BASE}/b`]);
    expect(item.sources).toEqual([
      { page: `${BASE}/a`, links: 2, sections: { content: 1, footer: 1 } },
      { page: `${BASE}/b`, links: 1 },
    ]);
    expect(item.label).toBe(`${dead} (404), linked in the page content and the footer`);
  });

  test("a source page the audited pages do not show gets no detail row", () => {
    const { checks } = brokenExternalLinksRule.run(
      site([{ url: `${BASE}/a`, links: [{ url: dead, isInternal: false, section: "footer" }] }], {
        externalLinks: [
          { href: dead, status: 410, error: null, sourcePages: [`${BASE}/a`, `${BASE}/unseen`] },
        ] as ExternalLinkCheckData[],
      }),
    );
    const item = named(checks, "broken-external-links").items![0]!;
    expect(item.sourcePages).toEqual([`${BASE}/a`, `${BASE}/unseen`]);
    expect(item.sources).toEqual([{ page: `${BASE}/a`, links: 1, sections: { footer: 1 } }]);
  });
});
