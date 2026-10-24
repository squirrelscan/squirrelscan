// links/broken-anchors — a link to #fragment whose target id does not exist.
//
// Every behaviour runs on both inputs the rule reads: the DOM the v1 engine
// holds on each page (site.pages[].parsed.document), and the per-page record
// the streaming engine collects while the DOM is live (ctx.collectedSignals,
// with the DOM dropped from site.pages). Both must give the same answer, so
// the parity test at the end compares the two outputs for one mixed site.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { skipLinkRule } from "../src/a11y/skip-link";
import { buildCollectedPageSignal } from "../src/collected-signals";
import { brokenAnchorsRule } from "../src/links/broken-anchors";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

interface Fixture {
  path: string;
  html?: string;
  status?: number;
  rendered?: boolean;
}

const emptyParsed = (): ParsedPage => ({ document: null, links: [] }) as unknown as ParsedPage;

/** The site's page universe, as the engines build it: error pages carry no document. */
function sitePages(fixtures: Fixture[]) {
  return fixtures.map((f) => {
    const url = `${BASE}${f.path}`;
    const statusCode = f.status ?? 200;
    const parsed =
      statusCode >= 400 || f.html === undefined ? emptyParsed() : parsePage(f.html, url);
    return { url, statusCode, parsed, rendered: f.rendered === true };
  });
}

/** v1: the DOM is on every page. */
function domContext(fixtures: Fixture[]): RuleContext {
  return {
    site: { baseUrl: BASE, pages: sitePages(fixtures), robotsTxt: null, sitemaps: null },
  } as unknown as RuleContext;
}

/** Streaming: the DOM is dropped after the page pass; the record was collected live. */
function streamContext(fixtures: Fixture[]): RuleContext {
  const pages = sitePages(fixtures);
  const collectedSignals = {
    pages: pages
      .filter((p) => p.statusCode < 400 && p.parsed.document)
      .map((p) =>
        buildCollectedPageSignal({
          url: p.url,
          parsed: p.parsed,
          rendered: p.rendered,
        }),
      ),
  };
  return {
    site: {
      baseUrl: BASE,
      pages: pages.map((p) => ({ ...p, parsed: { ...p.parsed, document: null } })),
      robotsTxt: null,
      sitemaps: null,
    },
    collectedSignals,
  } as unknown as RuleContext;
}

const ENGINES: Array<[string, (f: Fixture[]) => RuleContext]> = [
  ["DOM (v1)", domContext],
  ["collected (streaming)", streamContext],
];

