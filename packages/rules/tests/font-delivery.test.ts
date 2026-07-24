// perf/font-delivery — render-blocking third-party font CSS (#701).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { fontDeliveryRule } from "../src/performance/font-delivery";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(head: string): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>T</title>${head}</head><body><p>hi</p></body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult {
  const checks = (fontDeliveryRule.run(ctx) as { checks: CheckResult[] }).checks;
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

describe("perf/font-delivery", () => {
  test("warns: render-blocking Google Fonts stylesheet", () => {
    const c = run(
      makeCtx(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`),
    );
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(1);
  });

  test("warns: Typekit stylesheet", () => {
    const c = run(makeCtx(`<link rel="stylesheet" href="https://use.typekit.net/abc123.css">`));
    expect(c.status).toBe("warn");
  });

  test("passes: async-loaded font CSS via media=print swap", () => {
    const c = run(
      makeCtx(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" media="print" onload="this.media='all'">`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: self-hosted stylesheet is not flagged", () => {
    const c = run(makeCtx(`<link rel="stylesheet" href="/assets/fonts.css">`));
    expect(c.status).toBe("pass");
  });

  test("passes: no stylesheets at all", () => {
    const c = run(makeCtx(``));
    expect(c.status).toBe("pass");
  });

  test("warns: @import of a font provider in inline <style>", () => {
    const c = run(
      makeCtx(`<style>@import url("https://fonts.googleapis.com/css?family=Roboto");</style>`),
    );
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toContain("@import");
  });

  test("counts multiple blocking font stylesheets", () => {
    const c = run(
      makeCtx(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` +
          `<link rel="stylesheet" href="https://use.typekit.net/x.css">`,
      ),
    );
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(2);
  });

  test("warns: token-list rel='stylesheet preload' is still matched", () => {
    const c = run(
      makeCtx(
        `<link rel="stylesheet preload" href="https://fonts.googleapis.com/css2?family=Inter">`,
      ),
    );
    expect(c.status).toBe("warn");
  });

  test("passes: print-only @import does not block screen render", () => {
    const c = run(
      makeCtx(
        `<style>@import url("https://fonts.googleapis.com/css?family=Roboto") print;</style>`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("warns: `not print` @import applies to screen (still blocking)", () => {
    const c = run(
      makeCtx(
        `<style>@import url("https://fonts.googleapis.com/css?family=Roboto") not print;</style>`,
      ),
    );
    expect(c.status).toBe("warn");
  });
});
