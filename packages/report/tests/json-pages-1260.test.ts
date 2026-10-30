// The opt-in `pages` list of the JSON report (#1260): off by default, bounded with an
// explicit truncation marker, and `meta.schemaVersion` says which schema a report is.

import { describe, expect, test } from "bun:test";

import { JSON_REPORT_PAGES, JSON_REPORT_SCHEMA_VERSION } from "@squirrelscan/core-contracts/limits";

import type { AuditReport } from "../src/types";
import { renderJson, type JsonPageRow } from "../src/output/json";

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
    status: i % 7 === 0 ? 404 : 200,
    ruleCount: i % 5,
  }));

const parse = (options?: Parameters<typeof renderJson>[1]) =>
  JSON.parse(renderJson(report, options)) as Record<string, unknown> & {
    meta: Record<string, unknown>;
  };

describe("meta.schemaVersion", () => {
  test("is 1.2 on every JSON report", () => {
    expect(JSON_REPORT_SCHEMA_VERSION).toBe("1.2");
    expect(parse().meta.schemaVersion).toBe("1.2");
    expect(parse({ pages: rows(1) }).meta.schemaVersion).toBe("1.2");
  });
});

describe("pages list", () => {
  test("off by default: no pages, pagesTotal or pagesTruncated key", () => {
    const json = parse();
    expect(json).not.toHaveProperty("pages");
    expect(json).not.toHaveProperty("pagesTotal");
    expect(json).not.toHaveProperty("pagesTruncated");
  });

  test("lists url, status and ruleCount per page", () => {
    const json = parse({ pages: rows(3) });
    expect(json.pages).toEqual([
      { url: "https://example.com/p/0", status: 404, ruleCount: 0 },
      { url: "https://example.com/p/1", status: 200, ruleCount: 1 },
      { url: "https://example.com/p/2", status: 200, ruleCount: 2 },
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
      pages: [{ url: "u", status: 200, ruleCount: 1, html: "<p>secret</p>" } as JsonPageRow],
    });
    expect(json.pages).toEqual([{ url: "u", status: 200, ruleCount: 1 }]);
  });
});
