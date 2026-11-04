// #1550 follow-up: `shopify-payments` is a fact a Shopify storefront states only as JSON
// (`<script id="shopify-features" type="application/json">{"shopifyPaymentsEnabled":true}</script>`), so its detector opts in to
// the text of data scripts (`dataScripts`). Comments and `<template>` content stay cut for it, and every other detector still
// ignores data script text (a vendor URL in JSON is no detection). Synthetic fixtures.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const ids = (html: string): string[] => detectTechnologies({ url: "https://shop.example.com/", headers: {}, html }).map((t) => t.id);
const page = (body: string, head = ""): string => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const FLAG = '{"shopifyPaymentsEnabled":true}';
const FEATURES = `<script id="shopify-features" type="application/json">${FLAG}</script>`;
const YT = '<iframe src="https://www.youtube.com/embed/abc"></iframe>';

describe("shopify-payments reads data script text", () => {
  test("the shopify-features JSON script alone detects it", () => {
    expect(ids(page(FEATURES))).toContain("shopify-payments");
    expect(ids(page(`<script type="application/json">{"a":1,"shopifyPaymentsEnabled": true,"b":2}</script>`))).toContain("shopify-payments");
  });
  test("a false flag does not detect it", () => {
    expect(ids(page('<script id="shopify-features" type="application/json">{"shopifyPaymentsEnabled":false}</script>'))).not.toContain("shopify-payments");
  });
  test("an inline JavaScript flag still detects it", () => {
    expect(ids(page(`<script>window.cfg=${FLAG};</script>`))).toContain("shopify-payments");
  });
  test("the same string in an HTML comment does not", () => {
    expect(ids(page(`<!-- ${FLAG} -->`))).not.toContain("shopify-payments");
    expect(ids(page(`<!-- <script type="application/json">${FLAG}</script> -->`))).not.toContain("shopify-payments");
  });
  test("the same string in a template does not, a data script inside a template included", () => {
    expect(ids(page(`<template>${FEATURES}</template>`))).not.toContain("shopify-payments");
    expect(ids(page(`<template><p>${FLAG}</p></template>`))).not.toContain("shopify-payments");
    expect(ids(page(`<template>${FEATURES}</template><p>shop</p>`))).not.toContain("shopify-payments");
  });
  test("a data script after a closed template still counts", () => {
    expect(ids(page(`<template><p>x</p></template>${FEATURES}`))).toContain("shopify-payments");
  });
});

describe("other detectors still ignore data script text", () => {
  test("a vendor URL in the same kind of data script is not detected", () => {
    const html = page(`${FEATURES}<script type="application/json">{"embed":"${YT.replaceAll('"', '\\"')}"}</script>`);
    const found = ids(html);
    expect(found).toContain("shopify-payments");
    expect(found).not.toContain("youtube-embed");
  });
  test("the opt-in is per detector: a data script beside the flag does not reopen it for others", () => {
    const html = page(`<script id="shopify-features" type="application/json">{"shopifyPaymentsEnabled":true,"u":"https://js.stripe.com/v3/"}</script>`);
    expect(ids(html)).not.toContain("stripe");
  });
});

describe("hostile input stays linear", () => {
  test("many data scripts, comments and templates; the view is built once from the recorded ranges", () => {
    const unit = `<script type="application/json">{"k":"v"}</script><!-- c --><template><i>x</i></template>`;
    const html = page(unit.repeat(40_000) + FEATURES);
    const t0 = performance.now();
    expect(ids(html)).toContain("shopify-payments");
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 30_000);
  test("a huge data script and unterminated regions", () => {
    const big = `<script type="application/json">${'{"a":"b"},'.repeat(400_000)}${FLAG}</script>`;
    const t0 = performance.now();
    expect(ids(page(big))).toContain("shopify-payments");
    expect(ids(page(`<template>${"<!-- ".repeat(100_000)}${FLAG}`))).toContain("shopify-payments");
    expect(ids(page(`<script type="application/json">${FLAG}`))).toContain("shopify-payments");
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});
