// Mobile layout payload from the render service (repo#4218). Additive: absent in, absent out.

import { describe, expect, test } from "bun:test";

import { RENDER_LAYOUT_LIMITS, normalizeRenderLayout } from "@squirrelscan/core-contracts";
import type { RenderLayout, RenderResultItem } from "@squirrelscan/core-contracts";

import { mapRenderItemToResponse } from "../src/cloud-fetcher";

const TIMING = { startedAt: 0, responseAt: 1, finishedAt: 2 };
const URL_ = "https://example.com/";
const item = (extra: Partial<RenderResultItem> = {}): RenderResultItem & { html: string } => ({
  url: URL_,
  status: 200,
  html: "<html></html>",
  ...extra,
});
const entry = (i: number) => ({ selector: `div:nth-of-type(${i})`, rect: { x: 0, y: i, width: 500, height: 30 } });

describe("mobile layout payload (repo#4218)", () => {
  test("overflow and a sub-44px tap target are both listed", () => {
    const layout = normalizeRenderLayout({
      viewportWidth: 390,
      documentWidth: 640,
      overflowing: [entry(1)],
      smallTapTargets: [{ selector: "a.cta", rect: { x: 10, y: 20, width: 30, height: 20.4 } }],
    }) as RenderLayout;
    expect(layout.overflowing).toHaveLength(1);
    expect(layout.smallTapTargets[0]?.rect.height).toBe(20);
    const response = mapRenderItemToResponse(item({ layout }), URL_, TIMING);
    expect(response.layout?.documentWidth).toBe(640);
  });

  test("no problems: all lists present and empty", () => {
    const layout = normalizeRenderLayout({ viewportWidth: 390, documentWidth: 390 }) as RenderLayout;
    expect(layout).toMatchObject({ overflowing: [], clippedText: [], overlapping: [], smallTapTargets: [], truncated: false });
  });

  test("2,000-element fixture stays under the byte and per-list caps", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...entry(i), selector: "x".repeat(500) }));
    const layout = normalizeRenderLayout({
      overflowing: many,
      clippedText: many.map((e) => ({ ...e, clippedPx: 9 })),
      overlapping: many.map((e) => ({ ...e, overlaps: "y".repeat(500) })),
      smallTapTargets: many,
      textDigest: "t".repeat(5000),
    }) as RenderLayout;
    expect(layout.truncated).toBe(true);
    for (const k of ["overflowing", "clippedText", "overlapping", "smallTapTargets"] as const) {
      expect(layout[k].length).toBeLessThanOrEqual(RENDER_LAYOUT_LIMITS.maxPerList);
    }
    expect(layout.textDigest.length).toBe(RENDER_LAYOUT_LIMITS.digestChars);
    expect(JSON.stringify(layout).length).toBeLessThanOrEqual(RENDER_LAYOUT_LIMITS.maxBytes);
  });

  test("no layout in, no layout key out", () => {
    expect(normalizeRenderLayout(undefined)).toBeUndefined();
    expect("layout" in mapRenderItemToResponse(item(), URL_, TIMING)).toBe(false);
  });
});
