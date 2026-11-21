// perf/font-delivery — render-blocking third-party font CSS (#701).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import {
  fontDeliveryRule,
  mediaQueriesOf,
} from "../src/performance/font-delivery";

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

async function run(ctx: RuleContext): Promise<CheckResult> {
  const checks = (
    (await fontDeliveryRule.run(ctx)) as { checks: CheckResult[] }
  ).checks;
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

describe("perf/font-delivery", () => {
  test("warns: render-blocking Google Fonts stylesheet", async () => {
    const c = await run(
      makeCtx(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`
      )
    );
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(1);
  });

  test("warns: Typekit stylesheet", async () => {
    const c = await run(
      makeCtx(
        `<link rel="stylesheet" href="https://use.typekit.net/abc123.css">`
      )
    );
    expect(c.status).toBe("warn");
  });

  test("passes: async-loaded font CSS via media=print swap", async () => {
    const c = await run(
      makeCtx(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" media="print" onload="this.media='all'">`
      )
    );
    expect(c.status).toBe("pass");
  });

  test("passes: self-hosted stylesheet is not flagged", async () => {
    const c = await run(
      makeCtx(`<link rel="stylesheet" href="/assets/fonts.css">`)
    );
    expect(c.status).toBe("pass");
  });

  test("passes: no stylesheets at all", async () => {
    const c = await run(makeCtx(``));
    expect(c.status).toBe("pass");
  });

  test("warns: @import of a font provider in inline <style>", async () => {
    const c = await run(
      makeCtx(
        `<style>@import url("https://fonts.googleapis.com/css?family=Roboto");</style>`
      )
    );
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toContain("@import");
  });

  test("counts multiple blocking font stylesheets", async () => {
    const c = await run(
      makeCtx(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` +
          `<link rel="stylesheet" href="https://use.typekit.net/x.css">`
      )
    );
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(2);
  });

  test("warns: token-list rel='stylesheet preload' is still matched", async () => {
    const c = await run(
      makeCtx(
        `<link rel="stylesheet preload" href="https://fonts.googleapis.com/css2?family=Inter">`
      )
    );
    expect(c.status).toBe("warn");
  });

  test("passes: print-only @import does not block screen render", async () => {
    const c = await run(
      makeCtx(
        `<style>@import url("https://fonts.googleapis.com/css?family=Roboto") print;</style>`
      )
    );
    expect(c.status).toBe("pass");
  });

  test("warns: layer(print) names a cascade layer, not the print medium", async () => {
    const c = await run(
      makeCtx(
        `<style>@import url("https://fonts.googleapis.com/css?family=Roboto") layer(print);</style>`
      )
    );
    expect(c.status).toBe("warn");
  });

  test("passes: a font @import inside a CSS comment loads nothing (#725)", async () => {
    const c = await run(
      makeCtx(
        `<style>/* @import url("https://fonts.googleapis.com/css?family=Roboto"); */ body{}</style>`
      )
    );
    expect(c.status).toBe("pass");
  });

  test("passes: a font @import after another rule is never fetched (#725)", async () => {
    const c = await run(
      makeCtx(
        `<style>body{} @import url("https://fonts.googleapis.com/css?family=Roboto");</style>`
      )
    );
    expect(c.status).toBe("pass");
  });

  test("warns: `not print` @import applies to screen (still blocking)", async () => {
    const c = await run(
      makeCtx(
        `<style>@import url("https://fonts.googleapis.com/css?family=Roboto") not print;</style>`
      )
    );
    expect(c.status).toBe("warn");
  });
});

describe("perf/font-delivery on adversarial style text", () => {
  test("drops layer() and supports(), nested parens included, and keeps the media", () => {
    expect(
      mediaQueriesOf(
        "layer(print) supports(selector(:has(a))) not print"
      ).trim()
    ).toBe("not print");
    expect(mediaQueriesOf("sublayer(x) print")).toBe("sublayer(x) print");
  });

  test("200 KB of unclosed layer(, comment openers or @import repeats runs well under the budget", async () => {
    const font =
      '@import url("https://fonts.googleapis.com/css?family=Roboto") ';
    const started = performance.now();
    for (const style of [
      font + "layer(".repeat(34_000),
      font + "supports(".repeat(23_000),
      `${font};${"/*".repeat(100_000)}`,
      "@import ".repeat(25_000),
      `@import${" ".repeat(200_000)})`,
    ]) {
      await run(makeCtx(`<style>${style}</style>`));
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
