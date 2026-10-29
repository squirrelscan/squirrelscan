// a11y/image-redundant-alt: a readable alt that happens to spell the filename is not redundant;
// a raw filename or slug used as the alt still is (#1273).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { imageRedundantAltRule } from "../src/a11y/image-redundant-alt";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult | undefined {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Descriptive partner logo alt fixture</title></head><body><main><h1>Certifications</h1>${body}</main></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = imageRedundantAltRule.run(ctx);
  if (result instanceof Promise) throw new Error("image-redundant-alt is async");
  return result.checks.find((c) => c.name === "image-redundant-alt");
}

describe("a11y/image-redundant-alt readable alt vs filename (#1273)", () => {
  test("the reporter's Google Partner Logo fixture passes", () => {
    const result = run(`<img src="google-partner-logo.svg" alt="Google Partner Logo">`);
    expect(result?.status).toBe("pass");
  });

  test("a distinct descriptive alt passes", () => {
    expect(run(`<img src="brand.svg" alt="Google Partner certification">`)?.status).toBe("pass");
  });

  test.each([
    ["slug equal to the filename", `<img src="arrow-downwards.svg" alt="arrow-downwards">`],
    ["underscored stem", `<img src="hero_banner_v2.png" alt="hero_banner_v2">`],
    ["camera name", `<img src="IMG_20240101.jpg" alt="IMG_20240101">`],
    ["single token equal to the filename", `<img src="northwind.svg" alt="Northwind">`],
    [
      "a spaced filename spelled exactly",
      `<img src="my%20holiday%20photo.jpg" alt="my holiday photo">`,
    ],
  ])("still warns: %s", (_name, body) => {
    const result = run(body);
    expect(result?.status).toBe("warn");
    expect(result?.items?.some((i) => i.id.includes("matches filename"))).toBe(true);
  });

  test("the figcaption control still warns", () => {
    const result = run(
      `<figure><img src="brand.svg" alt="Partner certification"><figcaption>Partner certification</figcaption></figure>`,
    );
    expect(result?.status).toBe("warn");
    expect(result?.items?.some((i) => i.id.includes("duplicates figcaption"))).toBe(true);
  });

  test("the redundant-prefix and surrounding-text checks are unchanged", () => {
    expect(run(`<img src="a.jpg" alt="Photo of a squirrel">`)?.status).toBe("warn");
    expect(
      run(`<p>Annual revenue chart for 2024 <img src="b.jpg" alt="Annual revenue chart"></p>`)
        ?.status,
    ).toBe("warn");
  });
});
