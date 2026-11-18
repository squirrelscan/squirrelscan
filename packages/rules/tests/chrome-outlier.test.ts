// integrity/chrome-outlier (#1367): pages left on an outdated or broken template.
//
// Every case runs the legacy (ctx.site.pages) and streaming (ctx.siteQuery) paths and
// requires byte-identical output. The streamed rows carry a template label as their
// stored key, which is all the rule reads from them.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { chromeOutlierRule } from "../src/integrity/chrome-outlier";
import { fingerprintPage } from "../src/integrity/fingerprint";
import { templateDiscontinuityRule } from "../src/integrity/template-discontinuity";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

const SITE = "https://example.com";
const u = (path: string): string => `${SITE}${path}`;

type Kind =
  | "main"
  | "old"
  | "bare"
  | "alien"
  | "docs"
  | "blog"
  | "landing"
  | "chunk"
  | "restyled"
  | "post"
  | "about"
  | "contact"
  | "home"
  | "moved";

const NAV = `<nav><a href="/">Home</a></nav>`;
const FOOT = `<footer>(c) example</footer>`;

function html(kind: Kind, i: number): string {
  const head = (css: string, extra = "") =>
    `<title>Page ${i}</title><link rel="stylesheet" href="${css}">${extra}`;
  switch (kind) {
    case "main":
      return `<html><head>${head("/theme/v2.css", `<script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v2 site">${NAV}<main>Body ${i}</main>${FOOT}</body></html>`;
    case "old": // the pre-redesign stylesheet: lacks the site's /theme/v2.css
      return `<html><head>${head("/theme/v1.css", `<script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v1 legacy">${NAV}<main>Body ${i}</main>${FOOT}</body></html>`;
    case "chunk": // the full site chrome plus a route-level CSS chunk and body class
      return `<html><head>${head("/theme/v2.css", `<link rel="stylesheet" href="/assets/route-pricing.css"><script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v2 site page-pricing">${NAV}<main>Body ${i}</main>${FOOT}</body></html>`;
    case "restyled": // the full site chrome, only the body classes and CSS variables differ
      return `<html><head>${head("/theme/v2.css", `<script src="https://cdn.example.com/app.js"></script><style>:root{--accent:red}</style>`)}</head><body class="v2 dark-mode">${NAV}<main>Body ${i}</main>${FOOT}</body></html>`;
    case "bare": // same stylesheet and host, lost nav and footer
      return `<html><head>${head("/theme/v2.css", `<script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v2 site"><main>Body ${i}</main></body></html>`;
    case "alien": // shares nothing: template-discontinuity territory
      return `<html><head><title>Alien ${i}</title><link rel="stylesheet" href="https://other.test/x.css"><script src="https://other.test/y.js"></script></head><body class="zzz"><main>x</main></body></html>`;
    case "docs":
      return `<html><head>${head("/docs.css", `<script src="https://cdn.example.com/docs.js"></script>`)}</head><body class="docs">${NAV}<main>${i}</main>${FOOT}</body></html>`;
    case "blog":
      return `<html><head>${head("/blog.css", `<script src="https://cdn.example.com/blog.js"></script>`)}</head><body class="blog">${NAV}<main>${i}</main>${FOOT}</body></html>`;
    case "post": // a blog post: site chrome plus a post stylesheet, an image CDN and a preconnect
      return `<html><head>${head("/theme/v2.css", `<link rel="stylesheet" href="/theme/post.css"><link rel="preconnect" href="https://fonts.example.net"><script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v2 site post">${NAV}<main><img src="https://images.example-cdn.net/p${i}.jpg">Body ${i}</main>${FOOT}</body></html>`;
    case "about": // a singleton page: the site stylesheet and script only
      return `<html><head>${head("/theme/v2.css", `<script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v2 site about">${NAV}<main>About ${i}</main>${FOOT}</body></html>`;
    case "contact": // a singleton page with its own form script and no app bundle
      return `<html><head>${head("/theme/v2.css", `<script src="/forms.js"></script>`)}</head><body class="v2 site contact">${NAV}<main>Contact ${i}</main>${FOOT}</body></html>`;
    case "home": // a singleton home page with its own hero stylesheet and image
      return `<html><head>${head("/theme/v2.css", `<link rel="stylesheet" href="/theme/home.css"><script src="https://cdn.example.com/app.js"></script>`)}</head><body class="v2 site home">${NAV}<main><img src="/hero.jpg">Home ${i}</main>${FOOT}</body></html>`;
    case "moved": // the old theme served from a retired asset host: no site stylesheet or code host left
      return `<html><head><title>Page ${i}</title><link rel="stylesheet" href="https://old-assets.example.org/theme.css"><script src="https://old-assets.example.org/app.js"></script></head><body class="v1">${NAV}<main>Body ${i}</main>${FOOT}</body></html>`;
    case "landing":
      return `<html><head>${head("/landing.css", `<script src="https://cdn.example.com/lp.js"></script>`)}</head><body class="lp">${NAV}<main>${i}</main>${FOOT}</body></html>`;
  }
}

