// perf/total-byte-weight fills its html and fonts buckets (#318).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import type { CollectedPageSignal } from "../src/collected-signals";
import { buildCollectedPageSignal } from "../src/collected-signals";
import { totalByteWeightRule } from "../src/performance/total-byte-weight";
import type { RuleContext } from "../src/types";

const BASE = "https://example.com";
const KB = 1024;

const html = (n: number): string =>
  `<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1></body></html>`;

const entry = (url: string, sizeBytes: number | null) => ({
  url,
  status: 200,
  error: null,
  contentType: null,
  sizeBytes,
  sourcePages: [BASE],
});

interface Fixture {
  htmlSizes: Array<number | null>;
  css?: number[];
  images?: number[];
  fonts?: Array<{ url: string; size: number }>;
}

function legacyCtx(f: Fixture): RuleContext {
  const pages = f.htmlSizes.map((sizeBytes, i) => ({
    url: `${BASE}/p${i}`,
    statusCode: 200,
    parsed: parsePage(html(i), `${BASE}/p${i}`),
    ...(sizeBytes === null ? {} : { sizeBytes }),
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
        css: (f.css ?? []).map((s, i) => entry(`${BASE}/c${i}.css`, s)),
        images: (f.images ?? []).map((s, i) => entry(`${BASE}/i${i}.png`, s)),
        ...(f.fonts ? { fonts: f.fonts.map((x) => entry(x.url, x.size)) } : {}),
      },
      scripts: [],
    },
  } as RuleContext;
}

function collectedCtx(f: Fixture, mutate?: (s: CollectedPageSignal) => void): RuleContext {
  const base = legacyCtx(f);
  const signals = f.htmlSizes.map((sizeBytes, i) => {
    const s = buildCollectedPageSignal({
      url: `${BASE}/p${i}`,
      parsed: parsePage(html(i), `${BASE}/p${i}`),
      htmlBytes: sizeBytes,
    });
    mutate?.(s);
    return s;
  });
  return { ...base, site: { ...base.site!, pages: [] }, collectedSignals: { pages: signals } };
}

const run = (ctx: RuleContext) => {
  const check = totalByteWeightRule.run(ctx).checks[0]!;
  return { kb: Number.parseInt(check.value as string, 10), details: check.details ?? {} };
};

const fixture: Fixture = {
  htmlSizes: [10 * KB, 20 * KB, 30 * KB],
  css: [100 * KB],
  images: [200 * KB],
  fonts: [
    { url: `${BASE}/f/a.woff2`, size: 40 * KB },
    { url: `${BASE}/f/b.woff2`, size: 50 * KB },
  ],
};
// html 60 + css 100 + images 200 + fonts 90
const EXPECTED_KB = 450;

describe("perf/total-byte-weight html and font buckets", () => {
  test("the total is the sum of every bucket (legacy site.pages path)", () => {
    const { kb, details } = run(legacyCtx(fixture));
    expect(kb).toBe(EXPECTED_KB);
    expect(details.html).toBe("60KB");
    expect(details.fonts).toBe("90KB");
    expect(details.fontFiles).toBe(2);
  });

  test("the streaming collector path reports the identical total and breakdown", () => {
    const legacy = run(legacyCtx(fixture));
    const streamed = run(collectedCtx(fixture));
    expect(streamed.kb).toBe(EXPECTED_KB);
    // pagesAnalyzed reads site.pages, which the streaming engine leaves empty.
    const { pagesAnalyzed: _a, ...legacyRest } = legacy.details;
    const { pagesAnalyzed: _b, ...streamedRest } = streamed.details;
    expect(streamedRest).toEqual(legacyRest);
  });

  test("a font listed twice is counted once", () => {
    const dup = {
      ...fixture,
      fonts: [...fixture.fonts!, { url: `${BASE}/f/a.woff2`, size: 40 * KB }],
    };
    const { kb, details } = run(legacyCtx(dup));
    expect(kb).toBe(EXPECTED_KB);
    expect(details.fontFiles).toBe(2);
  });

  test("negative control: no recorded size and no fonts adds nothing", () => {
    const bare: Fixture = { htmlSizes: [null, null], css: [100 * KB], images: [200 * KB] };
    for (const ctx of [legacyCtx(bare), collectedCtx(bare)]) {
      const { kb, details } = run(ctx);
      expect(kb).toBe(300);
      expect("html" in details).toBe(false);
      expect("fonts" in details).toBe(false);
    }
  });

  test("a collector snapshot cached before htmlBytes existed reads as no html weight", () => {
    const { kb } = run(
      collectedCtx(fixture, (s) => {
        delete (s as { htmlBytes?: number }).htmlBytes;
      })
    );
    expect(kb).toBe(EXPECTED_KB - 60);
  });
});
