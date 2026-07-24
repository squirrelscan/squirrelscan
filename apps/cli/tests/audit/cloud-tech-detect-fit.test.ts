// fitTechDetectPages must keep the serialized tech-detect body under the API's
// maxBodyBytes limit. Per-page caps alone (512KB × 12 pages = 6MB) exceed the
// 5MB limit and 413 the whole step silently (#192) — the aggregate must fit.

import type { TechDetectPagePayload } from "@squirrelscan/core-contracts";

import { SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import { describe, expect, test } from "bun:test";

import { fitTechDetectPages } from "../../src/audit/cloud";

const cap = SERVICE_LIMITS.techDetectMaxHtmlBytes;

function bigPage(i: number, bytes = cap): TechDetectPagePayload {
  return {
    url: `https://example.com/page-${i}`,
    headers: { "content-type": "text/html" },
    html: "a".repeat(bytes),
    meta: { generator: "test" },
  };
}

function bodyBytes(pages: TechDetectPagePayload[]): number {
  return new TextEncoder().encode(JSON.stringify(pages)).length;
}

describe("fitTechDetectPages", () => {
  test("12 max-size pages stay under maxBodyBytes (the 413 case)", () => {
    const home: TechDetectPagePayload = {
      ...bigPage(0),
      scripts: [
        { url: "https://example.com/app.js", content: "x".repeat(16 * 1024) },
      ],
    };
    const rest = Array.from({ length: 11 }, (_, i) => bigPage(i + 1));

    const fitted = fitTechDetectPages(home, rest);

    expect(bodyBytes(fitted)).toBeLessThanOrEqual(SERVICE_LIMITS.maxBodyBytes);
    // Home is always retained, first.
    expect(fitted[0]?.url).toBe(home.url);
    expect(fitted[0]?.scripts?.length).toBe(1);
    // Some sample pages drop out (6MB worth can't all fit in 5MB).
    expect(fitted.length).toBeLessThan(12);
    expect(fitted.length).toBeGreaterThan(1);
  });

  test("small inputs keep every page", () => {
    const home = bigPage(0, 1_000);
    const rest = [bigPage(1, 1_000), bigPage(2, 1_000)];

    const fitted = fitTechDetectPages(home, rest);

    expect(fitted).toHaveLength(3);
    expect(bodyBytes(fitted)).toBeLessThanOrEqual(SERVICE_LIMITS.maxBodyBytes);
  });

  test("home larger than the whole budget is trimmed to fit", () => {
    // A single pathological page bigger than maxBodyBytes on its own.
    const home = bigPage(0, SERVICE_LIMITS.maxBodyBytes + 1_000_000);

    const fitted = fitTechDetectPages(home, []);

    expect(fitted).toHaveLength(1);
    expect(fitted[0]?.url).toBe(home.url);
    expect(bodyBytes(fitted)).toBeLessThanOrEqual(SERVICE_LIMITS.maxBodyBytes);
    // HTML was trimmed, not dropped.
    expect(fitted[0]?.html.length ?? 0).toBeGreaterThan(0);
    expect(fitted[0]?.html.length ?? 0).toBeLessThan(home.html.length);
  });

  test("escape-heavy adversarial content still fits (no estimate-based overflow)", () => {
    // Quotes/backslashes double and control chars sextuple under JSON encoding,
    // so a fixed inflation discount would under-trim. The packer measures the
    // real serialized size, so it must still hold.
    const nasty = '"\\ '.repeat(SERVICE_LIMITS.maxBodyBytes); // ~3x maxBody chars
    const home: TechDetectPagePayload = {
      url: "https://example.com/",
      headers: { "content-type": "text/html" },
      html: nasty,
      meta: { generator: "test" },
      scripts: Array.from({ length: 60 }, (_, i) => ({
        url: `https://example.com/s${i}.js`,
        content: '"\\'.repeat(16 * 1024),
      })),
    };
    const rest = Array.from({ length: 11 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      headers: {},
      html: '"\\ '.repeat(cap),
      meta: {},
    }));

    const fitted = fitTechDetectPages(home, rest);

    expect(bodyBytes(fitted)).toBeLessThanOrEqual(SERVICE_LIMITS.maxBodyBytes);
    expect(fitted[0]?.url).toBe(home.url);
    expect(fitted[0]?.scripts?.length).toBe(60);
  });

  test("realistic worst case: 60 max-size scripts + max html still fits", () => {
    // The caller caps scripts at 60 × 16KB; escape-heavy content roughly doubles
    // under JSON encoding (~1.9MB) but stays well under budget alongside the
    // home HTML, so every script is retained and the body fits.
    const home: TechDetectPagePayload = {
      url: "https://example.com/",
      headers: { "content-type": "text/html" },
      html: "a".repeat(cap),
      meta: { generator: "test" },
      scripts: Array.from({ length: 60 }, (_, i) => ({
        url: `https://example.com/s${i}.js`,
        content: '"\\'.repeat(8 * 1024), // 16KB of escape-heavy content
      })),
    };

    const fitted = fitTechDetectPages(home, []);

    expect(fitted).toHaveLength(1);
    expect(fitted[0]?.url).toBe(home.url);
    expect(fitted[0]?.scripts?.length).toBe(60);
    expect(bodyBytes(fitted)).toBeLessThanOrEqual(SERVICE_LIMITS.maxBodyBytes);
  });

  test("smaller later pages still pack after a too-big one (continue, not break)", () => {
    const home = bigPage(0, 1_000);
    // A huge sample page that can't coexist with other large ones, followed by
    // tiny pages that must still be included.
    const rest = [
      bigPage(1, cap),
      bigPage(2, 1_000),
      bigPage(3, cap),
      bigPage(4, 1_000),
    ];

    const fitted = fitTechDetectPages(home, rest);

    expect(bodyBytes(fitted)).toBeLessThanOrEqual(SERVICE_LIMITS.maxBodyBytes);
    const urls = fitted.map((p) => p.url);
    expect(urls).toContain("https://example.com/page-2");
    expect(urls).toContain("https://example.com/page-4");
  });
});
