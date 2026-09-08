// TEMPLATE FAN-OUT PARITY GATE (#1950).
//
// `meta.verdictScope: "template"` is a claim that a page rule's verdict is a
// property of the page's TEMPLATE, so #1951 may run it once per cluster and fan
// the verdict to the members — a claim about pages the rule never ran on. This
// file is what makes that claim falsifiable: every rule declaring "template" must
// produce a byte-identical verdict for every member of every multi-page cluster of
// a corpus that HAS multi-page clusters.
//
// WHY THE FIXTURE IS SHAPED THE WAY IT IS. A corpus whose pages are all one
// template passes this vacuously, and the synthetic bench corpora are exactly that
// — generated from 1-6 templates, so every clustering definition collapses to ~99%
// redundancy on them (#1026). So the fixture below is authored: three templates
// with 4, 4 and 3 members plus two singletons, and the members of a template differ
// the way real template siblings differ — different amounts of the same kind of
// content: more paragraphs, more images, more links, different titles, different
// JSON-LD, an image missing its alt on some pages. What they do NOT differ in is
// the KIND of markup, because that is the template, and that distinction is the
// classification's whole premise.
//
// The corpus is checked for adversarialness before it is trusted: it must produce
// several multi-page clusters AND a substantial number of "page"-declared rules
// that genuinely disagree inside a cluster. A fixture where nothing varies would
// make every rule look invariant, which is the failure this gate exists to prevent.
//
// Clusters come from the SHIPPED path: `extractPageFeatures` writes
// `page_features.template_fp` (#1949) and `SiteQuery.templateClusters()` groups on
// it. The gate reads the stored key, not one it computed for itself.
//
// This is evidence, not proof, and it is only one of the two falsifiers. The other
// is `apps/cli/scripts/template-rule-invariance.ts --check`, which runs the same
// comparison (`templateVerdictKey`, shared with this file so the two falsifiers
// cannot drift) against a real crawl. Measured on gymshark.com (247 pages, 8
// multi-page clusters, 89/198 rules constant) and openelectricity.org.au (100
// pages, 3 clusters, 142/198), every rule declared "template" is constant on both;
// that result is recorded in
// packages/rules/tests/fixtures/template-invariance-measured.json and asserted by
// rule-verdict-scope.test.ts.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner, loadAllRules, mayFanOutAcrossTemplate } from "@squirrelscan/rules";
import type { PageData, SiteData } from "@squirrelscan/rules";
import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { createSiteQuery, extractPageFeatures, templateVerdictKey } from "../src/index";
import { parseHtmlForRules } from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";
const ORIGIN = "https://shop.test";

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface Template {
  readonly id: string;
  readonly stylesheet: string;
  readonly scriptHost: string;
  readonly imageHost: string;
  readonly bodyClass: string;
  readonly cssVars: string;
  readonly footer: boolean;
}

const TEMPLATES: Template[] = [
  {
    id: "product",
    stylesheet: "/assets/product.css",
    scriptHost: "cdn.shopkit.test",
    imageHost: "img.shopkit.test",
    bodyClass: "tpl-product theme-light",
    cssVars: "--brand:#101010;--gutter:16px",
    footer: true,
  },
  {
    id: "article",
    stylesheet: "/assets/article.css",
    scriptHost: "cdn.editorial.test",
    imageHost: "media.editorial.test",
    bodyClass: "tpl-article theme-light",
    cssVars: "--brand:#202020;--measure:68ch",
    footer: true,
  },
  {
    id: "landing",
    stylesheet: "/assets/landing.css",
    scriptHost: "cdn.campaign.test",
    imageHost: "img.campaign.test",
    bodyClass: "tpl-landing",
    cssVars: "--brand:#303030",
    // No footer: a chrome difference, so this cannot merge into another cluster.
    footer: false,
  },
];

/**
 * The template's chrome, byte-identical for every member. Everything the cluster
 * key reads lives here: stylesheet hrefs, asset hosts, body classes, CSS custom
 * properties, nav and footer presence.
 */
function chrome(t: Template): { head: string; nav: string; foot: string } {
  return {
    head:
      `<meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="icon" href="/favicon.ico">` +
      `<link rel="stylesheet" href="${t.stylesheet}">` +
      `<script src="https://${t.scriptHost}/app.js" defer></script>` +
      // An inline script, template-emitted and byte-identical across members, so
      // the script-reading declarations (integrity/obfuscated-script,
      // perf/legacy-js, perf/duplicate-js) are compared on something rather than
      // passing by absence.
      `<script>window.__cfg={locale:"en",tpl:"${t.id}"};</script>` +
      `<style>:root{${t.cssVars}}</style>`,
    nav:
      `<nav aria-label="Primary"><ul>` +
      `<li><a href="/">Home</a></li><li><a href="/about">About</a></li>` +
      `</ul></nav>`,
    foot: t.footer
      ? `<footer><form action="/subscribe" method="post">` +
        `<label for="em">Email</label><input id="em" type="email" name="email">` +
        `<button type="submit">Subscribe</button></form>` +
        `<p>&copy; 2026 Shop Test</p></footer>`
      : "",
  };
}

