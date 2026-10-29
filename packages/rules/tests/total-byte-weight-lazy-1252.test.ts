// perf/total-byte-weight leaves lazy images below the initial viewport out of the page weight (#1252, #1251).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { totalByteWeightRule } from "../src/performance/total-byte-weight";
import type { RuleContext } from "../src/types";

const KB = 1024;
const PAGE = "https://example.com/lazy.html";

const doc = `<!doctype html><html><head><title>Image weight rule repro page for squirrel audits</title></head><body><main><h1>lazy</h1><p>Text.</p></main></body></html>`;

interface Img {
  url: string;
  size: number;
  extra?: { fallbackOnly?: boolean; deferredPages?: string[] };
}

function run(images: Img[], htmlBytes = 2 * KB) {
  const ctx = {
    page: { url: PAGE, html: doc, statusCode: 200, loadTime: 0, headers: {} },
    options: {},
    parsed: parsePage(doc, PAGE),
    site: {
      baseUrl: "https://example.com",
      pages: [{ url: PAGE, statusCode: 200, parsed: parsePage(doc, PAGE), sizeBytes: htmlBytes }],
      resourceSizes: {
        css: [],
        fonts: [],
        images: images.map((i) => ({
          url: i.url,
          status: 200,
          error: null,
          contentType: "image/jpeg",
          sizeBytes: i.size,
          sourcePages: [PAGE],
          ...i.extra,
        })),
      },
      scripts: [],
    },
  } as unknown as RuleContext;
  const check = totalByteWeightRule.run(ctx).checks[0]!;
  return {
    status: check.status,
    kb: Number.parseInt(check.value as string, 10),
    details: check.details ?? {},
  };
}

const lazy = (n: number, size = 400 * KB): Img => ({
  url: `https://example.com/lazy${n}.jpg`,
  size,
  extra: { deferredPages: [PAGE] },
});
const eager = (n: number, size = 400 * KB): Img => ({
  url: `https://example.com/eager${n}.jpg`,
  size,
});

describe("perf/total-byte-weight and lazy images (#1252)", () => {
  test("six 400 KB lazy images below the fold are not in the page weight and are reported apart", () => {
    const result = run([1, 2, 3, 4, 5, 6].map((n) => lazy(n)));
    expect(result.status).toBe("pass");
    expect(result.kb).toBe(2);
    expect(result.details.lazyImages).toBe("2400KB");
    expect(result.details.images).toBeUndefined();
  });

  test("eager images, and lazy images inside the initial viewport, still count", () => {
    // The engine leaves `deferredPages` off a lazy image it puts in the viewport budget.
    const result = run([
      eager(1),
      { url: "https://example.com/lazy-top.jpg", size: 400 * KB },
      lazy(2),
    ]);
    expect(result.kb).toBe(802);
    expect(result.details.images).toBe("800KB");
    expect(result.details.lazyImages).toBe("400KB");
  });

  test("the verdict follows the initial weight: eager images over the line still warn", () => {
    const result = run([eager(1, 1700 * KB), lazy(1, 3000 * KB)]);
    expect(result.status).toBe("warn");
    expect(result.details.lazyImages).toBe("3000KB");
  });

  test("a srcset fallback the browser does not download is not counted (#1251)", () => {
    const result = run([
      { url: "https://example.com/big.jpg", size: 300 * KB, extra: { fallbackOnly: true } },
      { url: "https://example.com/small.jpg", size: 40 * KB },
    ]);
    expect(result.details.images).toBe("40KB");
    expect(result.kb).toBe(42);
  });
});
