import { describe, expect, test } from "bun:test";

import {
  ABOVE_FOLD_IMAGE_BUDGET,
  initialViewportFlags,
  isIconSized,
  parseSrcset,
  selectImageCandidate,
  sourceSizePx,
} from "../src/image-loading";

describe("parseSrcset", () => {
  test("reads widths, densities and bare candidates", () => {
    expect(parseSrcset("small.jpg 400w, big.jpg 960w")).toEqual([
      { url: "small.jpg", w: 400 },
      { url: "big.jpg", w: 960 },
    ]);
    expect(parseSrcset("a.jpg, b.jpg 2x")).toEqual([{ url: "a.jpg" }, { url: "b.jpg", x: 2 }]);
    expect(parseSrcset("/a,b.jpg 1.5x")).toEqual([{ url: "/a,b.jpg", x: 1.5 }]);
    expect(parseSrcset(null)).toEqual([]);
    expect(parseSrcset("   ,  ,")).toEqual([]);
  });

  test("is bounded: a hostile value costs its prefix, not the whole thing", () => {
    const hostile = `${"a.jpg 1w,".repeat(100_000)}`;
    expect(parseSrcset(hostile).length).toBeLessThanOrEqual(64);
  });
});

describe("sourceSizePx", () => {
  test("no sizes is 100vw at the reference viewport", () => {
    expect(sourceSizePx(null)).toBe(1280);
    expect(sourceSizePx("")).toBe(1280);
  });

  test.each([
    ["180px", 180],
    ["50vw", 640],
    ["(min-width: 750px) 370px, 100vw", 370],
    ["(min-width: 1600px) 800px, (min-width: 750px) 370px, 100vw", 370],
    ["(max-width: 600px) 300px, 100vw", 1280],
    ["(min-width: 750px) calc(100vw - 40px), 100vw", null],
    ["(prefers-reduced-motion) 100px, 200px", 200],
  ])("%s", (sizes, expected) => {
    expect(sourceSizePx(sizes)).toBe(expected);
  });
});

describe("selectImageCandidate", () => {
  test("the reporter's case: sizes 180px at DPR 2 needs 360w, so the 400w file", () => {
    expect(
      selectImageCandidate({
        src: "big.jpg",
        srcset: "small.jpg 400w, big.jpg 960w",
        sizes: "180px",
      }),
    ).toBe("small.jpg");
  });

  test("no candidate covers the width: the largest", () => {
    expect(
      selectImageCandidate({ src: "a.jpg", srcset: "s.jpg 400w, m.jpg 800w", sizes: "100vw" }),
    ).toBe("m.jpg");
  });

  test("no sizes means 100vw: a 1280 viewport at 2x needs 2560w", () => {
    expect(selectImageCandidate({ src: "a.jpg", srcset: "s.jpg 400w, l.jpg 3000w" })).toBe("l.jpg");
  });

  test("density descriptors pick the smallest at or above 2x, else the largest", () => {
    expect(selectImageCandidate({ src: "a.jpg", srcset: "a.jpg 1x, b.jpg 2x, c.jpg 3x" })).toBe(
      "b.jpg",
    );
    expect(selectImageCandidate({ src: "a.jpg", srcset: "a.jpg 1x" })).toBe("a.jpg");
  });

  test("an unreadable sizes length falls to the largest candidate", () => {
    expect(
      selectImageCandidate({
        src: "a.jpg",
        srcset: "s.jpg 400w, l.jpg 900w",
        sizes: "calc(100vw - 2em)",
      }),
    ).toBe("l.jpg");
  });

  test("without srcset it is src, and an image naming no file is null", () => {
    expect(selectImageCandidate({ src: "only.jpg" })).toBe("only.jpg");
    expect(selectImageCandidate({})).toBeNull();
  });
});

describe("initial viewport", () => {
  test("icon sizing needs both sides declared and a small area", () => {
    expect(isIconSized({ width: "24", height: "24" })).toBe(true);
    expect(isIconSized({ width: "150px", height: "40" })).toBe(true);
    expect(isIconSized({ width: "400", height: "120" })).toBe(false);
    expect(isIconSized({ width: "24", height: null })).toBe(false);
    expect(isIconSized({})).toBe(false);
  });

  test("icons neither fill the budget nor are held to it until it is full", () => {
    const icon = { width: "24", height: "24" };
    const hero = { width: "400", height: "120" };
    expect(initialViewportFlags([icon, icon, icon, icon, hero])).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("content images fill the budget in order; later images, icons included, are below it", () => {
    const content = { width: "600", height: "400" };
    const icon = { width: "24", height: "24" };
    expect(initialViewportFlags([content, content, content, content, icon])).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(ABOVE_FOLD_IMAGE_BUDGET).toBe(3);
  });

  test("undeclared images count as content", () => {
    expect(initialViewportFlags([{}, {}, {}, {}])).toEqual([true, true, true, false]);
  });
});
