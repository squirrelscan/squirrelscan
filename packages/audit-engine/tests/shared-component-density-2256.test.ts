// pub#2256: one shared chrome element (a header logo link) repeated on every page is one repair,
// so it must not sink the overall through the issue-density penalty by page count.

import type {
  CheckResult,
  ComponentOccurrence,
} from "@squirrelscan/core-contracts";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";

import {
  addChecksToTally,
  calculateHealthScore,
  emptyTally,
} from "../src/scoring";

function meta(id: string, over: Partial<RuleMeta> = {}): RuleMeta {
  return {
    id,
    name: id,
    description: id,
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 1,
    ...over,
  };
}

function occurrence(pageUrl: string, groupable: boolean): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable,
    confidence: groupable ? "observed" : "uncertain",
    ...(groupable ? {} : { uncertainReason: "region-main" as const }),
    region: { role: "header", nestedIn: "none", structuralSignature: "s:r" },
    family: { key: "s:f", structuralSignature: "s:f" },
    variant: { key: "s:v", structuralSignature: "s:v", contentHash: "s:c" },
    element: { locator: "header>a:1", structuralSignature: "s:e" },
    defect: { kind: "link-text-empty", values: {}, valueHashes: {} },
  };
}

function pages(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://example.test/p${i}`);
}

// A fixed 12-unit per-page backdrop so the density threshold (10) is crossed in every case.
const backdrop: RuleRunResult = {
  meta: meta("a11y/backdrop"),
  checks: pages(12).map((pageUrl) => ({
    name: "backdrop",
    status: "fail",
    message: "per-page defect",
    pageUrl,
  })),
};

// Enough passes that the 45% ceiling is not what holds the penalty down.
const clean: RuleRunResult = {
  meta: meta("a11y/clean"),
  checks: Array.from({ length: 300 }, (_, i) => ({
    name: "clean",
    status: "pass" as const,
    message: "ok",
    pageUrl: `https://example.test/c${i}`,
  })),
};

function sharedChecks(n: number, groupable: boolean): CheckResult[] {
  return pages(n).map((pageUrl) => ({
    name: "logo-link",
    status: "fail",
    message: "logo link has no name",
    pageUrl,
    componentOccurrences: [occurrence(pageUrl, groupable)],
  }));
}

function perPageChecks(n: number): CheckResult[] {
  return pages(n).map((pageUrl) => ({
    name: "logo-link",
    status: "fail",
    message: "per page",
    pageUrl,
  }));
}

function scoreWith(checks: CheckResult[]) {
  const results = new Map<string, RuleRunResult>([
    ["a11y/backdrop", backdrop],
    ["a11y/clean", clean],
    ["a11y/logo-link", { meta: meta("a11y/logo-link"), checks }],
  ]);
  return calculateHealthScore({ results });
}

describe("shared-component density cap (#2256)", () => {
  test("a shared finding moves the density penalty the same on 2 pages as on 25", () => {
    const two = scoreWith(sharedChecks(2, true));
    const many = scoreWith(sharedChecks(25, true));
    expect(many.debug?.issueDensity).toBe(two.debug?.issueDensity);
    expect(many.overall).toBe(two.overall);
    expect(many.debug?.sharedComponentUnits).toBe(25);
    expect(two.debug?.sharedComponentUnits).toBe(2);
  });

  test("the same finding without shared evidence still scales with page count", () => {
    const two = scoreWith(perPageChecks(2));
    const many = scoreWith(perPageChecks(25));
    expect(many.debug!.issueDensity!).toBeGreaterThan(two.debug!.issueDensity!);
    expect(many.debug?.issueDensityShared).toBeUndefined();
  });

  test("uncertain (page-scoped) evidence is not treated as shared", () => {
    const two = scoreWith(sharedChecks(2, false));
    const many = scoreWith(sharedChecks(25, false));
    expect(many.debug!.issueDensity!).toBeGreaterThan(two.debug!.issueDensity!);
    expect(many.debug?.sharedComponentUnits).toBeUndefined();
  });

  test("the breakdown reports the shared part of the density penalty", () => {
    const many = scoreWith(sharedChecks(25, true));
    const shared = many.debug!.issueDensityShared!;
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThanOrEqual(many.debug!.issueDensity!);
  });

  test("a shared fail key records its units as a subset of the totals", () => {
    const tally = emptyTally();
    addChecksToTally(tally, sharedChecks(1, true));
    expect(tally.failUnits).toBe(1);
    expect(tally.sharedFailUnits).toBe(1);
    expect(tally.sharedFailUnits).toBeLessThanOrEqual(tally.failUnits);
  });
});