/**
 * One member's body. `n` is the only thing that moves: more paragraphs, more
 * images, more links, a different title and description, a different JSON-LD
 * offer, and on every third page an image with no alt. That is how real siblings
 * of one template differ, and it is what makes the "page"-declared rules disagree
 * here.
 */
function body(t: Template, n: number): string {
  const paragraphs = Array.from(
    { length: n + 1 },
    (_, i) =>
      `<p>Paragraph ${i + 1} of the ${t.id} page number ${n}. ` +
      "It carries enough prose that word count, reading level and text-to-html ratio move with n. ".repeat(n) +
      "</p>",
  ).join("");
  const images = Array.from({ length: n }, (_, i) =>
    i === 0 && n % 3 === 0
      ? `<img src="https://${t.imageHost}/${t.id}-${n}-${i}.jpg" width="800" height="600">`
      : `<img src="https://${t.imageHost}/${t.id}-${n}-${i}.jpg" width="800" height="600" alt="${t.id} view ${i}">`,
  ).join("");
  const links = Array.from(
    { length: n },
    (_, i) => `<a href="/${t.id}/related-${i}">Related ${i}</a>`,
  ).join(" ");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": t.id === "article" ? "Article" : "Product",
    name: `${t.id} ${n}`,
    description: `A ${t.id} with ${n} related items.`,
  });
  return (
    `<main><h1>${t.id} number ${n}</h1>` +
    Array.from({ length: n }, (_, i) => `<h2>Section ${i + 1}</h2>`).join("") +
    paragraphs +
    images +
    `<p>${links}</p>` +
    `<script type="application/ld+json">${jsonLd}</script>` +
    `</main>`
  );
}

function pageHtml(t: Template, n: number): string {
  const c = chrome(t);
  return (
    `<!DOCTYPE html><html lang="en"><head><title>${t.id} ${n} | Shop Test</title>` +
    `<meta name="description" content="The ${t.id} page numbered ${n}, with ${n} related items and ${n} images.">` +
    `<link rel="canonical" href="${ORIGIN}/${t.id}/${n}">` +
    c.head +
    `</head><body class="${t.bodyClass}">${c.nav}${body(t, n)}${c.foot}</body></html>`
  );
}

