// `storeIntegrity` in the JSON report and the page map (#1667): present only when page bodies are gone.

import { describe, expect, test } from "bun:test";

import { renderJson } from "../src/output/json";
import { pageMapMeta, renderPageMapJson } from "../src/page-map";
import type { AuditReport } from "../src/types";

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  baseUrl: "https://example.com",
  timestamp: "2026-11-10T10:00:00.000Z",
  totalPages: 0,
  passed: 0,
  warnings: 0,
  failed: 0,
  ruleResults: {},
  ...over,
});

describe("report JSON", () => {
  test("carries meta.storeIntegrity when bodies were evicted", () => {
    const parsed = JSON.parse(renderJson(report({ storeIntegrity: { status: "evicted", evicted: 3, stored: 10 } })));
    expect(parsed.meta.storeIntegrity).toEqual({ status: "evicted", evicted: 3, stored: 10 });
  });

  test("has no storeIntegrity when none were", () => {
    expect("storeIntegrity" in JSON.parse(renderJson(report())).meta).toBe(false);
  });
});

describe("page map JSON", () => {
  const crawl = { id: "c1", baseUrl: "https://example.com", startedAt: 1 };

  test("carries storeIntegrity when bodies were evicted", () => {
    const meta = pageMapMeta(crawl, 5, { status: "evicted", evicted: 2, stored: 5 });
    expect(JSON.parse(renderPageMapJson([], meta)).storeIntegrity).toEqual({ status: "evicted", evicted: 2, stored: 5 });
  });

  test("has none otherwise, and the other fields are unchanged", () => {
    const parsed = JSON.parse(renderPageMapJson([], pageMapMeta(crawl, 5)));
    expect("storeIntegrity" in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual(["site", "crawlId", "startedAt", "total", "filtered", "pages"]);
  });
});