interface Spec {
  path: string;
  kind: Kind;
  status?: number;
}

const many = (kind: Kind, n: number, prefix = kind): Spec[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/${prefix}/${i}`, kind }));

const baseCtx = {
  page: { url: SITE, html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as ParsedPage,
  options: {},
};

const opts = () => {
  const schema = chromeOutlierRule.meta.optionsSchema!;
  return schema.parse({}) as Record<string, unknown>;
};

function legacyCtx(specs: Spec[]): RuleContext {
  return {
    ...baseCtx,
    options: opts(),
    site: {
      baseUrl: SITE,
      pages: specs.map((s, i) => ({
        url: u(s.path),
        statusCode: s.status ?? 200,
        parsed: parsePage(html(s.kind, i), u(s.path)),
        headers: {} as Record<string, string>,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

function streamCtx(specs: Spec[], withCollected = true): RuleContext {
  const parsed = specs.map((s, i) => parsePage(html(s.kind, i), u(s.path)));
  const rows = specs.map(
    (s) => ({ normalizedUrl: u(s.path), status: s.status ?? 200, templateFp: s.kind }) as PageFeatureRow
  );
  const unused = (): never => {
    throw new Error("chrome-outlier must not use this SiteQuery method");
  };
  const siteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    contextualIncomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (r: PageFeatureRow) => boolean) {
      for (const r of rows) if (pred(r)) yield r;
    },
  } as unknown as SiteQuery;
  return {
    ...baseCtx,
    options: opts(),
    siteQuery,
    ...(withCollected
      ? {
          collectedSignals: {
            pages: specs.map((s, i) => ({
              url: u(s.path),
              fingerprint: fingerprintPage(parsed[i]!, u(s.path)),
              signals: [],
            })),
          },
        }
      : {}),
  } as unknown as RuleContext;
}

async function run(rule: Rule, ctx: RuleContext): Promise<CheckResult[]> {
  return (await rule.run(ctx)).checks;
}

async function bothPaths(specs: Spec[]): Promise<CheckResult> {
  const legacy = await run(chromeOutlierRule, legacyCtx(specs));
  const streamed = await run(chromeOutlierRule, streamCtx(specs));
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

describe("integrity/chrome-outlier", () => {
  test("a uniform site passes", async () => {
    expect((await bothPaths(many("main", 20))).status).toBe("pass");
  });

  test("a few pages on the old template warn", async () => {
    const check = await bothPaths([...many("main", 38), ...many("old", 2)]);
    expect(check.status).toBe("warn");
    expect(check.items?.map((i) => i.id)).toEqual([u("/old/0"), u("/old/1")]);
    expect(check.items?.[0]?.label).toBe("Missing site stylesheets");
    expect(check.message).toContain("outdated or broken site template");
  });

  test("a singleton that lost its nav and footer is flagged", async () => {
    const check = await bothPaths([...many("main", 15), ...many("bare", 1)]);
    expect(check.status).toBe("warn");
    expect(check.items?.map((i) => i.id)).toEqual([u("/bare/0")]);
    expect(check.items?.[0]?.label).toBe("Missing navigation, footer");
  });

  test("a route-level CSS chunk or body class on top of the site chrome is not flagged", async () => {
    const check = await bothPaths([...many("main", 20), ...many("chunk", 1), ...many("restyled", 2)]);
    expect(check.status).toBe("pass");
  });

  test("only pages missing dominant chrome are flagged among small clusters", async () => {
    const check = await bothPaths([...many("main", 20), ...many("chunk", 1), ...many("bare", 1)]);
    expect(check.items?.map((i) => i.id)).toEqual([u("/bare/0")]);
  });

  test("singleton pages on a blog whose posts load extra assets are not flagged", async () => {
    // 27 posts share a template that adds a post stylesheet, an image CDN and a
    // preconnect host to the site chrome. The about, contact and home pages keep
    // the site stylesheet, nav and footer, so they are not on an old template.
    const check = await bothPaths([
      ...many("post", 27),
      ...many("about", 1),
      ...many("contact", 1),
      ...many("home", 1),
    ]);
    expect(check.status).toBe("pass");
  });

  test("a page that shares no stylesheet or code host with the template is flagged", async () => {
    const check = await bothPaths([...many("main", 20), ...many("moved", 1)]);
    expect(check.items?.map((i) => i.id)).toEqual([u("/moved/0")]);
    expect(check.items?.[0]?.label).toBe("Missing site stylesheets, site CSS and script hosts");
  });

  test("a streamed page without a page-time fingerprint is not reported", async () => {
    const specs = [...many("main", 15), ...many("bare", 1)];
    const checks = await run(chromeOutlierRule, streamCtx(specs, false));
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("many stragglers fail", async () => {
    const check = await bothPaths([...many("main", 24), ...many("old", 2), ...many("bare", 2)]);
    expect(check.status).toBe("fail");
    expect(check.items).toHaveLength(4);
  });

  test("a site below the page floor is skipped", async () => {
    const check = await bothPaths([...many("main", 8), ...many("old", 1)]);
    expect(check.status).toBe("skipped");
  });

  test("a single-page site is skipped", async () => {
    expect((await bothPaths(many("main", 1))).status).toBe("skipped");
  });

  test("no dominant template is skipped", async () => {
    const check = await bothPaths([...many("main", 6), ...many("docs", 5), ...many("blog", 5)]);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("No dominant template cluster");
  });

  test("several evenly sized templates with one dominant stay clean", async () => {
    const check = await bothPaths([
      ...many("main", 36),
      ...many("docs", 5),
      ...many("blog", 4),
      ...many("landing", 4),
    ]);
    expect(check.status).toBe("pass");
  });

  test("error pages do not count as stragglers", async () => {
    const specs = [...many("main", 15), { path: "/missing", kind: "bare" as Kind, status: 404 }];
    expect((await bothPaths(specs)).status).toBe("pass");
  });

  test("a page template-discontinuity reports is not reported here", async () => {
    const specs = [...many("main", 20), ...many("alien", 1), ...many("old", 1)];
    const discontinuity = await run(templateDiscontinuityRule, {
      ...legacyCtx(specs),
      options: templateDiscontinuityRule.meta.optionsSchema!.parse({}) as Record<string, unknown>,
    });
    const flagged = discontinuity.flatMap((c) => c.items ?? []).map((i) => i.id);
    expect(flagged).toContain(u("/alien/0"));

    const check = await bothPaths(specs);
    const ids = (check.items ?? []).map((i) => i.id);
    expect(ids).toEqual([u("/old/0")]);
    for (const id of flagged) expect(ids).not.toContain(id);
  });
});
