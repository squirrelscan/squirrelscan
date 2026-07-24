// ax/archive-indexing — Wayback + Common Crawl presence (cloud, site-scope).
//
// Verifies: graceful skip with no cloud result, skip envelope passthrough,
// warn on Common Crawl absence, warn on Wayback absence, pass when both are
// indexed with fresh captures, and stale-capture warns.

import { describe, expect, test } from "bun:test";

import type { ArchiveIndexingResponse } from "@squirrelscan/core-contracts";

import { archiveIndexingRule } from "../src/ax/archive-indexing";
import { CLOUD_SITE_KEY, type CloudResultEnvelope, type CloudResultStore } from "../src/cloud";
import type { CheckResult, RuleContext } from "../src/types";

const NOW = "2026-07-09T00:00:00.000Z";
const FRESH = "2026-06-01T00:00:00.000Z";
const STALE = "2024-01-01T00:00:00.000Z";

function makeCtx(envelope?: CloudResultEnvelope<ArchiveIndexingResponse>): RuleContext {
  const cloudResults: CloudResultStore | undefined = envelope
    ? new Map([["archive-indexing", new Map([[CLOUD_SITE_KEY, envelope as CloudResultEnvelope]])]])
    : undefined;
  return { cloudResults, options: {} } as RuleContext;
}

function data(over: Partial<ArchiveIndexingResponse>): ArchiveIndexingResponse {
  return {
    domain: "example.com",
    wayback: { indexed: true, latestCapture: FRESH },
    commonCrawl: { indexed: true, latestCapture: FRESH, source: "CC-MAIN-2026-26" },
    capturedAt: NOW,
    cached: false,
    ...over,
  };
}

function run(ctx: RuleContext): CheckResult[] {
  return (archiveIndexingRule.run(ctx) as { checks: CheckResult[] }).checks;
}

function byName(checks: CheckResult[], name: string): CheckResult {
  const c = checks.find((x) => x.name === name);
  expect(c).toBeDefined();
  return c!;
}

describe("ax/archive-indexing", () => {
  test("skips gracefully with no cloud result", () => {
    const checks = run(makeCtx());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("passes a skip envelope through with its reason", () => {
    const checks = run(makeCtx({ status: "skipped", skipReason: "not-authenticated" }));
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toContain("log");
  });

  test("passes when both archives have fresh captures", () => {
    const checks = run(makeCtx({ status: "ok", data: data({}) }));
    expect(byName(checks, "common-crawl-indexed").status).toBe("pass");
    expect(byName(checks, "wayback-archived").status).toBe("pass");
  });

  test("warns when the domain is not in Common Crawl", () => {
    const checks = run(
      makeCtx({ status: "ok", data: data({ commonCrawl: { indexed: false, source: "CC-MAIN-2026-26" } }) }),
    );
    expect(byName(checks, "common-crawl-indexed").status).toBe("warn");
    expect(byName(checks, "wayback-archived").status).toBe("pass");
  });

  test("warns when there is no Wayback snapshot", () => {
    const checks = run(makeCtx({ status: "ok", data: data({ wayback: { indexed: false } }) }));
    expect(byName(checks, "wayback-archived").status).toBe("warn");
  });

  test("warns on a stale (>1y) capture even when indexed", () => {
    const checks = run(
      makeCtx({
        status: "ok",
        data: data({ commonCrawl: { indexed: true, latestCapture: STALE, source: "CC-MAIN-2024-10" } }),
      }),
    );
    expect(byName(checks, "common-crawl-indexed").status).toBe("warn");
  });
});
