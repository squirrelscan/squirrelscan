// perf/lazy-above-fold — hidden-container + carousel-slide false positives
// (#699). Before this fix, the DOM-order "first 3 images" heuristic counted
// images inside aria-hidden/hidden containers, inactive carousel slides, and
// footer bands as above-the-fold candidates. Real eager-vs-lazy problems on
// genuinely visible images must still flag.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { lazyAboveFoldRule } from "../src/performance/lazy-above-fold";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string): RuleContext {
  const doc = parseHTML(html).document;
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: doc } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
}

describe("perf/lazy-above-fold false-positive fixes (#699)", () => {
  test("lazy image inside aria-hidden container is not flagged", () => {
    const html = `<html><body>
      <div aria-hidden="true"><img src="/hidden.jpg" loading="lazy"></div>
      <p>content</p>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("lazy image inside [hidden] container is not flagged", () => {
    const html = `<html><body>
      <div hidden><img src="/hidden.jpg" loading="lazy"></div>
      <p>content</p>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("lazy image inside an inline display:none container is not flagged", () => {
    const html = `<html><body>
      <div style="display: none;"><img src="/hidden.jpg" loading="lazy"></div>
      <p>content</p>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("lazy image in a non-first carousel slide is not flagged, active slide 0 still evaluated", () => {
    const html = `<html><body>
      <div class="swiper">
        <div class="swiper-slide"><img src="/slide0.jpg" loading="eager"></div>
        <div class="swiper-slide"><img src="/slide1.jpg" loading="lazy"></div>
        <div class="swiper-slide"><img src="/slide2.jpg" loading="lazy"></div>
      </div>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("lazy image inside a footer band is not flagged, even on a short page", () => {
    const html = `<html><body>
      <img src="/logo.jpg" loading="eager">
      <footer><img src="/footer-logo.jpg" loading="lazy"></footer>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("true positive: an explicit active-slide marker overrides DOM-order — a lazy 2nd slide marked active still flags", () => {
    // The active slide isn't guaranteed to be the first DOM sibling; when a
    // library marks it explicitly (swiper-slide-active, etc.) that signal
    // must win over the "first slide" fallback (codex review finding).
    const html = `<html><body>
      <div class="swiper">
        <div class="swiper-slide"><img src="/slide0.jpg" loading="lazy"></div>
        <div class="swiper-slide swiper-slide-active"><img src="/slide1.jpg" loading="lazy"></div>
        <div class="swiper-slide"><img src="/slide2.jpg" loading="lazy"></div>
      </div>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "/slide1.jpg")).toBe(true);
    expect(checks[0].items?.some((i) => i.id === "/slide0.jpg")).toBe(false);
  });

  test("true positive: hidden slide skip still lets the next real above-fold image be evaluated", () => {
    const html = `<html><body>
      <div aria-hidden="true"><img src="/hidden.jpg" loading="lazy"></div>
      <img src="/hero.jpg" loading="lazy">
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "/hero.jpg")).toBe(true);
  });

  test("true positive: genuinely visible above-fold lazy image still flags", () => {
    const html = `<html><body>
      <img src="/hero.jpg" loading="lazy">
      <p>content</p>
    </body></html>`;
    const { checks } = lazyAboveFoldRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "/hero.jpg")).toBe(true);
  });
});
