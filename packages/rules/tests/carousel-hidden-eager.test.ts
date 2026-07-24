// perf/carousel-hidden-eager — eager imgs in hidden carousel slides (#701).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { carouselHiddenEagerRule } from "../src/performance/carousel-hidden-eager";
import { lazyAboveFoldRule } from "../src/performance/lazy-above-fold";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(body: string): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>T</title></head><body>${body}</body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult {
  const checks = (carouselHiddenEagerRule.run(ctx) as { checks: CheckResult[] }).checks;
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

describe("perf/carousel-hidden-eager", () => {
  test("warns: eager img in aria-hidden swiper slide", () => {
    const c = run(
      makeCtx(
        `<div class="swiper">
          <div class="swiper-slide"><img src="/slide1.jpg"></div>
          <div class="swiper-slide" aria-hidden="true"><img src="/slide2.jpg"></div>
        </div>`,
      ),
    );
    expect(c.status).toBe("warn");
    expect(c.items?.map((i) => i.id)).toEqual(["/slide2.jpg"]);
  });

  test("warns: eager img in display:none carousel-item", () => {
    const c = run(
      makeCtx(`<div class="carousel-item" style="display:none"><img src="/hidden.jpg"></div>`),
    );
    expect(c.status).toBe("warn");
  });

  test("passes: lazy img in hidden slide (handled by lazy rules)", () => {
    const c = run(
      makeCtx(
        `<div class="swiper-slide" aria-hidden="true"><img src="/slide2.jpg" loading="lazy"></div>`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: visible slide eager img is fine", () => {
    const c = run(makeCtx(`<div class="swiper-slide"><img src="/slide1.jpg"></div>`));
    expect(c.status).toBe("pass");
  });

  test("passes: hidden element that is NOT a carousel slide", () => {
    const c = run(makeCtx(`<div class="tab-panel" hidden><img src="/tab.jpg"></div>`));
    expect(c.status).toBe("pass");
  });

  test("passes: generic slide-in animation is not a carousel", () => {
    const c = run(makeCtx(`<div hidden><div class="slide-in"><img src="/promo.jpg"></div></div>`));
    expect(c.status).toBe("pass");
  });

  test("warns: whole carousel container hidden with eager img", () => {
    const c = run(
      makeCtx(`<div class="carousel" style="display:none"><div><img src="/x.jpg"></div></div>`),
    );
    expect(c.status).toBe("warn");
  });

  test("passes: data URI images skipped", () => {
    const c = run(
      makeCtx(
        `<div class="swiper-slide" aria-hidden="true"><img src="data:image/gif;base64,AA"></div>`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("non-overlap: lazy-above-fold and this rule never flag the same img", () => {
    // A lazy img in a hidden slide → lazy-above-fold may consider it; this rule ignores lazy.
    const ctx = makeCtx(
      `<div class="swiper-slide" aria-hidden="true"><img src="/slide2.jpg" loading="lazy"></div>`,
    );
    const mine = (carouselHiddenEagerRule.run(ctx) as { checks: CheckResult[] }).checks[0];
    const lazy = (lazyAboveFoldRule.run(ctx) as { checks: CheckResult[] }).checks[0];
    expect(mine?.status).toBe("pass"); // eager-only rule ignores lazy imgs
    expect(lazy?.name).toBe("lazy-above-fold");
  });
});
