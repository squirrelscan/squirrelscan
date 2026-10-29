// The asset collector records which image file a browser downloads and whether it loads at page
// load, so size and weight rules count what visitors fetch (#1250, #1251, #1252).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import {
  absorbResourceOccurrences,
  emptySiteAssetOccurrences,
  imageLoadFlags,
} from "../src/adapter";

const BASE = "https://example.com";

function collect(body: string, pageUrl = `${BASE}/p.html`) {
  const html = `<!doctype html><html><head><title>Image load occurrences fixture page</title></head><body>${body}</body></html>`;
  const occurrences = emptySiteAssetOccurrences();
  absorbResourceOccurrences(
    occurrences,
    [{ url: pageUrl, finalUrl: pageUrl, parsed: parsePage(html, pageUrl) }],
    BASE,
  );
  return occurrences;
}

const flags = (o: ReturnType<typeof collect>, path: string) => imageLoadFlags(o, `${BASE}${path}`);

describe("srcset candidate selection (#1251)", () => {
  const o = collect(
    `<img src="big.jpg" srcset="small.jpg 400w, big.jpg 960w" sizes="180px" width="180" height="250" alt="Card">`,
  );

  test("both files are still measured, the fallback is marked as not downloaded", () => {
    expect([...o.images.keys()].sort()).toEqual([`${BASE}/big.jpg`, `${BASE}/small.jpg`]);
    expect(flags(o, "/big.jpg")).toEqual({ fallbackOnly: true });
    expect(flags(o, "/small.jpg")).toEqual({});
  });

  test("an image without srcset is its own selected file", () => {
    const plain = collect(`<img src="a.jpg" alt="A">`);
    expect(flags(plain, "/a.jpg")).toEqual({});
  });

  test("a file selected by any image is not a fallback", () => {
    const both = collect(
      `<img src="x.jpg" srcset="y.jpg 400w, x.jpg 960w" sizes="180px" alt="A"><img src="y.jpg" alt="B">`,
    );
    expect(flags(both, "/y.jpg")).toEqual({});
    expect(flags(both, "/x.jpg")).toEqual({ fallbackOnly: true });
  });

  test("a picture's img keeps its src as the loaded file", () => {
    const pic = collect(
      `<picture><source srcset="a.webp" type="image/webp"><img src="a.jpg" srcset="b.jpg 400w, a.jpg 960w" sizes="180px" alt="A"></picture>`,
    );
    expect(flags(pic, "/a.jpg")).toEqual({});
  });
});

describe("lazy images below the initial viewport (#1252)", () => {
  const lazyPage = [1, 2, 3, 4, 5, 6]
    .map((n) => `<img src="lazy${n}.jpg" loading="lazy" width="400" height="300" alt="Item ${n}">`)
    .join("");
  const o = collect(`<main>${lazyPage}</main>`);

  test("the first three content images are in the viewport, the rest are deferred on this page", () => {
    for (const n of [1, 2, 3]) expect(flags(o, `/lazy${n}.jpg`)).toEqual({});
    for (const n of [4, 5, 6]) {
      expect(flags(o, `/lazy${n}.jpg`)).toEqual({ deferredPages: [`${BASE}/p.html`] });
    }
  });

  test("icons ahead of a lazy hero do not push it below the fold", () => {
    const icons = [1, 2, 3, 4]
      .map((n) => `<img src="i${n}.svg" width="24" height="24" alt="">`)
      .join("");
    const withIcons = collect(
      `${icons}<img src="hero.jpg" loading="lazy" width="400" height="120" alt="Hero">`,
    );
    expect(flags(withIcons, "/hero.jpg")).toEqual({});
  });

  test("an eager load of the same file on the page makes it count", () => {
    const content = (n: number) => `<img src="c${n}.jpg" width="800" height="600" alt="">`;
    const mixed = collect(
      `${[1, 2, 3].map(content).join("")}<img src="shared.jpg" loading="lazy" width="800" height="600" alt=""><img src="shared.jpg" width="800" height="600" alt="">`,
    );
    expect(flags(mixed, "/shared.jpg")).toEqual({});
  });

  test("deferred on one page, eager on another: only the first page is deferred", () => {
    const html = (body: string) =>
      `<!doctype html><html><head><title>Two pages fixture</title></head><body>${body}</body></html>`;
    const content = (n: number) => `<img src="c${n}.jpg" width="800" height="600" alt="">`;
    const a = `${BASE}/a.html`;
    const b = `${BASE}/b.html`;
    const occurrences = emptySiteAssetOccurrences();
    absorbResourceOccurrences(
      occurrences,
      [
        {
          url: a,
          finalUrl: a,
          parsed: parsePage(
            html(`${[1, 2, 3].map(content).join("")}<img src="s.jpg" loading="lazy" alt="">`),
            a,
          ),
        },
        { url: b, finalUrl: b, parsed: parsePage(html(`<img src="s.jpg" alt="">`), b) },
      ],
      BASE,
    );
    expect(imageLoadFlags(occurrences, `${BASE}/s.jpg`)).toEqual({ deferredPages: [a] });
  });
});
