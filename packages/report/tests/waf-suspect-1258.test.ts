// #1258: pages that look like a provider's refusal but carry no block marker are
// warned about in the text and Markdown reports and listed in JSON; hostile fields
// are made safe to print.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderJson } from "../src/output/json";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { safeWafSuspect, wafSuspectLines } from "../src/waf-blocked";

function report(extra: Record<string, unknown>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T00:00:00.000Z",
    totalPages: 3,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    healthScore: { overall: 90, categories: [], groups: [], errorCount: 0, warningCount: 0, passedCount: 1 },
    ...extra,
  } as unknown as AuditReport;
}

const SUSPECT = {
  total: 2,
  providers: ["Cloudflare"],
  pages: [
    {
      url: "https://example.com/denied",
      status: 406,
      provider: "Cloudflare",
      providerId: "cloudflare",
      signal: "refusal page from Cloudflare with no provider block marker",
    },
  ],
};

describe("wafSuspectLines", () => {
  test("says the pages were audited and may describe the provider's page", () => {
    const [summary, ...listed] = wafSuspectLines(report({ wafSuspect: SUSPECT }));
    expect(summary).toContain("2 pages look like a refusal from Cloudflare but carry no block marker");
    expect(summary).toContain("They were audited");
    expect(listed[0]).toBe(
      "https://example.com/denied: Cloudflare, HTTP 406 (refusal page from Cloudflare with no provider block marker)",
    );
    expect(listed[1]).toBe("and 1 more");
  });

  test("none, a failed run and a blocked run print nothing", () => {
    expect(wafSuspectLines(report({}))).toEqual([]);
    expect(wafSuspectLines(report({ wafSuspect: { total: 0, providers: [], pages: [] } }))).toEqual([]);
    expect(wafSuspectLines(report({ wafSuspect: SUSPECT, status: "failed" }))).toEqual([]);
    expect(wafSuspectLines(report({ wafSuspect: SUSPECT, status: "blocked" }))).toEqual([]);
  });

  test("hostile fields are made printable", () => {
    const safe = safeWafSuspect(
      report({
        wafSuspect: {
          total: 1,
          providers: ["Cloud\u0007flare"],
          pages: [{ url: "javascript:alert(1)", status: 406, provider: "x\u0000y", providerId: null, signal: "a\nb" }],
        },
      }),
    );
    expect(safe?.pages[0]?.url).toBe("(unprintable URL)");
    expect(safe?.pages[0]?.signal).toBe("a b");
    expect(safe?.providers).toEqual(["Cloudflare"]);
  });
});

describe("renderers", () => {
  test("text and markdown carry the warning", () => {
    const r = report({ wafSuspect: SUSPECT });
    expect(renderText(r)).toContain("SUSPECT PAGES");
    expect(renderMarkdown(r)).toContain("Suspect pages:");
  });

  test("JSON lists wafSuspect only when there is one", () => {
    const json = JSON.parse(renderJson(report({ wafSuspect: SUSPECT }))) as { wafSuspect?: { total: number } };
    expect(json.wafSuspect?.total).toBe(2);
    expect(JSON.parse(renderJson(report({}))) as object).not.toHaveProperty("wafSuspect");
  });
});
