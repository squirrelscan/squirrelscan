// Dead-links bulk checker spend accounting: every SUCCESSFUL bulk call must
// report (units, credits) via onSpend; failed calls (server refunds on total
// provider failure) must report nothing.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import { computeCost } from "@squirrelscan/core-contracts";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { AuditReport } from "../../src/types";

import { buildSiteContext } from "../../src/audit/adapter";
import {
  resolveDeadLinksBulkChecker,
  runCloudEditorSummary,
} from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

function pageRecord(html: string): PageRecord {
  return {
    url: "https://example.com/",
    normalizedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "hash",
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  };
}

const HTML = `<html><body>
  <a href="https://external-one.com/a">one</a>
  <a href="https://external-two.com/b">two</a>
  <a href="/internal">internal</a>
</body></html>`;

function deadLinksClient(opts: { fail?: boolean; calls: string[][] }) {
  return {
    deadLinks: async (req: { urls: string[] }) => {
      opts.calls.push(req.urls);
      if (opts.fail) throw new Error("service_unavailable");
      return {
        results: req.urls.map((url) => ({
          url,
          status: 200,
          error: null,
          redirectUrl: null,
          fromCache: false,
        })),
      };
    },
  } as never;
}

async function makeChecker(opts: {
  fail?: boolean;
  calls: string[][];
  onSpend: (units: number, credits: number) => void;
}) {
  const config = getDefaultConfig();
  config.cloud.enabled = true;
  const siteContext = await Effect.runPromise(
    buildSiteContext([pageRecord(HTML)])
  );
  return resolveDeadLinksBulkChecker({
    client: deadLinksClient(opts),
    config,
    auditId: "audit-1",
    siteContext,
    onSpend: opts.onSpend,
  });
}

describe("dead-links bulk checker spend accounting", () => {
  test("successful bulk call reports units + server-debited credits", async () => {
    const calls: string[][] = [];
    const spend: Array<[number, number]> = [];
    const checker = await makeChecker({
      calls,
      onSpend: (units, credits) => spend.push([units, credits]),
    });
    expect(checker).not.toBeNull();

    const urls = ["https://external-one.com/a", "https://external-two.com/b"];
    const results = await checker!(urls);
    expect(results.size).toBe(2);
    // Pricing v10: dead-link checks are folded into the audit base → 0cr,
    // but units still report for coverage accounting.
    expect(spend).toEqual([[2, 0]]);
  });

  test("each successful call is accounted separately (per-call ceil)", async () => {
    const calls: string[][] = [];
    let units = 0;
    let credits = 0;
    const checker = await makeChecker({
      calls,
      onSpend: (u, c) => {
        units += u;
        credits += c;
      },
    });

    await checker!(["https://external-one.com/a"]);
    await checker!(["https://external-two.com/b"]);
    // Two calls of 1 url each: 2 units; folded pricing → 0cr per call.
    expect(units).toBe(2);
    expect(credits).toBe(0);
  });

  test("failed bulk call reports no spend", async () => {
    const calls: string[][] = [];
    let reported = false;
    const checker = await makeChecker({
      fail: true,
      calls,
      onSpend: () => {
        reported = true;
      },
    });

    await expect(checker!(["https://external-one.com/a"])).rejects.toThrow();
    expect(reported).toBe(false);
  });
});

// Editor-summary spend accounting: a server-side digest-cache hit (#1012,
// res.cached === true) is served free — it must not be billed via onSpend nor
// reported in the result's credits, mirroring the domain-stats 30-day cache.

function makeSummaryReport(): AuditReport {
  return {
    baseUrl: "https://example.com",
    totalPages: 3,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    healthScore: {
      overall: 100,
      categories: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 1,
    },
  } as unknown as AuditReport;
}

function editorSummaryClient(opts: { cached?: boolean }) {
  return {
    editorSummary: async () => ({
      prose: "All good.",
      bigTicket: [],
      verdict: "ship it",
      model: "test-model",
      generatedAt: "2026-07-17T00:00:00.000Z",
      ...(opts.cached ? { cached: true } : {}),
    }),
  } as never;
}

describe("editor-summary spend accounting", () => {
  test("fresh result reports the flat estimate as spend", async () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    const spend: number[] = [];
    const result = await runCloudEditorSummary({
      client: editorSummaryClient({}),
      config,
      auditId: "audit-1",
      report: makeSummaryReport(),
      onSpend: (credits) => spend.push(credits),
    });
    const estimate = computeCost("editor_summary", 1);
    expect(result?.credits).toBe(estimate);
    // Folded pricing may make the estimate 0 — onSpend only fires when > 0.
    expect(spend).toEqual(estimate > 0 ? [estimate] : []);
  });

  test("digest-cache hit reports no spend and zero credits", async () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    let reported = false;
    const result = await runCloudEditorSummary({
      client: editorSummaryClient({ cached: true }),
      config,
      auditId: "audit-1",
      report: makeSummaryReport(),
      onSpend: () => {
        reported = true;
      },
    });
    expect(result?.credits).toBe(0);
    expect(result?.editorSummary.prose).toBe("All good.");
    expect(reported).toBe(false);
  });
});
