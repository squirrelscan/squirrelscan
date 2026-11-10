// images/offscreen-lazy: an item always names its image, and the check says how below the fold was decided (#1644).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { offscreenLazyRule } from "../src/images/offscreen-lazy";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string, options: object = {}): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Image locator rule page for squirrel audits</title></head><body>${body}</body></html>`;
  const url = "https://example.com/builder.html";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options,
  } as unknown as RuleContext;
  const result = offscreenLazyRule.run(ctx);
  if (result instanceof Promise) throw new Error("offscreen-lazy is async");
  return result.checks;
}

// Three content images fill the default above-the-fold budget; the image under test follows them.
const above = [1, 2, 3].map((n) => `<img src="/hero-${n}.jpg" alt="Hero ${n}">`).join("");

const notLazy = (checks: CheckResult[]) => checks.find((c) => c.name === "offscreen-images-not-lazy");

describe("item locator for an image with an empty src (#1644)", () => {
  test('src="" with data-src names the data-src file', () => {
    const row = notLazy(run(`${above}<img src="" data-src="/cdn/bundle/product-9.jpg?v=3" alt="p">`));
    expect(row?.items).toEqual([{ id: "product-9.jpg" }]);
  });

  test('src="" with srcset only names the first srcset file', () => {
    const row = notLazy(
      run(`${above}<img src="" srcset="/cdn/a-400.jpg 400w, /cdn/a-800.jpg 800w" alt="p">`),
    );
    expect(row?.items).toEqual([{ id: "a-400.jpg" }]);
  });

  test("data-srcset is read when srcset is absent", () => {
    const row = notLazy(run(`${above}<img src="" data-srcset="/cdn/b-300.jpg 2x" alt="p">`));
    expect(row?.items).toEqual([{ id: "b-300.jpg" }]);
  });

  test("data-src wins over srcset", () => {
    const row = notLazy(
      run(`${above}<img src="" data-src="/cdn/first.jpg" srcset="/cdn/second.jpg 1x" alt="p">`),
    );
    expect(row?.items).toEqual([{ id: "first.jpg" }]);
  });

  test("no source attribute at all: the id is the element selector and a snippet carries the tag", () => {
    const row = notLazy(run(`${above}<div id="bundle"><img src="" class="tile" alt="builder tile"></div>`));
    const item = row?.items?.[0];
    expect(item?.id).toBe("html > body > div#bundle > img.tile");
    expect(item?.snippet).toBe('<img src="" class="tile" alt="builder tile">');
  });

  test("a whitespace-only src is empty too", () => {
    const row = notLazy(run(`${above}<img src="  " data-src="/x/y.jpg" alt="p">`));
    expect(row?.items).toEqual([{ id: "y.jpg" }]);
  });

  test("a long tag is cut in the snippet", () => {
    const row = notLazy(run(`${above}<img src="" alt="${"a".repeat(400)}">`));
    const snippet = row?.items?.[0]?.snippet ?? "";
    expect(snippet.length).toBeLessThanOrEqual(160);
    expect(snippet.endsWith("…")).toBe(true);
  });

  test("no item of the finding has an empty id", () => {
    const row = notLazy(
      run(`${above}<img src=""><img src="" data-src="/a.jpg"><img src="/real/photo.jpg" alt="r">`),
    );
    expect(row?.items?.length).toBe(3);
    expect(row?.items?.every((i) => i.id.length > 0)).toBe(true);
    expect(row?.items?.map((i) => i.id)).toEqual(["html > body > img", "a.jpg", "photo.jpg"]);
  });
});

describe("how below the fold was decided (#1644)", () => {
  test("the finding states the above-the-fold count and that no viewport is measured", () => {
    const row = notLazy(run(`${above}<img src="/late.jpg" alt="late">`));
    expect(row?.details?.aboveFoldCount).toBe(3);
    expect(String(row?.details?.belowFoldBasis)).toContain("no viewport is measured");
  });

  test("a custom above_fold_count is reported", () => {
    const row = notLazy(run(`${above}<img src="/late.jpg" alt="late">`, { above_fold_count: 2 }));
    expect(row?.details?.aboveFoldCount).toBe(2);
  });

  test("an image with a plain src keeps its filename id", () => {
    const row = notLazy(run(`${above}<img src="/img/late.jpg?x=1" alt="late">`));
    expect(row?.items).toEqual([{ id: "late.jpg" }]);
  });
});
