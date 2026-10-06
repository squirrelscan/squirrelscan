// images/responsive-size reports a small image only on evidence that its file
// is oversized (#464).
//
// It used to flag every image displayed at 100px or less without a srcset,
// including a 168-byte PNG shown at its natural 64x64. The evidence it can have
// is the file's byte size from the pre-rules resource check: a file heavier
// than the raw RGBA bitmap of its displayed box at 2x density holds more pixels
// than a screen draws there.

import { describe, expect, test } from "bun:test";

import type { ResourceSizeData } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { responsiveSizeRule } from "../src/images/responsive-size";
import type { CheckResult, RuleContext } from "../src/types";

const PAGE = "https://example.com/gallery/";

function resource(path: string, sizeBytes: number | null): ResourceSizeData {
  return {
    url: new URL(path, PAGE).toString(),
    status: 200,
    error: null,
    contentType: "image/png",
    sizeBytes,
    sourcePages: [PAGE],
  };
}

function run(
  body: string,
  images: ResourceSizeData[] = [],
  page: { url: string; finalUrl?: string } = { url: PAGE },
  parsedUnder: string = page.finalUrl ?? page.url
): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>Gallery</title></head><body><main><h1>Gallery</h1>${body}</main></body></html>`;
  const ctx = {
    page: { ...page, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, parsedUnder),
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      resourceSizes: { css: [], images },
    },
    options: {},
  } as unknown as RuleContext;
  const result = responsiveSizeRule.run(ctx);
  if (result instanceof Promise) throw new Error("responsive-size is async");
  return result.checks;
}

function oversized(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((c) => c.name === "images-possibly-oversized");
}

// The budget for a 64x64 box: (64 * 2) * (64 * 2) * 4 bytes.
const BUDGET_64 = 128 * 128 * 4;

describe("images at their natural size are not reported", () => {
  test("the #464 repro: 64-150px PNGs of a few hundred bytes", () => {
    const body = [64, 100, 101, 150, 300]
      .map((n) => `<img src="i${n}.png" width="${n}" height="${n}" alt="x">`)
      .join("");
    const sizes = { 64: 168, 100: 334, 101: 337, 150: 497, 300: 1058 } as const;
    const checks = run(
      body,
      Object.entries(sizes).map(([n, bytes]) => resource(`i${n}.png`, bytes))
    );
    expect(oversized(checks)).toBeUndefined();
    expect(checks).toEqual([
      {
        name: "responsive-size",
        status: "pass",
        message: "Image sizes appear appropriate",
        details: { imagesChecked: 5 },
      },
    ]);
  });

  test("a small image with no measured size is not reported", () => {
    // Third-party host, a check that was skipped, or one that failed.
    expect(oversized(run(`<img src="https://cdn.example.net/a.jpg" width="64" height="64">`))).toBeUndefined();
    expect(oversized(run(`<img src="a.jpg" width="64" height="64">`, [resource("a.jpg", null)]))).toBeUndefined();
  });
});

describe("evidence of oversizing is still reported", () => {
  test("a 1200px photo displayed at 64x64", () => {
    const check = oversized(
      run(`<img src="/photos/full.jpg" width="64" height="64" alt="x">`, [
        resource("/photos/full.jpg", 400_000),
      ])
    );
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe(
      "1 small image(s) serve files larger than their displayed size needs"
    );
    expect(check?.items).toEqual([
      {
        id: "full.jpg (64x64, no srcset)",
        label: "full.jpg (64x64, 390.6 KB, no srcset)",
        meta: {
          url: "https://example.com/photos/full.jpg",
          sizeBytes: 400_000,
          budgetBytes: BUDGET_64,
        },
      },
    ]);
  });

  test("the budget plus Lighthouse's 4 KiB savings threshold is the line", () => {
    const img = `<img src="a.png" width="64" height="64">`;
    expect(oversized(run(img, [resource("a.png", BUDGET_64 + 4095)]))).toBeUndefined();
    expect(oversized(run(img, [resource("a.png", BUDGET_64 + 4096)]))?.status).toBe("warn");
  });

  test("relative sources resolve against the page URL", () => {
    const check = oversized(
      run(`<img src="../img/a.png?v=2" width="40" height="40">`, [
        resource("/img/a.png?v=2", 500_000),
      ])
    );
    expect(check?.items?.map((i) => i.id)).toEqual(["a.png (40x40, no srcset)"]);
  });

  test("a lazy-loaded image is looked up by the source the parser recorded", () => {
    // The resource check measures data-src, not the placeholder in src.
    const check = oversized(
      run(`<img src="placeholder.png" data-src="full.jpg" width="64" height="64">`, [
        resource("placeholder.png", 100),
        resource("full.jpg", 400_000),
      ])
    );
    expect(check?.items?.map((i) => i.id)).toEqual(["full.jpg (64x64, no srcset)"]);
  });

  test("a redirected page is matched under the URL its parse resolved against", () => {
    // Crawl-time parses resolve against the final URL, a re-parse against the
    // requested one; the measured entry carries whichever was used.
    const page = { url: "https://example.com/old/", finalUrl: "https://example.com/new/" };
    const img = `<img src="a.jpg" width="64" height="64">`;
    for (const base of [page.url, page.finalUrl]) {
      const entry = { ...resource("a.jpg", 400_000), url: new URL("a.jpg", base).toString() };
      expect(oversized(run(img, [entry], page, base))?.status).toBe("warn");
    }
  });

  test("an entry another page recorded under the other base is not borrowed", () => {
    // This page parsed under /new/, so its image is /new/a.jpg, unmeasured.
    // /old/a.jpg belongs to some other page.
    const page = { url: "https://example.com/old/", finalUrl: "https://example.com/new/" };
    const entry = { ...resource("a.jpg", 400_000), url: "https://example.com/old/a.jpg" };
    const img = `<img src="a.jpg" width="64" height="64">`;
    expect(oversized(run(img, [entry], page, page.finalUrl))).toBeUndefined();
  });

  test("each image keeps its own URL when the two bases collide", () => {
    // Re-parsed under /old/: "a.jpg" is /old/a.jpg, while the second image IS
    // /new/a.jpg. Matching by URL alone would hand the first image the second
    // one's 400 KB.
    const page = { url: "https://example.com/old/", finalUrl: "https://example.com/new/" };
    const body = `<img src="a.jpg" width="64" height="64"><img src="/new/a.jpg" width="800" height="800">`;
    const images = [
      { ...resource("a.jpg", 168), url: "https://example.com/old/a.jpg" },
      { ...resource("a.jpg", 400_000), url: "https://example.com/new/a.jpg" },
    ];
    expect(oversized(run(body, images, page, page.url))).toBeUndefined();
  });

  test("more than ten are capped with a remainder count", () => {
    const body = Array.from({ length: 12 }, (_, i) => `<img src="p${i}.jpg" width="50" height="50">`).join("");
    const check = oversized(
      run(body, Array.from({ length: 12 }, (_, i) => resource(`p${i}.jpg`, 300_000)))
    );
    expect(check?.items).toHaveLength(10);
    expect(check?.details).toEqual({ additional: 2 });
  });
});

describe("images the rule does not judge", () => {
  const heavy = (path: string) => [resource(path, 2_000_000)];

  test.each([
    ["a srcset", `<img src="a.jpg" srcset="a.jpg 1x, a@2x.jpg 2x" width="64" height="64">`, "a.jpg"],
    ["a <picture> parent", `<picture><img src="a.jpg" width="64" height="64"></picture>`, "a.jpg"],
    ["an SVG", `<img src="a.SVG" width="64" height="64">`, "a.SVG"],
    ["an SVG with a fragment", `<img src="sprite.svg#icon" width="24" height="24">`, "sprite.svg#icon"],
    ["a GIF with trailing whitespace", `<img src="spin.gif " width="40" height="40">`, "spin.gif"],
    ["an ICO", `<img src="favicon.ico" width="32" height="32">`, "favicon.ico"],
    ["a GIF, whose frames multiply its bytes", `<img src="spin.gif" width="40" height="40">`, "spin.gif"],
    ["a display size over max_thumbnail_dimension", `<img src="a.jpg" width="101" height="64">`, "a.jpg"],
    ["a percentage size", `<img src="a.jpg" width="50%" height="50%">`, "a.jpg"],
    ["an image inside <noscript>", `<noscript><img src="a.jpg" width="64" height="64"></noscript>`, "a.jpg"],
  ])("%s", (_label, body, path) => {
    expect(oversized(run(body, heavy(path)))).toBeUndefined();
  });
});
