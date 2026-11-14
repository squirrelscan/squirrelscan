// #1747: the report says, per rule, whether it ran and what it covered.

import { describe, expect, test } from "bun:test";

import { RULE_TIMED_OUT_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";

import { renderJson } from "../src/output/json";
import { ruleRunOf, ruleRuns } from "../src/rule-runs";
import type { AuditReport, CheckResult, ReportRuleResult } from "../src/types";

const rule = (id: string, scope: "page" | "site", checks: CheckResult[]): ReportRuleResult => ({
  meta: { id, name: id, description: id, category: "core", scope, severity: "warning", weight: 5 },
  checks,
});

const pass = (name: string, pageUrl?: string): CheckResult => ({
  name,
  status: "pass",
  message: "ok",
  ...(pageUrl ? { pageUrl } : {}),
});
const skip = (name: string, skipReason: string, pageUrl?: string): CheckResult => ({
  name,
  status: "skipped",
  message: "skipped",
  skipReason,
  ...(pageUrl ? { pageUrl } : {}),
});

const ruleResults = {
  // Ran and found nothing: a clean pass, not an absence.
  "core/meta-title": rule("core/meta-title", "page", [pass("meta-title")]),
  // A page rule that skipped one of the 10 audited pages (noindex) covers the other 9.
  "core/meta-description": rule("core/meta-description", "page", [
    { name: "meta-description", status: "warn", message: "missing", pageUrl: "https://example.com/a" },
    skip("meta-description", "noindex", "https://example.com/private"),
  ]),
  // A whole-site rule in a targeted run.
  "links/orphan-pages": rule("links/orphan-pages", "site", [skip("orphan-pages", "targeted-run")]),
  // Abandoned for its time budget.
  "perf/cls-hints": rule("perf/cls-hints", "page", [skip("cls-hints", RULE_TIMED_OUT_SKIP_REASON)]),
  // Ran on the site.
  "crawl/robots-txt": rule("crawl/robots-txt", "site", [pass("robots-exists")]),
  // No check at all: nothing says whether it ran.
  "core/charset": rule("core/charset", "page", []),
  // Only a finding carried from an earlier audit: this audit did not run it.
  "core/canonical": rule("core/canonical", "page", [
    { name: "canonical", status: "fail", message: "carried", provenance: "carried" },
  ]),
};

const report = {
  baseUrl: "https://example.com/some/start",
  timestamp: "2026-11-12T00:00:00.000Z",
  totalPages: 10,
  passed: 0,
  warnings: 0,
  failed: 0,
  ruleResults,
} as unknown as AuditReport;

describe("ruleRuns (#1747)", () => {
  const by = Object.fromEntries(ruleRuns(report).map((r) => [r.ruleId, r]));

  test("a rule that ran and found nothing is ran, with the pages it covered", () => {
    expect(by["core/meta-title"]).toEqual({ ruleId: "core/meta-title", status: "ran", scope: { pages: 10 } });
  });

  test("a page rule leaves out the pages it skipped", () => {
    expect(by["core/meta-description"]).toEqual({
      ruleId: "core/meta-description",
      status: "ran",
      scope: { pages: 9 },
    });
  });

  test("a site rule covers the origin", () => {
    expect(by["crawl/robots-txt"]).toEqual({
      ruleId: "crawl/robots-txt",
      status: "ran",
      scope: { origin: "https://example.com" },
    });
  });

  test("a skipped rule says why and is not ran", () => {
    expect(by["links/orphan-pages"]).toEqual({
      ruleId: "links/orphan-pages",
      status: "skipped",
      scope: { origin: "https://example.com" },
      reason: "targeted-run",
    });
  });

  test("a rule abandoned for its time budget is timed_out", () => {
    expect(by["perf/cls-hints"]).toEqual({
      ruleId: "perf/cls-hints",
      status: "timed_out",
      scope: { pages: 0 },
      reason: RULE_TIMED_OUT_SKIP_REASON,
    });
  });

  test("a rule with no check is not listed, and a carried finding is not a run", () => {
    expect(by["core/charset"]).toBeUndefined();
    expect(by["core/canonical"]).toMatchObject({ status: "skipped", scope: { pages: 0 } });
  });

  test("is sorted by rule id and reads a Map of rule results", () => {
    const ids = ruleRuns(report).map((r) => r.ruleId);
    expect(ids).toEqual([...ids].sort());
    const asMap = { ...report, ruleResults: new Map(Object.entries(ruleResults)) } as unknown as AuditReport;
    expect(ruleRuns(asMap)).toEqual(ruleRuns(report));
    expect(ruleRunOf(report, "core/meta-title")?.status).toBe("ran");
  });
});

describe("JSON report `rules`", () => {
  test("carries one row per rule with a check; existing fields are unchanged", () => {
    const json = JSON.parse(renderJson(report)) as { rules?: Array<{ ruleId: string }>; executedRules?: string[] };
    expect(json.rules?.map((r) => r.ruleId)).toContain("core/meta-title");
    expect(json.rules?.map((r) => r.ruleId)).not.toContain("core/charset");
    // executedRules is the older, coarser view and stays as it was.
    expect(json.executedRules).toEqual(["core/meta-description", "core/meta-title", "crawl/robots-txt"]);
  });

  test("is absent when the report has no rule results", () => {
    const empty = { ...report, ruleResults: {} } as unknown as AuditReport;
    expect(JSON.parse(renderJson(empty))).not.toHaveProperty("rules");
  });
});