/** A page nothing else shares chrome with, so it lands in a cluster of one. */
function singletonHtml(slug: string): string {
  return (
    `<!DOCTYPE html><html lang="en"><head><title>${slug} | Shop Test</title>` +
    `<meta name="description" content="A one-off ${slug} page.">` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<link rel="stylesheet" href="/assets/${slug}.css">` +
    `<script src="https://cdn.${slug}.test/app.js" defer></script>` +
    `<style>:root{--brand-${slug}:#404040}</style>` +
    `</head><body class="tpl-${slug}"><nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main><h1>${slug}</h1><p>One of a kind.</p>` +
    `<img src="https://img.${slug}.test/hero.jpg" width="100" height="100" alt="hero"></main></body></html>`
  );
}

interface Fixture {
  readonly url: string;
  readonly html: string;
}

const CORPUS: Fixture[] = [
  ...TEMPLATES.flatMap((t) =>
    (t.id === "landing" ? [1, 2, 3] : [1, 2, 3, 4]).map((n) => ({
      url: `${ORIGIN}/${t.id}/${n}`,
      html: pageHtml(t, n),
    })),
  ),
  { url: `${ORIGIN}/contact`, html: singletonHtml("contact") },
  { url: `${ORIGIN}/status`, html: singletonHtml("status") },
];

function mkPage(url: string, html: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html; charset=utf-8",
    sizeBytes: html.length,
    loadTimeMs: 12,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: `h:${url}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html; charset=utf-8" },
    securityHeaders: {},
  } as unknown as PageRecord;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const SITE_DATA = {
  baseUrl: ORIGIN,
  pages: [],
  robotsTxt: null,
  sitemaps: null,
} as unknown as SiteData;

interface Measured {
  /** ruleId -> normalizedUrl -> verdict */
  readonly verdicts: Map<string, Map<string, string>>;
  /** cluster key -> member urls, multi-page clusters only, from the STORED column */
  readonly clusters: Array<{ fp: string; urls: string[] }>;
  readonly clusterCount: number;
  readonly pageCount: number;
}

async function measure(): Promise<Measured> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());

  const runner = createRunner(CONFIG);
  const verdicts = new Map<string, Map<string, string>>();

  for (const { url, html } of CORPUS) {
    const page = mkPage(url, html);
    const parsed = parseHtmlForRules(html, url);
    await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));

    const pageData: PageData = {
      url,
      html,
      statusCode: 200,
      loadTime: 12,
      headers: { "content-type": "text/html; charset=utf-8" },
      parsed,
      finalUrl: url,
    };
    const result = await runner.runPageRules(pageData, SITE_DATA);
    for (const [ruleId, rr] of result.ruleResults) {
      let byUrl = verdicts.get(ruleId);
      if (!byUrl) verdicts.set(ruleId, (byUrl = new Map()));
      byUrl.set(url, templateVerdictKey(rr.checks as unknown as Array<Record<string, unknown>>, url));
    }
  }

  const sq = await run(createSiteQuery(store, CRAWL));
  const clusters = sq.templateClusters().map((c) => ({ fp: c.fp, urls: [...c.urls] }));
  const all = await run(store.getPageFeatureTemplateClusters(CRAWL, { maxGroups: 1000, maxUrlsPerGroup: 1000 }));
  await run(store.close());

  return { verdicts, clusters, clusterCount: all.length, pageCount: CORPUS.length };
}

/** Rules that disagree inside a multi-page cluster, with the pair that proves it. */
function divergences(m: Measured, ruleIds: Iterable<string>): Map<string, { fp: string; a: string; b: string }> {
  const out = new Map<string, { fp: string; a: string; b: string }>();
  for (const ruleId of ruleIds) {
    const byUrl = m.verdicts.get(ruleId);
    if (!byUrl) continue;
    for (const { fp, urls } of m.clusters) {
      const present = urls.filter((u) => byUrl.has(u));
      if (present.length < 2) continue;
      const base = byUrl.get(present[0]!)!;
      const other = present.find((u) => byUrl.get(u) !== base);
      if (other) {
        out.set(ruleId, { fp, a: present[0]!, b: other });
        break;
      }
    }
  }
  return out;
}

const measured = await measure();
const pageRules = [...loadAllRules().values()].filter((r) => r.meta.scope === "page");
const fannable = pageRules.filter((r) => mayFanOutAcrossTemplate(r.meta)).map((r) => r.meta.id);
const perPage = pageRules.filter((r) => !mayFanOutAcrossTemplate(r.meta)).map((r) => r.meta.id);

// ---------------------------------------------------------------------------
// The corpus is only evidence if it is adversarial
// ---------------------------------------------------------------------------

describe("the fixture corpus has real multi-page clusters", () => {
  test("three templates cluster, and the two one-off pages do not", () => {
    expect(measured.clusters.length).toBe(3);
    expect(measured.clusters.map((c) => c.urls.length).sort()).toEqual([3, 4, 4]);
    // 5 groups in total: 3 templates + 2 singletons. `templateClusters()` reports
    // only the multi-page ones, which is why a singleton can never make a rule
    // look invariant here.
    expect(measured.clusterCount).toBe(3);
    const clustered = new Set(measured.clusters.flatMap((c) => c.urls));
    expect(clustered.has(`${ORIGIN}/contact`)).toBe(false);
    expect(clustered.has(`${ORIGIN}/status`)).toBe(false);
    expect(clustered.size).toBe(measured.pageCount - 2);
  });

  test("members of a cluster really do differ, page-rule-visibly", () => {
    // Without this the gate below could pass on a corpus of identical pages,
    // which is the exact way the synthetic sites answer this question wrongly.
    const varying = divergences(measured, perPage);
    expect(varying.size).toBeGreaterThanOrEqual(15);
  });

  test.each(fannable.map((id) => [id] as const))(
    "%s is actually compared here, on a non-empty verdict",
    (ruleId) => {
      // The other vacuity hole, and it has to be per-rule: an aggregate "60% of
      // them said something" lets a specific rule sail through in silence, which
      // is the one thing a per-rule classification cannot afford. Every declared
      // rule must produce a non-empty verdict on at least two members of a
      // multi-page cluster, so its pass here is a comparison and not an absence.
      //
      // A verdict of "no such element on this page" IS a verdict — it is what
      // fan-out would assert about the other members — so it counts. What does
      // not count is a rule that emitted nothing at all.
      const byUrl = measured.verdicts.get(ruleId);
      expect(byUrl).toBeDefined();
      const comparedOn = measured.clusters
        .map((c) => c.urls.filter((u) => (byUrl!.get(u) ?? "[]") !== "[]"))
        .find((present) => present.length >= 2);
      if (!comparedOn) {
        throw new Error(
          `${ruleId} declares verdictScope "template" but emitted no verdict on two members ` +
            "of any cluster in this corpus, so the gate below proves nothing about it.",
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("rules declaring verdictScope template are constant across a cluster", () => {
  test("the classification is not empty", () => {
    expect(fannable.length).toBeGreaterThan(20);
  });

  test.each(fannable.map((id) => [id] as const))(
    "%s gives one verdict per cluster",
    (ruleId) => {
      const byUrl = measured.verdicts.get(ruleId);
      if (!byUrl) return; // rule did not run on this corpus (gated by applicability)
      for (const { fp, urls } of measured.clusters) {
        const present = urls.filter((u) => byUrl.has(u));
        if (present.length < 2) continue;
        const base = present[0]!;
        for (const other of present.slice(1)) {
          // The failure message names the rule, the cluster and the two members,
          // so a failure is actionable without re-running anything.
          if (byUrl.get(other) !== byUrl.get(base)) {
            throw new Error(
              `${ruleId} is declared verdictScope "template" but disagrees inside cluster ${fp}:\n` +
                `  ${base}\n    ${byUrl.get(base)}\n` +
                `  ${other}\n    ${byUrl.get(other)}`,
            );
          }
        }
      }
    },
  );
});
