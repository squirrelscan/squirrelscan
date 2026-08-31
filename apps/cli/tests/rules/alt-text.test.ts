// images/alt-text: alt="" is a decorative marker, not a missing attribute
// (HTML spec, WCAG H67). Only an absent alt attribute is a defect.
// squirrelscan/squirrelscan#143

import type { CheckResult, RuleContext } from "@squirrelscan/rules";

import { parsePage } from "@squirrelscan/parser";
import { images } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

const { altTextRule } = images;

const URL = "https://example.com/";

function makeCtx(body: string): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>T</title></head><body>${body}</body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  } as unknown as RuleContext;
}

function run(body: string): CheckResult[] {
  return (altTextRule.run(makeCtx(body)) as { checks: CheckResult[] }).checks;
}

function missing(body: string): CheckResult | undefined {
  return run(body).find((c) => c.name === "alt-text-missing");
}

describe("images/alt-text", () => {
  test('alt="" is not reported as missing', () => {
    const checks = run(`<img src="/divider.svg" alt="">`);

    expect(checks.find((c) => c.name === "alt-text-missing")).toBeUndefined();
    expect(checks[0]?.status).toBe("pass");
  });

  test("an img with no alt attribute is still reported as missing", () => {
    const c = missing(`<img src="/photo.jpg">`);

    expect(c?.status).toBe("fail");
    expect(c?.items?.map((i) => i.id)).toEqual([`${URL}photo.jpg`]);
  });

  test("a page with one decorative and one bare image reports exactly one", () => {
    const c = missing(`
      <img src="/divider.svg" alt="">
      <img src="/photo.jpg">
    `);

    expect(c?.status).toBe("fail");
    expect(c?.message).toBe("1 image(s) missing alt text");
    expect(c?.items?.map((i) => i.id)).toEqual([`${URL}photo.jpg`]);
  });

  test("descriptive alt passes", () => {
    const checks = run(`<img src="/photo.jpg" alt="A red barn at dusk">`);

    expect(checks.find((c) => c.name === "alt-text-missing")).toBeUndefined();
    expect(checks[0]?.message).toBe("All 1 image(s) have alt text");
  });

  test("a decorative image inside a link that has its own text reports nothing", () => {
    // The squirrelscan.com case from #143: correct markup that used to fail.
    const checks = run(
      `<a href="/agents/claude">Claude Code<img src="/logo.svg" alt="" aria-hidden="true"></a>`
    );

    expect(checks.find((c) => c.name === "alt-text-missing")).toBeUndefined();
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  test('uppercase ALT="" is an empty alt, not an absent one', () => {
    // HTML attribute names are case-insensitive; linkedom preserves source case.
    expect(missing(`<img src="/divider.svg" ALT="">`)).toBeUndefined();
  });

  test("uppercase ALT with a description passes too", () => {
    expect(missing(`<img src="/photo.jpg" ALT="A red barn">`)).toBeUndefined();
  });

  test("whitespace-only alt is treated as decorative, not missing", () => {
    expect(missing(`<img src="/divider.svg" alt="   ">`)).toBeUndefined();
  });

  test("the pass message distinguishes described from decorative images", () => {
    const checks = run(`
      <img src="/photo.jpg" alt="A red barn">
      <img src="/divider.svg" alt="">
    `);

    expect(checks[0]?.message).toBe(
      '1/2 image(s) have alt text, 1 marked decorative (alt="")'
    );
  });

  test("a page of only decorative images passes", () => {
    const checks = run(`
      <img src="/a.svg" alt="">
      <img src="/b.svg" alt="">
    `);

    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.message).toBe(
      'All 2 image(s) marked decorative (alt="")'
    );
  });

  test("no images on the page still passes", () => {
    const checks = run(`<p>No images here.</p>`);

    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.value).toBe(0);
  });

  test("the solution text and the behavior agree about empty alt", () => {
    // The rule recommends alt="" for decorative images; it must not then fail
    // a page for using it. Guards the contradiction #143 was filed about.
    expect(altTextRule.meta.solution).toContain('alt=""');
    expect(missing(`<img src="/divider.svg" alt="">`)).toBeUndefined();
  });
});
