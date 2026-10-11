// #1185: the resolution signal on the REAL evidence shape, a 505-page site
// (NPJQ4JY0) with heavy failing rules. #2658: it ships compact, inside its fixed
// byte share, carrying the same evidence. The whole published body is bounded by
// the capper (repo#2667, publish-capped-body.test.ts).

import {
  PUBLISHED_REPORT_MAX_BYTES,
  REPORT_CAPS,
} from "@squirrelscan/core-contracts/limits";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import { byteLength } from "@squirrelscan/utils/bytes";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { slimForPublish } from "../../src/controllers/report/publish";

const emptySummary = {
  missingTitles: [],
  missingDescriptions: [],
  missingOgTags: [],
  missingTwitterCards: [],
  missingSchemas: [],
  missingAltText: [],
  multipleH1s: [],
  thinContentPages: [],
  urlIssues: [],
  redirectChains: [],
  securityIssues: [],
};

const url = (i: number) =>
  `https://perspectivesintopractice.com/section-${i % 40}/page-${i}-with-a-longish-slug`;

describe("resolution signal payload size (#1185, 505-page shape)", () => {
  test("measured signal bytes are bounded and small against the published report budget", async () => {
    const PAGES = 505;
    const pageUrls = Array.from({ length: PAGES }, (_, i) => url(i));
    // Live-evidence shape: ~60 failing rule-check classes averaging ~300
    // affected pages (token-weight 502, sri ~505, critical-request-chains 553
    // occurrences, …) — deliberately pessimistic.
    const ruleResults: Record<string, unknown> = {};
    for (let r = 0; r < 60; r++) {
      const affected = pageUrls.slice(0, 200 + ((r * 61) % 305));
      ruleResults[`rule-${r}`] = {
        meta: {
          id: `rule-${r}`,
          scope: "page",
          severity: "warning",
          weight: 1,
        },
        checks: [
          {
            name: "check",
            status: r % 3 === 0 ? "fail" : "warn",
            message: "issue",
            pages: affected,
            details: { aggregated: true, occurrences: affected.length },
          },
        ],
      };
    }
    const report = {
      baseUrl: "https://perspectivesintopractice.com",
      status: "completed",
      pages: pageUrls.map((u) => ({ url: u, statusCode: 200 })),
      siteChecks: [],
      summary: emptySummary,
      ruleResults,
    } as unknown as AuditReport;

    const slim = slimForPublish(report);
    expect(slim.resolutionSignalCompact).toBeDefined();
    const signalBytes = JSON.stringify(slim.resolutionSignalCompact).length;
    const bodyTotal = byteLength(
      JSON.stringify({ report: slim, visibility: "public" })
    );

    // The original shape measured 366KB here (505 URLs + ~18k failing and
    // ~11k not-evaluated hashes). Compact, the same evidence is a few KB.
    expect(signalBytes).toBeLessThanOrEqual(REPORT_CAPS.signalMaxBytes);
    expect(signalBytes).toBeLessThan(20 * 1024);
    expect(bodyTotal).toBeLessThanOrEqual(PUBLISHED_REPORT_MAX_BYTES);

    // This shape has no pass records, so every clean page is unevaluated as far
    // as the builder can prove — the worst case for `notEvaluated` — and none of
    // it was dropped to fit.
    const signal = await decodeResolutionSignal(slim.resolutionSignalCompact!);
    expect(signal.crawledUrls).toHaveLength(PAGES);
    expect(signal.notEvaluated).toBeDefined();
    expect(signal.truncated).toBeUndefined();
  });

  test("a run with pass records emits NO notEvaluated — the realistic case is free", async () => {
    // A real report keeps the passing pages too (per-page pass checks, or a
    // folded pass aggregate listing them), so every crawled page is proven
    // evaluated and the complement is empty. Measured: 247KB, identical to the
    // signal before notEvaluated existed.
    const PAGES = 505;
    const pageUrls = Array.from({ length: PAGES }, (_, i) => url(i));
    const ruleResults: Record<string, unknown> = {};
    for (let r = 0; r < 60; r++) {
      const affected = pageUrls.slice(0, 200 + ((r * 61) % 305));
      const affectedSet = new Set(affected);
      const clean = pageUrls.filter((u) => !affectedSet.has(u));
      ruleResults[`rule-${r}`] = {
        meta: {
          id: `rule-${r}`,
          scope: "page",
          severity: "warning",
          weight: 1,
        },
        checks: [
          {
            name: "check",
            status: "warn",
            message: "issue",
            pages: affected,
            details: { aggregated: true, occurrences: affected.length },
          },
          {
            name: "check",
            status: "pass",
            message: "ok",
            pages: clean,
            details: { aggregated: true, occurrences: clean.length },
          },
        ],
      };
    }
    const report = {
      baseUrl: "https://perspectivesintopractice.com",
      status: "completed",
      pages: pageUrls.map((u) => ({ url: u, statusCode: 200 })),
      siteChecks: [],
      summary: emptySummary,
      ruleResults,
    } as unknown as AuditReport;

    const compact = slimForPublish(report).resolutionSignalCompact!;
    const signal = await decodeResolutionSignal(compact);
    expect(signal.notEvaluated).toBeUndefined();
    expect(JSON.stringify(compact).length).toBeLessThan(20 * 1024);
  });
});
