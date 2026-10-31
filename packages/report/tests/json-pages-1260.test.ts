// The opt-in `pages` list of the JSON report (#1260): off by default, bounded with an
// explicit truncation marker, and `meta.schemaVersion` says which schema a report is.

import { describe, expect, test } from "bun:test";

import { JSON_REPORT_PAGES, JSON_REPORT_SCHEMA_VERSION } from "@squirrelscan/core-contracts/limits";

import type { AuditReport } from "../src/types";
import { pageOutcome, renderJson, type JsonPageRow } from "../src/output/json";

const report = {
  baseUrl: "https://example.com",
  timestamp: "2026-10-30T00:00:00.000Z",
  totalPages: 3,
  passed: 1,
  warnings: 0,
  failed: 0,
  ruleResults: {},
} as unknown as AuditReport;

const rows = (n: number): JsonPageRow[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/p/${i}`,
    finalUrl: `https://example.com/p/${i}`,
    status: i % 7 === 0 ? 404 : 200,
    outcome: i % 7 === 0 ? "http-error" : "ok",
    ruleCount: i % 5,
  }));

const parse = (options?: Parameters<typeof renderJson>[1]) =>
  JSON.parse(renderJson(report, options)) as Record<string, unknown> & {
    meta: Record<string, unknown>;
  };

describe("meta.schemaVersion", () => {
  test("is 1.3, the version that added technologies.truncated, on every JSON report", () => {
    expect(JSON_REPORT_SCHEMA_VERSION).toBe("1.3");
    expect(parse().meta.schemaVersion).toBe("1.3");
    expect(parse({ pages: rows(1) }).meta.schemaVersion).toBe("1.3");
  });
});

describe("pages list", () => {
  test("off by default: no pages, pagesTotal or pagesTruncated key", () => {
    const json = parse();
    expect(json).not.toHaveProperty("pages");
    expect(json).not.toHaveProperty("pagesTotal");
    expect(json).not.toHaveProperty("pagesTruncated");
  });

  test("lists url, finalUrl, status, outcome and ruleCount per page", () => {
    const json = parse({ pages: rows(3) });
    expect(json.pages).toEqual([
      { url: "https://example.com/p/0", finalUrl: "https://example.com/p/0", status: 404, outcome: "http-error", ruleCount: 0 },
      { url: "https://example.com/p/1", finalUrl: "https://example.com/p/1", status: 200, outcome: "ok", ruleCount: 1 },
      { url: "https://example.com/p/2", finalUrl: "https://example.com/p/2", status: 200, outcome: "ok", ruleCount: 2 },
    ]);
    expect(json.pagesTotal).toBe(3);
    expect(json.pagesTruncated).toBe(false);
  });

  test("an empty crawl lists an empty array, not nothing", () => {
    const json = parse({ pages: [] });
    expect(json.pages).toEqual([]);
    expect(json.pagesTotal).toBe(0);
    expect(json.pagesTruncated).toBe(false);
  });

  test("at the limit is whole; one over is cut and marked, with the real total", () => {
    const at = parse({ pages: rows(JSON_REPORT_PAGES.maxEntries) });
    expect((at.pages as unknown[]).length).toBe(JSON_REPORT_PAGES.maxEntries);
    expect(at.pagesTruncated).toBe(false);

    const over = parse({ pages: rows(JSON_REPORT_PAGES.maxEntries + 500) });
    expect((over.pages as unknown[]).length).toBe(JSON_REPORT_PAGES.maxEntries);
    expect(over.pagesTotal).toBe(JSON_REPORT_PAGES.maxEntries + 500);
    expect(over.pagesTruncated).toBe(true);
    // The first entries are kept, in order.
    expect((over.pages as JsonPageRow[])[0]?.url).toBe("https://example.com/p/0");
  });

  test("extra fields on a row are not copied", () => {
    const json = parse({
      pages: [{ url: "u", finalUrl: "u", status: 200, outcome: "ok", ruleCount: 1, html: "<p>secret</p>" } as JsonPageRow],
    });
    expect(json.pages).toEqual([{ url: "u", finalUrl: "u", status: 200, outcome: "ok", ruleCount: 1 }]);
  });
});

describe("pageOutcome", () => {
  test("ok under 400, rate-limited at 429, http-error for other 4xx and 5xx, error without a usable status", () => {
    for (const status of [200, 204, 301, 302, 399]) expect(pageOutcome(status)).toBe("ok");
    expect(pageOutcome(429)).toBe("rate-limited");
    for (const status of [400, 403, 404, 410, 500, 503]) expect(pageOutcome(status)).toBe("http-error");
    for (const status of [0, -1, 99, 600, Number.NaN, 200.5]) expect(pageOutcome(status)).toBe("error");
  });

  test("a rate-limited page is listed with its URL and the rate-limited outcome", () => {
    const json = parse({
      pages: [{ url: "https://example.com/slow", finalUrl: "https://example.com/slow", status: 429, outcome: pageOutcome(429), ruleCount: 0 }],
    });
    expect(json.pages).toEqual([
      { url: "https://example.com/slow", finalUrl: "https://example.com/slow", status: 429, outcome: "rate-limited", ruleCount: 0 },
    ]);
  });
});
