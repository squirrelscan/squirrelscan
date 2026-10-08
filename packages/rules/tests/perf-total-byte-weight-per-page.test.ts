// perf/total-byte-weight scores each page on its own weight (#318).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { totalByteWeightRule } from "../src/performance/total-byte-weight";
import type { RuleContext } from "../src/types";

const BASE = "https://example.com";
const KB = 1024;

const html = (n: number): string =>
  `<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1></body></html>`;

interface Res {
  url: string;
  size: number | null;
  pages: string[];
}

interface Fixture {
  /** HTML document bytes, one entry per page at `${BASE}/p<i>`. */
  htmlSizes: number[];
  css?: Res[];
  js?: Res[];
  images?: Res[];
  fonts?: Res[];
}

const pageUrl = (i: number): string => `${BASE}/p${i}`;

const entry = (r: Res) => ({
  url: r.url,
  status: 200,
  error: null,
  contentType: null,
  sizeBytes: r.size,
  sourcePages: r.pages,
});

function baseCtx(f: Fixture): RuleContext {
  const pages = f.htmlSizes.map((sizeBytes, i) => ({
    url: pageUrl(i),
    statusCode: 200,
    parsed: parsePage(html(i), pageUrl(i)),
    sizeBytes,
  }));
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    options: {},
    parsed: pages[0]!.parsed,
    site: {
      baseUrl: BASE,
      pages,
      robotsTxt: null,
      sitemaps: null,
      resourceSizes: {
        css: (f.css ?? []).map(entry),
        images: (f.images ?? []).map(entry),
        fonts: (f.fonts ?? []).map(entry),
      },
      scripts: (f.js ?? []).map((r) => ({ ...entry(r), content: null })),
    },
  } as RuleContext;
}

/** The v1 resident engine reads `site.pages` documents. */
const residentCtx = baseCtx;

/** The streaming engine reads the page-time collected records instead. */
function streamingCtx(f: Fixture): RuleContext {
  const base = baseCtx(f);
  const signals = f.htmlSizes.map((htmlBytes, i) =>
    buildCollectedPageSignal({
      url: pageUrl(i),
      parsed: parsePage(html(i), pageUrl(i)),
      htmlBytes,
    }),
  );
  return {
    ...base,
    site: { ...base.site!, pages: [] },
    collectedSignals: { pages: signals },
  };
}

const engines = [
  ["resident", residentCtx],
  ["streaming", streamingCtx],
] as const;

const run = (ctx: RuleContext) => {
  const check = totalByteWeightRule.run(ctx).checks[0]!;
  return {
    status: check.status,
    kb: Number.parseInt(check.value as string, 10),
    details: check.details ?? {},
    message: check.message,
  };
};

