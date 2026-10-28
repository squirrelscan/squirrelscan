// crawl/single-page-site: one page, complete crawl, 3+ in-page section links.
// Run on both inputs the rule reads (the v1 DOM and the streaming collected
// record), like links/broken-anchors.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { singlePageSiteRule } from "../src/crawl/single-page-site";
import type { RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";

const SECTIONS = `
  <nav><a href="#about">About</a><a href="#services">Services</a><a href="#contact">Contact</a></nav>
  <section id="about">a</section><section id="services">s</section><section id="contact">c</section>`;

const page = (body: string) =>
  `<html><head><title>t</title></head><body>${body}</body></html>`;

interface Over {
  html?: string;
  statusCode?: number;
  sitemapUrls?: string[];
  crawlLimits?: SiteData["crawlLimits"];
  unfetchedPages?: number;
  linkDiscoveryOff?: boolean;
  extraPages?: number;
}

function build(over: Over, streaming: boolean): RuleContext {
  const html = over.html ?? page(SECTIONS);
  const make = (path: string) => {
    const url = `${BASE}${path}`;
    return { url, statusCode: over.statusCode ?? 200, parsed: parsePage(html, url) };
  };
  const pages = [make("/")];
  for (let i = 0; i < (over.extraPages ?? 0); i++) pages.push(make(`/p${i}`));
  const site = {
    baseUrl: BASE,
    pages: streaming ? pages.map((p) => ({ ...p, parsed: { ...p.parsed, document: null } })) : pages,
    robotsTxt: null,
    sitemaps: over.sitemapUrls
      ? {
          discovered: [
            { url: `${BASE}/sitemap.xml`, type: "urlset", urls: over.sitemapUrls.map((loc) => ({ loc })), childSitemaps: [], errors: [], urlCount: over.sitemapUrls.length },
          ],
          sources: { robotsTxt: [], commonLocations: [] },
          totalUrls: over.sitemapUrls.length,
          orphanPages: [],
          missingPages: [],
          failed: [],
        }
      : null,
    crawlLimits: over.crawlLimits,
    unfetchedPages: over.unfetchedPages,
    linkDiscoveryOff: over.linkDiscoveryOff,
  };
  const ctx: Record<string, unknown> = { site };
  if (streaming) {
    ctx.collectedSignals = {
      pages: pages.map((p, i) =>
        buildCollectedPageSignal({ url: p.url, parsed: parsePage(html, p.url), rendered: false }),
      ),
    };
  }
  return ctx as unknown as RuleContext;
}

const ENGINES: Array<[string, boolean]> = [
  ["DOM (v1)", false],
  ["collected (streaming)", true],
];

describe.each(ENGINES)("crawl/single-page-site (%s)", (_name, streaming) => {
  const run = (over: Over = {}) => singlePageSiteRule.run(build(over, streaming)).checks;

  test("fires on one page with 3+ section links and lists the ids", () => {
    const checks = run();
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.items?.map((i) => i.id)).toEqual(["#about", "#services", "#contact"]);
    expect(checks[0]!.details?.sections).toBe(3);
  });

  test("a one-URL sitemap listing the page does not stop it", () => {
    expect(run({ sitemapUrls: [`${BASE}/`] })).toHaveLength(1);
  });

  test("a sitemap with a second in-scope URL does", () => {
    expect(run({ sitemapUrls: [`${BASE}/`, `${BASE}/other`] })).toEqual([]);
  });

  test("a sitemap's off-site URLs are not in scope", () => {
    expect(run({ sitemapUrls: [`${BASE}/`, "https://elsewhere.test/x"] })).toHaveLength(1);
  });

  test("no finding when the crawl was capped", () => {
    expect(run({ crawlLimits: { pagesCrawled: 1, maxPages: 1 } })).toEqual([]);
  });

  test("no finding when URLs were left unfetched or links were not followed", () => {
    expect(run({ unfetchedPages: 4 })).toEqual([]);
    expect(run({ linkDiscoveryOff: true })).toEqual([]);
  });

  test("no finding when the page links to another same-site path, even a missing one", () => {
    const html = page(`${SECTIONS}<a href="/gone">Gone</a>`);
    expect(run({ html })).toEqual([]);
  });

  test("a link to a same-host file counts as another path", () => {
    expect(run({ html: page(`${SECTIONS}<a href="/cv.pdf">CV</a>`) })).toEqual([]);
  });

  test("external, mailto, tel and own-path links do not stop it", () => {
    const html = page(
      `${SECTIONS}<a href="https://other.test/">x</a><a href="mailto:a@b.test">m</a><a href="tel:+1555">t</a><a href="/">home</a><a href="/#about">again</a>`,
    );
    expect(run({ html })).toHaveLength(1);
  });

  test("no finding with fewer than 3 section links", () => {
    const html = page(
      `<a href="#a">a</a><a href="#b">b</a><div id="a"></div><div id="b"></div>`,
    );
    expect(run({ html })).toEqual([]);
  });

  test("links to ids that do not exist are not sections", () => {
    const html = page(
      `<a href="#a">a</a><a href="#b">b</a><a href="#c">c</a><div id="a"></div><div id="b"></div>`,
    );
    expect(run({ html })).toEqual([]);
  });

  test("no finding for a multi-page site", () => {
    expect(run({ extraPages: 2 })).toEqual([]);
  });

  test("no finding when the one page did not answer 2xx", () => {
    expect(run({ statusCode: 404 })).toEqual([]);
  });

  test("lists at most 10 sections and counts the rest", () => {
    const ids = Array.from({ length: 13 }, (_, i) => `s${i}`);
    const html = page(
      ids.map((id) => `<a href="#${id}">${id}</a>`).join("") +
        ids.map((id) => `<div id="${id}"></div>`).join(""),
    );
    const [c] = run({ html });
    expect(c!.items).toHaveLength(10);
    expect(c!.details).toMatchObject({ sections: 13, additional: 3 });
  });
});
