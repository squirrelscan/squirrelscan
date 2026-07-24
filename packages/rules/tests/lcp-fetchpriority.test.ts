// perf/lcp-fetchpriority — hero image eager without fetchpriority/preload (#701).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { lcpFetchpriorityRule } from "../src/performance/lcp-fetchpriority";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(bodyOrDoc: string, head = ""): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>T</title>${head}</head><body>${bodyOrDoc}</body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult {
  const checks = (lcpFetchpriorityRule.run(ctx) as { checks: CheckResult[] }).checks;
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

describe("perf/lcp-fetchpriority", () => {
  test("warns: eager hero without fetchpriority or preload", () => {
    const c = run(makeCtx(`<img src="/hero.jpg" alt="hero">`));
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toBe("/hero.jpg");
  });

  test("passes: fetchpriority='high' present", () => {
    const c = run(makeCtx(`<img src="/hero.jpg" fetchpriority="high">`));
    expect(c.status).toBe("pass");
  });

  test("passes: preload as=image matches src", () => {
    const c = run(
      makeCtx(`<img src="/hero.jpg">`, `<link rel="preload" as="image" href="/hero.jpg">`),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: responsive preload imagesrcset matches src", () => {
    const c = run(
      makeCtx(
        `<img src="/hero-800.jpg">`,
        `<link rel="preload" as="image" imagesrcset="/hero-400.jpg 400w, /hero-800.jpg 800w">`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("warns: preload for a DIFFERENT image does not cover the hero", () => {
    const c = run(
      makeCtx(`<img src="/hero.jpg">`, `<link rel="preload" as="image" href="/other.jpg">`),
    );
    expect(c.status).toBe("warn");
  });

  test("info: no eager content image", () => {
    const c = run(makeCtx(`<p>no images</p>`));
    expect(c.status).toBe("info");
  });

  test("info: only lazy images (deferred to lazy rules)", () => {
    const c = run(makeCtx(`<img src="/hero.jpg" loading="lazy">`));
    expect(c.status).toBe("info");
  });

  test("skips header logo, flags the body hero", () => {
    const c = run(
      makeCtx(`<header><img src="/logo.png"></header><main><img src="/hero.jpg"></main>`),
    );
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toBe("/hero.jpg");
  });

  test("skips data URI, svg, and tiny declared images", () => {
    const c = run(
      makeCtx(
        `<img src="data:image/png;base64,AAAA"><img src="/icon.svg"><img src="/badge.png" width="40" height="40">`,
      ),
    );
    // Only non-content candidates → no candidate found.
    expect(c.status).toBe("info");
  });

  test("skips tracking pixel by src pattern", () => {
    const c = run(makeCtx(`<img src="/tracking-pixel.gif"><main><img src="/hero.jpg"></main>`));
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toBe("/hero.jpg");
  });

  test("passes: candidate's own srcset variant is preloaded", () => {
    const c = run(
      makeCtx(
        `<img src="/hero-400.jpg" srcset="/hero-400.jpg 400w, /hero-800.jpg 800w">`,
        `<link rel="preload" as="image" imagesrcset="/hero-800.jpg 800w">`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("info: small declared content image is not the LCP candidate", () => {
    const c = run(makeCtx(`<main><img src="/thumb.jpg" width="200" height="150"></main>`));
    expect(c.status).toBe("info");
  });

  test("warns: large declared content image is a candidate", () => {
    const c = run(makeCtx(`<main><img src="/hero.jpg" width="1200" height="700"></main>`));
    expect(c.status).toBe("warn");
  });
});