describe("perf/total-byte-weight per-page scoring", () => {
  for (const [name, build] of engines) {
    test(`${name}: a page with known html, css, js, image and font sizes scores exactly their sum`, () => {
      const f: Fixture = {
        htmlSizes: [10 * KB],
        css: [{ url: `${BASE}/a.css`, size: 100 * KB, pages: [pageUrl(0)] }],
        js: [{ url: `${BASE}/a.js`, size: 200 * KB, pages: [pageUrl(0)] }],
        images: [{ url: `${BASE}/a.png`, size: 300 * KB, pages: [pageUrl(0)] }],
        fonts: [{ url: `${BASE}/a.woff2`, size: 40 * KB, pages: [pageUrl(0)] }],
      };
      const { kb, details } = run(build(f));
      expect(kb).toBe(650);
      expect(details.html).toBe("10KB");
      expect(details.css).toBe("100KB");
      expect(details.js).toBe("200KB");
      expect(details.images).toBe("300KB");
      expect(details.fonts).toBe("40KB");
      expect(details.heaviestPage).toBe(pageUrl(0));
    });

    test(`${name}: many small pages pass, the same bytes on one heavy page fail`, () => {
      // 600 pages of 10 KB html each is 6000 KB of html in total, over the
      // 5000 KB error threshold if it were summed across the site.
      const many: Fixture = {
        htmlSizes: Array.from({ length: 600 }, () => 10 * KB),
      };
      const small = run(build(many));
      expect(small.status).toBe("pass");
      expect(small.kb).toBe(10);
      expect(small.details.pagesOverWarn).toBe(0);

      const one: Fixture = {
        htmlSizes: [10 * KB],
        images: [
          { url: `${BASE}/huge.png`, size: 6000 * KB, pages: [pageUrl(0)] },
        ],
      };
      const heavy = run(build(one));
      expect(heavy.status).toBe("fail");
      expect(heavy.details.pagesOverError).toBe(1);
    });

    test(`${name}: a font and a stylesheet shared by two pages count toward both, once within each`, () => {
      const f: Fixture = {
        htmlSizes: [10 * KB, 20 * KB],
        // The same page listed twice must not double the resource within a page.
        css: [
          {
            url: `${BASE}/s.css`,
            size: 100 * KB,
            pages: [pageUrl(0), pageUrl(1), pageUrl(0)],
          },
        ],
        fonts: [
          {
            url: `${BASE}/f.woff2`,
            size: 50 * KB,
            pages: [pageUrl(0), pageUrl(1)],
          },
        ],
      };
      const { kb, details } = run(build(f));
      // p1 is the heavier page: 20 + 100 + 50.
      expect(kb).toBe(170);
      expect(details.heaviestPage).toBe(pageUrl(1));

      const onlyFirst = run(build({ ...f, htmlSizes: [10 * KB] }));
      expect(onlyFirst.kb).toBe(160);
    });

    test(`${name}: the output names the heaviest page and the pages over each threshold`, () => {
      const f: Fixture = {
        htmlSizes: [10 * KB, 10 * KB, 10 * KB],
        images: [
          { url: `${BASE}/warn.png`, size: 2000 * KB, pages: [pageUrl(1)] },
          { url: `${BASE}/err.png`, size: 5500 * KB, pages: [pageUrl(2)] },
        ],
      };
      const { status, details, message } = run(build(f));
      expect(status).toBe("fail");
      expect(details.heaviestPage).toBe(pageUrl(2));
      expect(details.heaviestPageKb).toBe("5510KB");
      expect(details.pagesOverWarn).toBe(2);
      expect(details.pagesOverError).toBe(1);
      expect(message).toContain(pageUrl(2));
      expect(message).toContain("2 over 1600KB, 1 over 5000KB");
    });

    test(`${name}: a resource with no size is reported, not silently counted as zero`, () => {
      const f: Fixture = {
        htmlSizes: [10 * KB],
        fonts: [
          { url: `${BASE}/nolen.woff2`, size: null, pages: [pageUrl(0)] },
        ],
      };
      const { kb, details, message } = run(build(f));
      expect(kb).toBe(10);
      expect(details.unsizedResources).toBe(1);
      expect(message).toContain("1 resource could not be sized");
    });
  }

  test("the resident and streaming engines report the same result", () => {
    const f: Fixture = {
      htmlSizes: [10 * KB, 20 * KB],
      css: [
        {
          url: `${BASE}/s.css`,
          size: 100 * KB,
          pages: [pageUrl(0), pageUrl(1)],
        },
      ],
      fonts: [{ url: `${BASE}/f.woff2`, size: 50 * KB, pages: [pageUrl(1)] }],
    };
    expect(run(streamingCtx(f))).toEqual(run(residentCtx(f)));
  });

  test("a collector snapshot cached before htmlBytes existed reads as no html weight", () => {
    const f: Fixture = { htmlSizes: [10 * KB] };
    const ctx = streamingCtx(f);
    delete (ctx.collectedSignals!.pages[0] as { htmlBytes?: number }).htmlBytes;
    expect(run(ctx).kb).toBe(0);
  });
});
