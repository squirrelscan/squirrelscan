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

function runAll(html: string, site?: Partial<NonNullable<RuleContext["site"]>>, url = URL_): CheckResult[] {
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site,
    options: {},
  } as unknown as RuleContext;
  const result = reducedMotionRule.run(ctx);
  if (result instanceof Promise) throw new Error("async");
  return result.checks;
}

const sheet = (over: Partial<StylesheetMotionData> = {}): StylesheetMotionData => ({
  url: "https://example.com/app.css",
  status: 200,
  error: null,
  read: true,
  mentionsReducedMotion: false,
  hasInfiniteAnimation: false,
  hasSmoothScroll: false,
  infiniteAnimationSelectors: [],
  smoothScrollSelectors: [],
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
    const warn = run(page(`<style>${css}</style>`, `<i class="s"></i>`));
    expect(warn[0]!.status).toBe("warn");
    const clear = run(
      page(`<style>${css} @media (prefers-reduced-motion: reduce){ * { animation: none } }</style>`, `<i class="s"></i>`),
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

  test("a stylesheet href's query string never reaches the finding", () => {
    const href = "https://example.com/app.css?token=s3cr3t&email=a%40b.com";
    const checks = run(page(`<link rel="stylesheet" href="${href}">`), {
      stylesheetMotion: [sheet({ url: href, hasInfiniteAnimation: true, hasSmoothScroll: true, smoothScrollSelectors: ["html"] })],
    });
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      const text = JSON.stringify(c);
      expect(text).not.toContain("token");
      expect(text).not.toContain("s3cr3t");
      expect(text).not.toContain("email");
      expect(text).not.toContain("a%40b.com");
      expect(c.value).toBe("https://example.com/app.css");
      expect((c.details as { trigger: string }).trigger).toBe("https://example.com/app.css");
    }
  });

  test("a stylesheet href's userinfo and fragment never reach the finding", () => {
    const href = "https://deploy:ghp_s3cr3t@example.com/app.css?v=1#frag";
    const checks = run(page(`<link rel="stylesheet" href="${href}">`, `<i class="s"></i>`), {
      stylesheetMotion: [
        sheet({
          url: "https://deploy:ghp_s3cr3t@example.com/app.css?v=1",
          hasInfiniteAnimation: true,
          infiniteAnimationSelectors: [".s"],
        }),
      ],
    });
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      const text = JSON.stringify(c);
      expect(text).not.toContain("deploy");
      expect(text).not.toContain("ghp_s3cr3t");
      expect(text).not.toContain("frag");
      expect(c.value).toBe("https://example.com/app.css");
      expect((c.details as { trigger: string }).trigger).toBe("https://example.com/app.css");
    }
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

  // a: unread stylesheets never produce the clean pass
  test("an unread stylesheet with no motion gives the unverified skipped check, no pass", () => {
    const checks = runAll(page(`<link rel="stylesheet" href="/app.css">`), { stylesheetMotion: [] });
    expect(checks.some((c) => c.name === "reduced-motion" && c.status === "pass")).toBe(false);
    const u = checks.find((c) => c.name === "reduced-motion-unverified");
    expect(u?.status).toBe("skipped");
    expect(u?.message).toContain("1 linked stylesheet");
    expect(u?.skipReason).toBeTruthy();
  });

  test("an unread stylesheet plus inline handling still gives no pass", () => {
    const checks = runAll(
      page(
        `<link rel="stylesheet" href="/app.css"><style>@media (prefers-reduced-motion: reduce){*{animation:none}}</style>`,
        `<div data-aos="x"></div>`,
      ),
      { stylesheetMotion: [] },
    );
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    expect(checks.map((c) => c.name)).toEqual(["reduced-motion-unverified"]);
  });

  // b: selectors must match the page
  test("a read sheet's infinite animation needs a matching element", () => {
    const fa = sheet({ hasInfiniteAnimation: true, infiniteAnimationSelectors: [".fa-spin"] });
    const link = `<link rel="stylesheet" href="/app.css">`;
    expect(run(page(link, `<p>hi</p>`), { stylesheetMotion: [fa] })).toHaveLength(0);
    const hit = run(page(link, `<i class="fa-spin"></i>`), { stylesheetMotion: [fa] });
    expect(hit.map((c) => c.name)).toEqual(["reduced-motion-css-infinite-animation"]);
    const pseudo = sheet({ hasInfiniteAnimation: true, infiniteAnimationSelectors: [".x:hover::before, .nope"] });
    expect(run(page(link, `<b class="x"></b>`), { stylesheetMotion: [pseudo] })).toHaveLength(1);
  });

  test("an inline <style> infinite animation needs a matching element", () => {
    const css = `<style>.fa-spin{animation:fa-spin 2s infinite linear}</style>`;
    expect(run(page(css, `<p>hi</p>`))).toHaveLength(0);
    expect(run(page(css, `<i class="fa-spin"></i>`)).map((c) => c.name)).toEqual([
      "reduced-motion-css-infinite-animation",
    ]);
  });

  test("an inline style attribute with an infinite animation always counts", () => {
    const checks = run(page("", `<div style="animation: spin 1s infinite"></div>`));
    expect(checks.map((c) => c.name)).toEqual(["reduced-motion-css-infinite-animation"]);
  });

  // c: library names only in script src and stylesheet/preload links
  test("library names in canonical and alternate links do not count; a script src does", () => {
    expect(
      run(page(`<link rel="canonical" href="/team/lottie-smith"><link rel="alternate" hreflang="fr" href="/fr/parallax-guide">`)),
    ).toHaveLength(0);
    const hit = run(page(`<script src="/js/lottie.min.js"></script>`), {
      scripts: [{ url: "https://example.com/js/lottie.min.js", content: "x", sourcePages: [URL_] }] as never,
    });
    expect(hit.map((c) => c.name)).toEqual(["reduced-motion-lottie"]);
    expect(run(page(`<script src="https://lottie.example.net/x.js?parallax=1"></script>`))).toHaveLength(0);
  });

  // d: autoplay
  test("autoplay video needs both autoplay and loop", () => {
    expect(run(page("", `<video autoplay muted></video>`))).toHaveLength(0);
    expect(run(page("", `<video autoplay loop></video>`)).map((c) => c.name)).toEqual([
      "reduced-motion-autoplay-video",
    ]);
  });

  test("data-autoplay off values do not count", () => {
    expect(run(page("", `<div data-autoplay></div>`))).toHaveLength(0);
    expect(run(page("", `<div data-autoplay=""></div>`))).toHaveLength(0);
    expect(run(page("", `<div data-autoplay="false"></div>`))).toHaveLength(0);
    expect(run(page("", `<div data-autoplay="true"></div>`))).toHaveLength(1);
  });

  // e: webkit prefix and handling detection
  test("-webkit-animation infinite is detected", () => {
    const css = `<style>.s{-webkit-animation: spin 1s infinite}</style>`;
    expect(run(page(css, `<i class="s"></i>`))).toHaveLength(1);
    const css2 = `<style>.t{-webkit-animation-iteration-count: infinite}</style>`;
    expect(run(page(css2, `<i class="t"></i>`))).toHaveLength(1);
  });

  test("body text and CSS comments mentioning prefers-reduced-motion are not handling", () => {
    const anim = `<div style="animation: spin 1s infinite"></div>`;
    expect(run(page("", `<p>We respect prefers-reduced-motion</p>${anim}`))).toHaveLength(1);
    expect(run(page(`<style>/* prefers-reduced-motion */ .s{animation:a 1s infinite}</style>`, `<i class="s"></i>`))).toHaveLength(1);
  });

  test("a script needs matchMedia and the query; GSAP matchMedia counts; the query alone does not", () => {
    const anim = `<div data-aos="x"></div>`;
    expect(run(page(`<script>gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {})</script>`, anim))).toHaveLength(0);
    expect(run(page(`<script>var note = "prefers-reduced-motion";</script>`, anim))).toHaveLength(1);
  });

  test("a stylesheet or style with a prefers-reduced-motion media attribute is handling and gated", () => {
    const anim = `<i class="s"></i>`;
    expect(
      run(page(`<style media="(prefers-reduced-motion: no-preference)">.s{animation:a 1s infinite}</style>`, anim)),
    ).toHaveLength(0);
    const l = `<link rel="stylesheet" media="(prefers-reduced-motion: no-preference)" href="/app.css">`;
    expect(
      run(page(l, anim), { stylesheetMotion: [sheet({ hasInfiniteAnimation: true, infiniteAnimationSelectors: [".s"] })] }),
    ).toHaveLength(0);
  });

  test("stylesheetMotionOf returns capped infinite-animation selectors and real @media handling", () => {
    const s = stylesheetMotionOf(".fa-spin{animation:a 1s infinite} .b{color:red}");
    expect(s.infiniteAnimationSelectors).toEqual([".fa-spin"]);
    const many = Array.from({ length: 300 }, (_, i) => `.c${i}{animation:a 1s infinite}`).join("");
    expect(stylesheetMotionOf(many).infiniteAnimationSelectors).toHaveLength(100);
    expect(stylesheetMotionOf("/* prefers-reduced-motion */ a{color:red}").mentionsReducedMotion).toBe(false);
    expect(stylesheetMotionOf("a{content:'prefers-reduced-motion'}").mentionsReducedMotion).toBe(false);
  });

  // pub#2050 round 2: known font hosts are not unread stylesheets
  test("a page with only a Google Fonts sheet and no motion passes", () => {
    const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">`;
    const checks = runAll(page(fonts), { stylesheetMotion: [] });
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(["reduced-motion:pass"]);
  });

  test("a Google Fonts sheet does not turn a looping animation with no handling into info", () => {
    const head = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>.spin{animation:spin 1s infinite}</style>`;
    const checks = run(page(head, `<i class="spin"></i>`), { stylesheetMotion: [] });
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(["reduced-motion-css-infinite-animation:warn"]);
  });

  test("a third-party CDN stylesheet stays unverified", () => {
    const cdn = `<link rel="stylesheet" href="https://cdn.shopify.com/s/files/theme.css">`;
    const checks = runAll(page(cdn), { stylesheetMotion: [] });
    expect(checks.map((c) => c.name)).toEqual(["reduced-motion-unverified"]);
  });

  test("use.fontawesome.com is not a font host", () => {
    const fa = `<link rel="stylesheet" href="https://use.fontawesome.com/releases/v5.15.4/css/all.css">`;
    expect(runAll(page(fa), { stylesheetMotion: [] }).map((c) => c.name)).toEqual(["reduced-motion-unverified"]);
  });

  // pub#2050 round 2: smooth scrolling needs a matching selector too
  test("an unused .scroll-smooth rule is not a finding", () => {
    expect(run(page(`<style>.scroll-smooth{scroll-behavior:smooth}</style>`))).toHaveLength(0);
  });

  test("html, :root, body and * smooth scrolling always warn", () => {
    for (const sel of ["html", ":root", "body", "*"]) {
      const checks = run(page(`<style>${sel}{scroll-behavior:smooth}</style>`));
      expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual(["reduced-motion-css-smooth-scroll:warn"]);
    }
  });

  test("a used .scroll-smooth rule warns, inline or in a read stylesheet", () => {
    const used = run(page(`<style>.scroll-smooth{scroll-behavior:smooth}</style>`, `<div class="scroll-smooth"></div>`));
    expect(used.map((c) => c.name)).toEqual(["reduced-motion-css-smooth-scroll"]);
    const link = `<link rel="stylesheet" href="/app.css">`;
    const s = sheet({ hasSmoothScroll: true, smoothScrollSelectors: [".scroll-smooth"] });
    expect(run(page(link, `<p>x</p>`), { stylesheetMotion: [s] })).toHaveLength(0);
    expect(run(page(link, `<div class="scroll-smooth"></div>`), { stylesheetMotion: [s] }).map((c) => c.name)).toEqual([
      "reduced-motion-css-smooth-scroll",
    ]);
    expect(stylesheetMotionOf("html,.a{scroll-behavior:smooth}").smoothScrollSelectors).toEqual(["html,.a"]);
  });
});
