// images/image-file-size measures the file a browser downloads, not every src named in the markup (#1251).

import { describe, expect, test } from "bun:test";

import { imageFileSizeRule } from "../src/images/image-file-size";
import type { RuleContext } from "../src/types";

const KB = 1024;
const entry = (url: string, size: number, extra: object = {}) => ({
  url,
  status: 200,
  error: null,
  contentType: "image/jpeg",
  sizeBytes: size,
  sourcePages: ["https://example.com/srcset.html"],
  ...extra,
});

function run(images: ReturnType<typeof entry>[]) {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    options: {},
    site: {
      baseUrl: "https://example.com",
      pages: [],
      resourceSizes: { css: [], images, fonts: [] },
    },
  } as unknown as RuleContext;
  const result = imageFileSizeRule.run(ctx);
  if (result instanceof Promise) throw new Error("image-file-size is async");
  return result.checks;
}

describe("images/image-file-size and the srcset fallback (#1251)", () => {
  test("the reporter's page: the 300 KB src behind a srcset that picks the 40 KB file passes", () => {
    const checks = run([
      entry("https://example.com/big.jpg", 300 * KB, { fallbackOnly: true }),
      entry("https://example.com/small.jpg", 40 * KB),
    ]);
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("an image without srcset is still measured by its src", () => {
    const checks = run([entry("https://example.com/big.jpg", 300 * KB)]);
    expect(checks.find((c) => c.name === "image-file-size-warn")?.items?.[0]?.id).toBe(
      "https://example.com/big.jpg",
    );
  });

  test("a selected candidate that is itself too big is reported, the fallback is not", () => {
    const checks = run([
      entry("https://example.com/fallback.jpg", 900 * KB, { fallbackOnly: true }),
      entry("https://example.com/selected.jpg", 300 * KB),
    ]);
    const warn = checks.find((c) => c.name === "image-file-size-warn");
    expect(warn?.items?.map((i) => i.id)).toEqual(["https://example.com/selected.jpg"]);
  });

  test("a file that is a fallback on one page and the selected image on another is measured", () => {
    // The engine leaves `fallbackOnly` off a URL any image selects.
    const checks = run([entry("https://example.com/both.jpg", 300 * KB)]);
    expect(checks.some((c) => c.name === "image-file-size-warn")).toBe(true);
  });
});
