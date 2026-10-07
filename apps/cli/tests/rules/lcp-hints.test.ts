// perf/lcp-hints: per-page count, no item/image dump (squirrelscan/squirrelscan#16).

import type { RuleContext } from "@squirrelscan/rules";

import { parseHTML } from "@squirrelscan/parser/dom";
import { perf } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

const { lcpHintsRule } = perf;

function pageCtx(html: string, url = "https://example.com/"): RuleContext {
  // Provide the pre-parsed document the runner supplies in production — the CWV
  // rules now read ctx.parsed.document (shared, parsed once) rather than
  // re-parsing ctx.page.html. See #262.
  return {
    page: { url, html, headers: {} },
    parsed: { document: parseHTML(html).document },
    options: {},
  } as unknown as RuleContext;
}

describe("perf/lcp-hints output", () => {
  test("reports a count, not a flat image list", () => {
    const html = `<!doctype html><html><head></head><body>
      <img src="/hero.jpg"><img src="/banner.png"></body></html>`;
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    const c = checks.find((x) => x.name === "lcp-preload");

    expect(c.status).toBe("warn");
    expect(c.value).toBe(2);
    expect(c.message).toContain("2 likely-LCP images");
    // No explicit items / image dump — the report auto-generates one per-page
    // item from the message, so the count survives grouping per page.
    expect(c.items).toBeUndefined();
    expect(c.details).toBeUndefined();
  });

  test("singular wording for one image", () => {
    const html = `<!doctype html><html><body><img src="/hero.jpg"></body></html>`;
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    const c = checks.find((x) => x.name === "lcp-preload");
    expect(c.value).toBe(1);
    expect(c.message).toContain("1 likely-LCP image ");
  });

  test("passes when no large unpreloaded images", () => {
    const html = `<!doctype html><html><body>
      <img src="/thumb.jpg" loading="lazy"></body></html>`;
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    const c = checks.find((x) => x.name === "lcp-preload");
    expect(c.status).toBe("pass");
  });
});

// Eligibility and preload matching shared with perf/lcp-fetchpriority (#516).
describe("perf/lcp-hints candidates and preload matching", () => {
  const preloadCheck = (html: string) => {
    const { checks } = lcpHintsRule.run(pageCtx(html)) as { checks: any[] };
    return checks.find((x) => x.name === "lcp-preload");
  };

  const REPRO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>LCP preload repro page</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preload" as="image" href="/hero.png" fetchpriority="high">
</head><body>
<header><img src="/logo1.svg" alt="Logo one" width="120" height="40" loading="eager"><img src="/logo2.svg" alt="Logo two" width="120" height="40" loading="eager"></header>
<main><h1>Repro</h1>
<img src="/hero.png" alt="Hero" width="1200" height="800" fetchpriority="high">
<img src="/avatar1.png" alt="Avatar one" width="80" height="80"><img src="/avatar2.png" alt="Avatar two" width="80" height="80">
</main></body></html>`;

  test("reporter repro (two logos, preloaded hero) passes", () => {
    expect(preloadCheck(REPRO).status).toBe("pass");
  });

  test("the same page without the hero preload warns with value 1", () => {
    const c = preloadCheck(REPRO.replace(/<link rel="preload"[^>]*>/, ""));
    expect(c.status).toBe("warn");
    expect(c.value).toBe(1);
  });

  test("undimensioned two-image case still warns with value 2", () => {
    const c = preloadCheck(
      `<!doctype html><html><body><img src="/hero.jpg"><img src="/banner.png"></body></html>`,
    );
    expect(c.status).toBe("warn");
    expect(c.value).toBe(2);
  });

  test("an absolute-URL preload for a relative src passes", () => {
    const c = preloadCheck(`<!doctype html><html><head>
      <link rel="preload" as="image" href="https://example.com/hero.png"></head>
      <body><img src="/hero.png" width="1200" height="800"></body></html>`);
    expect(c.status).toBe("pass");
  });

  test("a preload with a query string passes", () => {
    const c = preloadCheck(`<!doctype html><html><head>
      <link rel="preload" as="image" href="/hero.png?v=2"></head>
      <body><img src="/hero.png" width="1200" height="800"></body></html>`);
    expect(c.status).toBe("pass");
  });

  test("a preload through imagesrcset passes", () => {
    const c = preloadCheck(`<!doctype html><html><head>
      <link rel="preload" as="image" imagesrcset="/hero-480.png 480w, /hero-1200.png 1200w"></head>
      <body><img src="/hero-1200.png" width="1200" height="800"></body></html>`);
    expect(c.status).toBe("pass");
  });

  test("a small avatar before the hero is not counted", () => {
    const c = preloadCheck(`<!doctype html><html><body>
      <img src="/avatar.png" width="80" height="80">
      <img src="/hero.png" width="1200" height="800"></body></html>`);
    expect(c.value).toBe(1);
  });

  test("an SVG logo before the hero is not counted", () => {
    const c = preloadCheck(`<!doctype html><html><body>
      <img src="/logo.svg" width="400" height="400">
      <img src="/hero.png" width="1200" height="800"></body></html>`);
    expect(c.value).toBe(1);
  });

  test("an image in header or nav is not counted", () => {
    const c = preloadCheck(`<!doctype html><html><body>
      <nav><img src="/menu.png"></nav><header><img src="/brand.png"></header>
      <img src="/hero.png" width="1200" height="800"></body></html>`);
    expect(c.value).toBe(1);
  });

  test("a preload for another image does not clear the hero", () => {
    const c = preloadCheck(`<!doctype html><html><head>
      <link rel="preload" as="image" href="/other.png"></head>
      <body><img src="/hero.png" width="1200" height="800"></body></html>`);
    expect(c.status).toBe("warn");
  });
});

describe("perf/lcp-hints and perf/lcp-fetchpriority share the hero candidate", () => {
  test("the unpreloaded hero lcp-hints counts is the one lcp-fetchpriority flags", () => {
    const html = `<!doctype html><html><body>
      <header><img src="/logo.png" width="400" height="100"></header>
      <img src="/small.png" width="100" height="100">
      <img src="/hero.png" width="1200" height="800"></body></html>`;
    const ctx = pageCtx(html);
    const hints = (lcpHintsRule.run(ctx) as { checks: any[] }).checks[0];
    const fp = (perf.lcpFetchpriorityRule.run(ctx) as { checks: any[] }).checks[0];
    expect(hints.value).toBe(1);
    expect(fp.status).toBe("warn");
    expect(fp.items[0].id).toBe("/hero.png");
  });
});

