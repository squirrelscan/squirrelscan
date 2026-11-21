import { describe, expect, test } from "bun:test";

import {
  contrastRatio,
  normalizeBrandColor,
  pickTextOn,
  relativeLuminance,
  validateBrandColor,
} from "../src/brand-color";

describe("contrast maths", () => {
  test("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
  });
  test("#777777 on white is about 4.48", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
  test("#767676 on white just passes 4.5", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
  test("pickTextOn chooses the higher-contrast text", () => {
    expect(pickTextOn("#ffff00")).toBe("#000000");
    expect(pickTextOn("#003366")).toBe("#ffffff");
  });
});

describe("normalizeBrandColor", () => {
  test("lowercases and trims; rejects other shapes", () => {
    expect(normalizeBrandColor(" #1A2B3C ")).toBe("#1a2b3c");
    for (const bad of ["#abc", "1a2b3c", "#gggggg", "red", "", 5, null]) {
      expect(normalizeBrandColor(bad)).toBeNull();
    }
  });
});

describe("validateBrandColor", () => {
  test("accepts a dark blue", () => {
    const v = validateBrandColor("#1D4ED8");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.color).toBe("#1d4ed8");
      expect(v.textColor).toBe("#ffffff");
    }
  });
  test("rejects a bad format", () => {
    const v = validateBrandColor("blue");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("invalid-format");
  });
  test("accepts #777777 with black text (white would only reach 4.48:1)", () => {
    const v = validateBrandColor("#777777");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.textColor).toBe("#000000");
  });
  test("the best of black and white always reaches 4.5:1, so only the page rule can reject a valid hex", () => {
    for (let g = 0; g < 256; g++) {
      const h = g.toString(16).padStart(2, "0");
      const v = validateBrandColor(`#${h}${h}${h}`);
      if (!v.ok) expect(v.reason).toBe("page-contrast");
    }
  });
  test("rejects a light colour that fails 3:1 against white", () => {
    const v = validateBrandColor("#ffff00");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("page-contrast");
  });
});
