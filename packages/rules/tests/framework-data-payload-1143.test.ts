// perf/framework-data-payload (#1143): a large inline framework payload on a page
// that is mostly text. Fixtures are synthetic pages shaped like the real ones
// (sizes from the smoke run in the PR: Next.js app router flight chunks of
// 120-460 KB on marketing and docs pages with 3-8 KB of text).

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { frameworkDataPayloadRule } from "../src/performance/framework-data-payload";
import { findFrameworkPayloads } from "../src/shared/framework-payload";
import type { ParsedPage, RuleContext } from "../src/types";

const doc = (html: string) => parseHTML(html).document as unknown as NonNullable<ParsedPage["document"]>;

function run(html: string, options: Record<string, unknown> = {}) {
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: doc(html) } as unknown as ParsedPage,
    options,
  };
  const result = frameworkDataPayloadRule.run(ctx);
  if (result instanceof Promise) throw new Error("unexpected async rule");
  return result.checks;
}

const page = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

/** A paragraph of `words` words of prose. */
const prose = (words: number) =>
  Array.from({ length: words }, (_, i) => `word${i % 50}`).join(" ");

/** `kb` kilobytes of Next.js app router flight chunks, as the real page streams them. */
const nextFlight = (kb: number) => {
  const chunk = `self.__next_f.push([1,"${"a".repeat(2000)}"])`;
  return Array.from({ length: Math.ceil((kb * 1024) / chunk.length) }, () => `<script>${chunk}</script>`).join("");
};

const nextData = (kb: number) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { rows: "x".repeat(kb * 1024) } } })}</script>`;

describe("findFrameworkPayloads", () => {
  test("names each framework's payload and sums chunked ones", () => {
    const found = findFrameworkPayloads(
      doc(
        page(
          `${nextFlight(10)}${nextData(5)}
           <script id="__NUXT_DATA__" type="application/json">[1,2,3]</script>
           <script>window.__NUXT__={a:1}</script>
           <script>window.__remixContext = {"state":{}};</script>
           <script type="qwik/json">{"ctx":{}}</script>
           <astro-island props="{&quot;a&quot;:[0,1]}"></astro-island>
           <script>window.__sveltekit_abc = {};</script>
           <script>window.__APOLLO_STATE__={};</script>`,
        ),
      ),
    );
    const kinds = found.map((p) => p.kind).sort();
    expect(kinds).toEqual(["astro", "global-state", "next-app", "next-pages", "nuxt", "qwik", "remix", "sveltekit"]);
    const flight = found.find((p) => p.kind === "next-app")!;
    expect(flight.count).toBeGreaterThan(3);
    expect(flight.bytes).toBeGreaterThanOrEqual(10 * 1024);
  });

  test("JSON-LD, import maps and ordinary scripts are not framework state", () => {
    const found = findFrameworkPayloads(
      doc(
        page(
          `<script type="application/ld+json">{"@context":"https://schema.org","name":"${"x".repeat(5000)}"}</script>
           <script type="importmap">{"imports":{}}</script>
           <script>console.log("${"y".repeat(5000)}")</script>`,
        ),
      ),
    );
    expect(found).toEqual([]);
  });

  test("a payload in noscript is not read, and the prefix test reads only the start of a script", () => {
    const hidden = findFrameworkPayloads(doc(page(`<noscript><script id="__NEXT_DATA__">{}</script></noscript>`)));
    expect(hidden).toEqual([]);
    // The marker deep inside a script is ordinary code, not the state assignment.
    const deep = findFrameworkPayloads(doc(page(`<script>${"x".repeat(500)};window.__NUXT__={}</script>`)));
    expect(deep).toEqual([]);
  });

  test("a page of thousands of scripts is read only to its cap", () => {
    const scripts = Array.from({ length: 5000 }, () => `<script>self.__next_f.push([1,"a"])</script>`).join("");
    const [flight] = findFrameworkPayloads(doc(page(scripts)));
    expect(flight!.count).toBe(2000);
  });
});

describe("perf/framework-data-payload", () => {
  test("a text page with 150 KB of flight data is flagged at info, with every number", () => {
    const [check] = run(page(`<main><h1>Docs</h1><p>${prose(300)}</p></main>${nextFlight(150)}`));
    expect(check?.status).toBe("info");
    expect(check?.message).toContain("self.__next_f");
    expect(check?.items?.[0]?.id).toBe("self.__next_f");
    expect(check?.details).toMatchObject({ formFields: 0, embeddedMedia: 0 });
    expect((check?.details as { ratio: number }).ratio).toBeGreaterThanOrEqual(20);
  });

  test("__NEXT_DATA__ on a static page is flagged too", () => {
    const [check] = run(page(`<article><p>${prose(200)}</p></article>${nextData(120)}`));
    expect(check?.status).toBe("info");
  });

  test("a small payload passes", () => {
    const [check] = run(page(`<p>${prose(200)}</p>${nextData(20)}`));
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("under the");
  });

  test("no payload passes", () => {
    const [check] = run(page(`<p>${prose(200)}</p>`));
    expect(check?.status).toBe("pass");
  });

  test("an interactive page (many form fields) is not flagged, however big the payload", () => {
    const fields = Array.from({ length: 12 }, (_, i) => `<input type="text" name="f${i}">`).join("");
    const [check] = run(page(`<main><form>${fields}</form><p>${prose(100)}</p></main>${nextFlight(300)}`));
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("interactive");
  });

  test("a page with embedded media is not flagged", () => {
    const media = '<canvas></canvas><video></video><iframe></iframe><audio></audio><embed><object></object>';
    const [check] = run(page(`<p>${prose(100)}</p>${media}${nextFlight(300)}`));
    expect(check?.status).toBe("pass");
  });

  test("a page that is mostly data (text comparable to the payload) is not flagged", () => {
    const [check] = run(page(`<p>${prose(30000)}</p>${nextData(110)}`));
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("mostly data");
  });

  test("hidden inputs and submit buttons are not interactivity", () => {
    const html = page(
      `<p>${prose(200)}</p><form><input type="hidden" name="a"><input type="submit"></form>${nextFlight(150)}`,
    );
    expect(run(html)[0]?.status).toBe("info");
  });

  test("the options move the thresholds", () => {
    const html = page(`<p>${prose(200)}</p>${nextData(40)}`);
    expect(run(html)[0]?.status).toBe("pass");
    expect(run(html, { min_bytes: 30 * 1024 })[0]?.status).toBe("info");
  });

  test("a page with no document emits nothing", () => {
    const ctx = { page: {}, parsed: { document: null }, options: {} } as unknown as RuleContext;
    const result = frameworkDataPayloadRule.run(ctx);
    expect(result instanceof Promise ? [] : result.checks).toEqual([]);
  });

  test("an empty document (no root element) passes without throwing", () => {
    for (const html of ["", "   ", "just text", "<!-- only a comment -->"]) {
      const checks = run(html);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
    }
  });
});
