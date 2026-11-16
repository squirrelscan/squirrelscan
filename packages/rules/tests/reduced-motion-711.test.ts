// a11y/reduced-motion (#711)

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { reducedMotionRule, stylesheetMotionOf } from "../src/a11y/reduced-motion";
import type { CheckResult, RuleContext, StylesheetMotionData } from "../src/types";

const URL_ = "https://example.com/";

function page(head: string, body = ""): string {
  return `<!DOCTYPE html><html lang="en"><head><title>t</title>${head}</head><body><main><h1>Page</h1>${body}</main></body></html>`;
}

function run(html: string, site?: Partial<NonNullable<RuleContext["site"]>>, url = URL_): CheckResult[] {
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site,
    options: {},
  } as unknown as RuleContext;
  const result = reducedMotionRule.run(ctx);
  if (result instanceof Promise) throw new Error("async");
  return result.checks.filter((c) => c.status !== "pass");
}

const sheet = (over: Partial<StylesheetMotionData> = {}): StylesheetMotionData => ({
  url: "https://example.com/app.css",
  status: 200,
  error: null,
  read: true,
  mentionsReducedMotion: false,
  hasInfiniteAnimation: false,
  hasSmoothScroll: false,
  ...over,
});

describe("a11y/reduced-motion", () => {
  test("AOS with no handling warns and names AOS", () => {
    const checks = run(
      page(`<script src="https://example.com/aos.js"></script>`, `<div data-aos="fade-up">x</div>`),
      { scripts: [{ url: "https://example.com/aos.js", content: "x", sourcePages: [URL_] }] as never },
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.name).toBe("reduced-motion-aos");
    expect(checks[0]!.message).toContain("AOS");
  });

  test("inline infinite animation warns; a reduce query clears it", () => {
    const css = `@keyframes spin{to{transform:rotate(1turn)}} .s{animation: spin 2s infinite}`;
    const warn = run(page(`<style>${css}</style>`));
    expect(warn[0]!.status).toBe("warn");
    const clear = run(
      page(`<style>${css} @media (prefers-reduced-motion: reduce){ * { animation: none } }</style>`),
    );
    expect(clear).toHaveLength(0);
  });

  test("video autoplay loop with handling in a read first-party stylesheet gives no finding", () => {
    const html = page(
      `<link rel="stylesheet" href="/app.css">`,
      `<video autoplay loop muted></video>`,
    );
    expect(run(html, { stylesheetMotion: [sheet({ mentionsReducedMotion: true })] })).toHaveLength(0);
    // Without the stylesheet body it is unverified: info, never warn.
    const partial = run(html, { stylesheetMotion: [] });
    expect(partial[0]!.status).toBe("info");
    expect(partial[0]!.message).toContain("partial check");
    const third = run(
      page(`<link rel="stylesheet" href="https://cdn.other.com/a.css">`, `<video autoplay loop></video>`),
      { stylesheetMotion: [] },
    );
    expect(third[0]!.status).toBe("info");
  });

  test("marquee and autoplay carousel warn", () => {
    expect(run(page("", `<marquee>hi</marquee>`))[0]!.status).toBe("warn");
    const c = run(page("", `<div class="carousel" data-autoplay="true"></div>`));
    expect(c[0]!.name).toBe("reduced-motion-carousel-autoplay");
    expect(c[0]!.status).toBe("warn");
  });

  test("hover transitions, controlled videos and no-preference-only motion give no finding", () => {
    expect(run(page(`<style>a{transition:color .2s} a:hover{color:red}</style>`))).toHaveLength(0);
    expect(run(page("", `<video autoplay controls></video>`))).toHaveLength(0);
    expect(
      run(page(`<style>@media (prefers-reduced-motion: no-preference){.s{animation:spin 1s infinite}}</style>`)),
    ).toHaveLength(0);
    expect(run(page(`<style>.s{animation: fade 1s 1}</style>`))).toHaveLength(0);
  });

  test("matchMedia in a read script counts as handling", () => {
    const html = page(`<script src="/main.js"></script>`, `<div data-aos="fade"></div>`);
    const scripts = [
      {
        url: "https://example.com/main.js",
        content: `if(!matchMedia("(prefers-reduced-motion: reduce)").matches) AOS.init()`,
        sourcePages: [URL_],
      },
    ] as never;
    expect(run(html, { scripts })).toHaveLength(0);
    expect(
      run(page(`<script>if(!matchMedia("(prefers-reduced-motion: reduce)").matches){}</script>`, `<div data-aos="x"></div>`)),
    ).toHaveLength(0);
  });

  test("template pages share one check name so the report groups them", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const c of run(page("", `<div data-aos="fade">${i}</div>`), undefined, `https://example.com/p${i}`)) {
        names.add(c.name);
      }
    }
    expect(names.size).toBe(1);
  });

  test("hostile stylesheets stay within the budget", () => {
    const big = ".a{color:red}".repeat(100_000);
    let t = performance.now();
    expect(stylesheetMotionOf(big).hasInfiniteAnimation).toBe(false);
    const huge = `${"x".repeat(5 * 1024 * 1024)} .s{animation:a 1s infinite}`;
    expect(stylesheetMotionOf(huge).hasInfiniteAnimation).toBe(false);
    expect(performance.now() - t).toBeLessThan(3000);
    t = performance.now();
    expect(stylesheetMotionOf(`${"{".repeat(300_000)}`)).toBeDefined();
    expect(performance.now() - t).toBeLessThan(3000);
  });

  test("stylesheetMotionOf reads smooth scroll and handling", () => {
    expect(stylesheetMotionOf("html{scroll-behavior:smooth}").hasSmoothScroll).toBe(true);
    expect(
      stylesheetMotionOf("@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}").mentionsReducedMotion,
    ).toBe(true);
  });
});
