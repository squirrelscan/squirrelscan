// #1167: publishReport's degrade pass + corrected error copy. When the primary-
// capped body still exceeds the 20MB gate, publish re-slims with the harder
// PUBLISH_DEGRADE_LIMITS and warns via onWarn rather than hard-failing; it only
// errors if STILL over, and the message must derive the real 20MB limit (the old
// hardcoded "(5MB)" strings were stale — the true gate is maxPayloadBytes).
//
// An env API token satisfies resolveCredential (source: "env") without touching
// the network — the size guard returns before any fetch.

import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { byteLength } from "@squirrelscan/utils/bytes";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import {
  slimForPublish,
  publishReport,
} from "../../src/controllers/report/publish";
import { API_TOKEN_ENV_VAR } from "../../src/self/credentials";

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

// A report so large that even the degrade pass (10 items/check) can't fit it under
// 20MB — many rules, each a check whose items carry max-length ids + labels.
function hugeReport(): AuditReport {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `item-${i}-` + "x".repeat(1200),
    label: "y".repeat(1200),
  }));
  const ruleResults: Record<string, unknown> = {};
  for (let r = 0; r < 1500; r++) {
    ruleResults[`rule-${r}`] = {
      meta: {
        id: `rule-${r}`,
        name: `Rule ${r}`,
        description: "",
        category: "seo",
        scope: "site",
        severity: "error",
        weight: 1,
      },
      checks: [{ name: "c", status: "fail", message: "m", items }],
    };
  }
  return {
    baseUrl: "https://example.com",
    status: "completed",
    pages: [],
    siteChecks: [],
    summary: emptySummary,
    ruleResults,
  } as unknown as AuditReport;
}

const original = process.env[API_TOKEN_ENV_VAR];
beforeAll(() => {
  process.env[API_TOKEN_ENV_VAR] = "sq_live_test_token_for_publish_degrade";
});
afterAll(() => {
  if (original === undefined) delete process.env[API_TOKEN_ENV_VAR];
  else process.env[API_TOKEN_ENV_VAR] = original;
});

describe("publishReport degrade pass + error copy (#1167)", () => {
  test("over-limit even after degrade: warns, then errors with the 20MB limit (never 5MB)", async () => {
    const warnings: string[] = [];
    const result = await publishReport(hugeReport(), {
      onWarn: (m) => warnings.push(m),
    });

    // Degrade pass ran and warned.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("clipped");

    // Still over → PAYLOAD_TOO_LARGE with the real 20MB gate in the copy.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(result.error.message).toContain("20MB");
    expect(result.error.message).not.toContain("5MB");
  });

  test("degrade pass shrinks the body below the primary sample", () => {
    const {
      PUBLISH_DEGRADE_LIMITS,
    } = require("@squirrelscan/core-contracts/limits");
    const report = hugeReport();
    const primary = JSON.stringify(slimForPublish(report)).length;
    const degraded = JSON.stringify(
      slimForPublish(report, PUBLISH_DEGRADE_LIMITS)
    ).length;
    expect(degraded).toBeLessThan(primary);
  });
});

// #1275: the CLI gate must key off UTF-8 WIRE bytes, not `.length`. Mirrors the
// worker-agent boundary test so the two publish paths can't drift. A giant
// multi-byte check `value` (which the degrade pass never samples) makes the
// slimmed body UNDER the 20MB budget by `.length` but OVER it in real bytes —
// the old `.length` gate would have shipped a ~21MB body to the API.
function multiByteOverBytesUnderLengthReport(): AuditReport {
  const cjkValue = "中".repeat(7_200_000); // ~7.2M code units, ~21.6MB UTF-8 bytes
  return {
    baseUrl: "https://example.com",
    status: "completed",
    pages: [],
    siteChecks: [],
    summary: emptySummary,
    ruleResults: {
      "rule-0": {
        meta: {
          id: "rule-0",
          name: "Rule 0",
          description: "",
          category: "seo",
          scope: "site",
          severity: "error",
          weight: 1,
        },
        checks: [{ name: "c", status: "fail", message: "m", value: cjkValue }],
      },
    },
  } as unknown as AuditReport;
}

describe("publishReport byte-accurate size gating (#1275)", () => {
  test("body under 20MB by .length but over it in UTF-8 bytes → the byte-accurate gate degrades then errors", async () => {
    const report = multiByteOverBytesUnderLengthReport();
    // The scenario the fix targets, on the same wrapped body publishReport builds
    // (public path): the OLD `.length` gate would NOT fire, the byte gate MUST.
    const body = JSON.stringify({
      report: slimForPublish(report),
      visibility: "public",
    });
    expect(body.length).toBeLessThan(REPORT_LIMITS.maxPayloadBytes); // old gate: no degrade
    expect(byteLength(body)).toBeGreaterThan(REPORT_LIMITS.maxPayloadBytes); // new gate: degrade

    const warnings: string[] = [];
    const result = await publishReport(report, {
      onWarn: (m) => warnings.push(m),
    });
    // The byte gate fired: degrade pass ran + warned. The giant `value` survives
    // degrade (only pages/items are sampled), so it stays over → PAYLOAD_TOO_LARGE
    // before any network call — never sent.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("clipped");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
