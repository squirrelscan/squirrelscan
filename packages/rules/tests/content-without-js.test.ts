// ax/content-without-js — raw-HTML vs cloud-rendered DOM content diff.
//
// Verifies: graceful skip with no render result (CLI-only audits), skip on an
// empty render, an `info` flag when substantial content is JS-only (SPA shell),
// and a `pass` when the raw HTML already carries the content (SSR).

import { describe, expect, test } from "bun:test";

import type { RenderResultItem } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { contentWithoutJsRule } from "../src/ax/content-without-js";
import type { CloudResultEnvelope, CloudResultStore } from "../src/cloud";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

/** N distinct whitespace-separated words → exact wordCount via extractContent. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `lorem${i}`).join(" ");
}

/** A full page with `n` words of body content. */
function page(n: number): string {
  return `<!DOCTYPE html><html><head><title>T</title></head><body><main><p>${words(n)}</p></main></body></html>`;
}

/** SPA shell: empty root, zero body words. */
const SHELL = `<!DOCTYPE html><html><head><title>T</title></head><body><div id="root"></div></body></html>`;

function renderEnvelope(html: string | undefined): CloudResultEnvelope<RenderResultItem> {
  return { status: "ok", data: { url: URL, status: 200, html } };
}

function makeCtx(rawHtml: string, render?: CloudResultEnvelope<RenderResultItem>): RuleContext {
  const parsed = parsePage(rawHtml, URL);
  const cloudResults: CloudResultStore | undefined = render
    ? new Map([["render", new Map([[URL, render as CloudResultEnvelope]])]])
    : undefined;
  return {
    page: { url: URL, html: rawHtml, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    cloudResults,
    options: {},
  };
}

function only(ctx: RuleContext): CheckResult {
  const checks = (contentWithoutJsRule.run(ctx) as { checks: CheckResult[] }).checks;
  expect(checks).toHaveLength(1);
  return checks[0];
}

describe("ax/content-without-js", () => {
  test("declares the render cloud spec (info severity, never penalizes)", () => {
    expect(contentWithoutJsRule.meta.cloud).toEqual({
      service: "render",
      unit: "page",
      creditFeature: "render",
    });
    expect(contentWithoutJsRule.meta.severity).toBe("info");
    expect(contentWithoutJsRule.meta.category).toBe("ax");
  });

  test("skips when no render result was prefetched (CLI-only audit)", () => {
    const c = only(makeCtx(page(300))); // no cloudResults
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toBeTruthy();
  });

  test("skips when the crawl itself rendered (self-identical raw==rendered, #673)", () => {
    // Even WITH a render envelope present, a rendered crawl makes ctx.parsed the rendered DOM already, so
    // the raw-vs-rendered diff is meaningless → skip before comparing (design-wrinkle gate).
    const ctx = makeCtx(page(300), renderEnvelope(page(300)));
    ctx.page.rendered = true;
    const c = only(ctx);
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toMatch(/render/i);
    expect(c.details).toBeUndefined(); // gated out before any word-count comparison
  });

  test("skips when the render result is itself skipped", () => {
    const store: CloudResultStore = new Map([
      ["render", new Map([[URL, { status: "skipped", skipReason: "insufficient-credits" }]])],
    ]);
    const parsed = parsePage(page(300), URL);
    const c = only({
      page: { url: URL, html: page(300), statusCode: 200, loadTime: 0, headers: {}, parsed },
      parsed,
      cloudResults: store,
      options: {},
    });
    expect(c.status).toBe("skipped");
  });

  test("skips when the render returned no HTML", () => {
    const c = only(makeCtx(page(300), renderEnvelope(undefined)));
    expect(c.status).toBe("skipped");
  });

  test("skips when the ok envelope carries no data payload", () => {
    const c = only(makeCtx(page(300), { status: "ok" }));
    expect(c.status).toBe("skipped");
  });

  test("passes (clamped) when raw HTML has more words than rendered", () => {
    // 400 raw vs 200 rendered (e.g. noscript stripped) → no negative jsOnlyPct.
    const c = only(makeCtx(page(400), renderEnvelope(page(200))));
    expect(c.status).toBe("pass");
    expect(c.details?.jsOnlyWords).toBe(0);
    expect(c.details?.jsOnlyPct).toBe(0);
  });

  test("flags (info) when substantial content is JS-only (SPA shell)", () => {
    const c = only(makeCtx(SHELL, renderEnvelope(page(300))));
    expect(c.status).toBe("info");
    expect(c.details?.rawWords).toBe(0);
    expect(c.details?.renderedWords).toBe(300);
    expect(c.details?.jsOnlyWords).toBe(300);
    expect(c.details?.jsOnlyPct).toBe(100);
  });

  test("passes when raw HTML already carries the content (SSR — raw == rendered)", () => {
    const html = page(300);
    const c = only(makeCtx(html, renderEnvelope(html)));
    expect(c.status).toBe("pass");
    expect(c.details?.jsOnlyWords).toBe(0);
  });

  test("passes when the JS-only delta is below the floor", () => {
    // 250 raw vs 300 rendered → 50 JS-only words (< 100 floor) → not flagged.
    const c = only(makeCtx(page(250), renderEnvelope(page(300))));
    expect(c.status).toBe("pass");
  });

  test("passes when raw coverage stays above the threshold", () => {
    // 200 raw vs 300 rendered → 100 JS-only (meets floor) but 67% coverage (> 60%) → pass.
    const c = only(makeCtx(page(200), renderEnvelope(page(300))));
    expect(c.status).toBe("pass");
  });
});
