// The rate-limit line is the caveat on the page count, so it has to say how
// much of the site the crawl never reached, not only how many fetches failed
//. Absent `unfetched` (older reports) must print exactly what it did.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { fullScanHint } from "../src/coverage";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

function report(rateLimited: NonNullable<AuditReport["rateLimited"]>): AuditReport {
  return {
    baseUrl: "https://shop.example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 320,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    status: "partial",
    statusReason: "437 pages rate limited by shop.example.com; 918 more discovered but not fetched",
    rateLimited,
  };
}

const throttled = report({ pages: 437, hosts: ["shop.example.com"], unfetched: 918 });
const legacy = report({ pages: 437, hosts: ["shop.example.com"] });

describe("rate-limited unfetched count", () => {
  test("text names the failed and the unfetched counts", () => {
    expect(renderText(throttled)).toContain(
      "Rate limited: 437 page(s) not verified (shop.example.com); 918 more discovered but not fetched",
    );
  });

  test("markdown names the failed and the unfetched counts", () => {
    expect(renderMarkdown(throttled)).toContain(
      "**Rate limited:** 437 page(s) not verified (shop.example.com); 918 more discovered but not fetched",
    );
  });

  test("llm carries the count as an attribute and says what it means", () => {
    const xml = renderLlm(throttled);
    expect(xml).toContain('<rate-limited pages="437" unfetched="918" hosts="shop.example.com">');
    expect(xml).toContain("918 more URL(s) were discovered but never fetched");
  });

  test("a report without the count prints what it always did", () => {
    expect(renderText(legacy)).toContain(
      "Rate limited: 437 page(s) not verified (shop.example.com)\n",
    );
    expect(renderMarkdown(legacy)).toContain(
      "**Rate limited:** 437 page(s) not verified (shop.example.com)  \n",
    );
    const xml = renderLlm(legacy);
    expect(xml).toContain('<rate-limited pages="437" hosts="shop.example.com">');
    expect(xml).not.toContain("never fetched");
  });
});

describe("full-scan hint for a rate-limited run", () => {
  test("says the rest were never fetched, not that earlier results were carried", () => {
    const hint = fullScanHint({
      ...throttled,
      coverage: { auditedPages: 320, knownPages: 1675, carriedFindings: 0 },
    });
    expect(hint).toContain("320 of 1675 known pages were audited this run");
    expect(hint).toContain("never fetched");
    expect(hint).not.toContain("carries earlier results");
  });
});