function run(ctx: RuleContext): CheckResult[] {
  return brokenAnchorsRule.run(ctx).checks;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

/** The broken-anchors warning, or undefined when the rule found nothing. */
function warning(checks: CheckResult[]): CheckResult | undefined {
  return check(checks, "broken-anchors")?.status === "warn"
    ? check(checks, "broken-anchors")
    : undefined;
}

const page = (body: string) =>
  `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

for (const [engine, build] of ENGINES) {
  describe(`links/broken-anchors — ${engine}`, () => {
    test("same-page link to a missing id is a warning naming the link, fragment and page", () => {
      const checks = run(
        build([{ path: "/", html: page('<a href="#pricing">Pricing</a><h1>Home</h1>') }]),
      );
      const w = warning(checks)!;
      expect(w).toBeDefined();
      expect(w.items).toHaveLength(1);
      expect(w.items![0]!.label).toContain("#pricing");
      expect(w.items![0]!.sourcePages).toEqual([`${BASE}/`]);
    });

    test("an element with that id, or an <a name>, satisfies the link", () => {
      const withId = run(
        build([
          { path: "/", html: page('<a href="#pricing">P</a><section id="pricing">x</section>') },
        ]),
      );
      expect(warning(withId)).toBeUndefined();

      const withName = run(
        build([{ path: "/", html: page('<a href="#pricing">P</a><a name="pricing">x</a>') }]),
      );
      expect(warning(withName)).toBeUndefined();
    });

    test("a link into another crawled page with no such id names that page and its source", () => {
      const checks = run(
        build([
          { path: "/", html: page('<a href="/b#install">Install</a>') },
          { path: "/b", html: page("<h1>Setup</h1><p>no anchor here</p>") },
        ]),
      );
      const w = warning(checks)!;
      expect(w.items).toHaveLength(1);
      expect(w.items![0]!.label).toContain("/b#install");
      expect(w.items![0]!.sourcePages).toEqual([`${BASE}/`]);
    });

    test("five pages sharing one nav link to a missing id make one finding listing all five", () => {
      const nav = '<a href="/#pricing">Pricing</a>';
      const checks = run(
        build([
          { path: "/", html: page("<h1>Home</h1>") },
          { path: "/p1", html: page(nav) },
          { path: "/p2", html: page(nav) },
          { path: "/p3", html: page(nav) },
          { path: "/p4", html: page(nav) },
          { path: "/p5", html: page(nav) },
        ]),
      );
      const w = warning(checks)!;
      expect(w.items).toHaveLength(1);
      expect(w.items![0]!.sourcePages).toHaveLength(5);
    });

    test("fragments the rule does not judge produce no finding", () => {
      const checks = run(
        build([
          {
            path: "/",
            html: page(
              '<a href="#">a</a><a href="#top">b</a><a href="#/settings">c</a><a href="#!/home">d</a>' +
                '<a href="#access_token=abc">e</a><a href="#:~:text=hello">f</a>',
            ),
          },
        ]),
      );
      expect(warning(checks)).toBeUndefined();
    });

    test("links to pages the crawl did not fetch, or that answered an error, are not judged", () => {
      const checks = run(
        build([
          { path: "/", html: page('<a href="/c#x">c</a><a href="/d#x">d</a>') },
          { path: "/d", status: 404 },
        ]),
      );
      expect(warning(checks)).toBeUndefined();
    });

    test("percent-encoded ids match their decoded form; ids are case-sensitive", () => {
      const matched = run(
        build([{ path: "/", html: page('<a href="#caf%C3%A9">c</a><h2 id="café">Café</h2>') }]),
      );
      expect(warning(matched)).toBeUndefined();

      const cased = run(
        build([{ path: "/", html: page('<a href="#Pricing">P</a><h2 id="pricing">x</h2>') }]),
      );
      const w = warning(cased)!;
      expect(w.items![0]!.label).toContain("#Pricing");
    });

    test("an unrendered client-side shell target is unconfirmed (info), not a warning", () => {
      const checks = run(
        build([
          { path: "/", html: page('<a href="/app#settings">Settings</a>') },
          {
            path: "/app",
            html: '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
            rendered: false,
          },
        ]),
      );
      expect(warning(checks)).toBeUndefined();
      const info = check(checks, "unconfirmed-anchors")!;
      expect(info.status).toBe("info");
      expect(info.items![0]!.label).toContain("/app#settings");
    });

    test("the same shell fetched with rendering is a real miss, so a warning", () => {
      const checks = run(
        build([
          { path: "/", html: page('<a href="/app#settings">Settings</a>') },
          {
            path: "/app",
            html: '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
            rendered: true,
          },
        ]),
      );
      expect(warning(checks)).toBeDefined();
      expect(check(checks, "unconfirmed-anchors")).toBeUndefined();
    });

    test("a skip link to a missing target is reported once, labelled as a skip link", () => {
      const fixtures: Fixture[] = [
        {
          path: "/",
          html: page(
            '<a class="skip-link" href="#main-content">Skip to content</a><main><h1>Hi</h1></main>',
          ),
        },
      ];
      const w = warning(run(build(fixtures)))!;
      expect(w.items).toHaveLength(1);
      expect(w.items![0]!.label).toContain("(skip link)");
      expect(w.items![0]!.label).toContain("#main-content");
    });

    test("ids beyond the per-page cap are not judged", () => {
      const many = Array.from({ length: 600 }, (_, i) => `<div id="x${i}"></div>`).join("");
      const checks = run(
        build([
          { path: "/", html: page('<a href="/big#x599">a</a><a href="/big#missing">b</a>') },
          { path: "/big", html: page(many) },
        ]),
      );
      expect(warning(checks)).toBeUndefined();
    });
  });
}

for (const [engine, build] of ENGINES) {
  describe(`links/broken-anchors review fixes: ${engine}`, () => {
    test("purely numeric fragments (#0, #1) are template do-nothing links, not judged", () => {
      const checks = run(
        build([
          { path: "/", html: page('<a href="#0">Menu</a><a href="#1">Close</a><h1>Home</h1>') },
        ]),
      );
      expect(warning(checks)).toBeUndefined();
      expect(check(checks, "broken-anchors")?.details).toMatchObject({ anchorLinks: 0 });
    });

    test("a nav link repeated on every page is one finding listing each page once", () => {
      const nav = '<a href="/#gone">Gone</a><a href="/#gone">Gone again</a>';
      const pages: Fixture[] = [{ path: "/", html: page("<h1>Home</h1>") }];
      for (let n = 0; n < 40; n++) pages.push({ path: `/p${n}`, html: page(nav) });
      const w = warning(run(build(pages)))!;
      expect(w.items).toHaveLength(1);
      const sources = w.items![0]!.sourcePages!;
      expect(sources).toHaveLength(40);
      expect(new Set(sources).size).toBe(40);
      expect(sources[0]).toBe(`${BASE}/p0`);
      expect(w.items![0]!.meta).toMatchObject({ linkedFrom: 40 });
    });
  });
}

describe("links/broken-anchors: cached streaming records", () => {
  test("records cached before the anchor field existed are skipped, not passed", () => {
    const ctx = streamContext([{ path: "/", html: page('<a href="#gone">x</a>') }]);
    for (const rec of ctx.collectedSignals!.pages) delete (rec as { anchors?: unknown }).anchors;
    const checks = run(ctx);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.message).toContain("--refresh");
  });

  test("a page with a null record (no document) still lets the others be judged", () => {
    const ctx = streamContext([
      { path: "/", html: page('<a href="#gone">x</a>') },
      { path: "/b", html: page("<h1>b</h1>") },
    ]);
    (ctx.collectedSignals!.pages[1] as { anchors?: unknown }).anchors = null;
    expect(warning(run(ctx))).toBeDefined();
  });
});

describe("links/broken-anchors — streaming parity", () => {
  test("the v1 DOM path and the streamed record path give identical checks for one site", () => {
    const fixtures: Fixture[] = [
      {
        path: "/",
        html: page(
          '<a href="#pricing">P</a><a href="/b#install">I</a><a href="#top">t</a><a href="/app#settings">S</a><h1 id="home">Home</h1>',
        ),
      },
      { path: "/b", html: page("<h1>Setup</h1>") },
      {
        path: "/c",
        html: page('<a href="/#pricing">nav</a><a href="/#home">ok</a><a name="deep">d</a>'),
      },
      { path: "/c2", html: page('<a href="/c#deep">ok</a><a href="/c#gone">miss</a>') },
      {
        path: "/app",
        html: '<!doctype html><html><head><script src="/a.js"></script></head><body><div id="root"></div></body></html>',
      },
      { path: "/gone", status: 404 },
      { path: "/z", html: page('<a href="/gone#x">broken target, not judged</a>') },
    ];
    const v1 = run(domContext(fixtures));
    const streamed = run(streamContext(fixtures));
    expect(streamed).toEqual(v1);
    expect(warning(v1)).toBeDefined();
  });

  test("the a11y/skip-link verdict is unchanged by this rule", () => {
    const html = page(
      '<a class="skip-link" href="#main-content">Skip to content</a><main><h1>Hi</h1></main>',
    );
    const parsed = parsePage(html, `${BASE}/`);
    const { checks } = skipLinkRule.run({ parsed } as unknown as RuleContext);
    expect(checks[0]!.name).toBe("skip-link");
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.message).toBe("Skip link found");
  });
});

// #2307: where the broken anchor links sit.
for (const [engine, build] of ENGINES) {
  describe(`links/broken-anchors — link sections, ${engine}`, () => {
    const fixtures: Fixture[] = [
      {
        path: "/",
        html: page(
          '<footer><a href="/guide#gone">Guide</a></footer><main><a href="/guide#gone">Guide again</a></main>',
        ),
      },
      { path: "/guide", html: page("<h1>Guide</h1>") },
    ];

    test("an item says where its links sit and carries meta.sections", () => {
      const w = warning(run(build(fixtures)))!;

      expect(w.items).toHaveLength(1);
      expect(w.items![0]!.label).toBe(`${BASE}/guide#gone, linked in the page content and the footer`);
      expect(w.items![0]!.meta).toEqual({
        skipLink: false,
        sections: { footer: 1, content: 1 },
        linkedFrom: 1,
      });
    });

    test("a same-page link has no section and the item stays as it was", () => {
      const w = warning(run(build([{ path: "/", html: page('<a href="#pricing">P</a>') }])))!;

      expect(w.items![0]!.label).toBe(`${BASE}/#pricing`);
      expect(w.items![0]!.meta).toEqual({ skipLink: false, linkedFrom: 1 });
    });
  });
}
