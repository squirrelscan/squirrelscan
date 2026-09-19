// Review findings on the omission-marker path. A marker is the ONLY record that
// evidence existed and was dropped; losing it is indistinguishable from a check
// that never produced any, which is the failure this feature exists to avoid.

import { expect, test } from "bun:test";
import type { CheckResult, ComponentOccurrence } from "@squirrelscan/core-contracts";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { foldOverflowChecks } from "@squirrelscan/rules/fold";

import { flattenChecks } from "../src/merge-core";
import { buildStreamFindings } from "../src/stream-findings";

const RULE_ID = "content/stale-copyright";

function occurrence(pageUrl: string): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: "s128:r" },
    family: { key: "s128:f", structuralSignature: "s128:f" },
    variant: { key: "s128:v", structuralSignature: "s128:v", contentHash: "s128:c" },
    element: { locator: "footer:1>footer>p:1", structuralSignature: "s128:e" },
    defect: { kind: "stale-copyright", values: { year: 2019 }, valueHashes: { year: "s128:y" } },
  };
}

test("an EXISTING marker is persisted even when the check has no occurrences left", () => {
  // `unfoldAggregateCheck` produces exactly this shape: evidence for pages
  // outside the bounded sample is replaced by a marker before flatten sees it.
  const check: CheckResult = {
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2019",
    pageUrl: "https://example.test/a",
    componentEvidence: { state: "omitted", reason: "page-sample-limit", occurrenceCount: 9 },
  };
  const [row] = flattenChecks("https://example.test/a", RULE_ID, [check]);
  expect(JSON.parse(row!.payload!).componentEvidence).toEqual({
    state: "omitted",
    reason: "page-sample-limit",
    occurrenceCount: 9,
  });
});

test("an EXISTING marker survives on an item-bearing check too", () => {
  const check: CheckResult = {
    name: "generic-link-text",
    status: "warn",
    message: "2 link(s) with generic text",
    pageUrl: "https://example.test/a",
    items: [{ id: "a" }, { id: "b" }],
    componentEvidence: { state: "omitted", reason: "page-sample-limit", occurrenceCount: 4 },
  };
  const rows = flattenChecks("https://example.test/a", RULE_ID, [check]);
  const markers = rows.map((row) => JSON.parse(row.payload!).componentEvidence).filter(Boolean);
  expect(markers.length).toBeGreaterThan(0);
  expect(markers[0]).toEqual({
    state: "omitted",
    reason: "page-sample-limit",
    occurrenceCount: 4,
  });
});

test("a near-cap payload keeps LEGACY data and drops the marker, not the reverse", () => {
  // Deliberate: `details` feeds scoring (`details.additional` drives the
  // density penalty), the marker does not. When only one fits, the scoring
  // input wins and the note is lost — trading it away would move the health
  // score, which parity forbids. The marker only wins once the legacy payload
  // is over cap on its own and the ingest would drop the row anyway.
  const base = (blob: string, occurrences?: ComponentOccurrence[]): CheckResult => ({
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2019",
    pageUrl: "https://example.test/a",
    details: { blob },
    componentOccurrences: occurrences,
  });
  const probe = flattenChecks("https://example.test/a", RULE_ID, [base("")])[0]!;
  const blob = "x".repeat(REPORT_LIMITS.maxFindingPayload - probe.payload!.length - 8);

  const baseline = flattenChecks("https://example.test/a", RULE_ID, [base(blob)])[0]!;
  const withEvidence = flattenChecks("https://example.test/a", RULE_ID, [
    base(blob, [occurrence("https://example.test/a")]),
  ])[0]!;
  expect(withEvidence.payload).toBe(baseline.payload);
  expect(withEvidence.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);
});

test("an itemless payload that is over cap on its own is still brought under it", () => {
  // Previously this kept the oversized legacy payload and then passed the
  // stream guard unchanged, because the guard only acts on payloads that still
  // contain `componentOccurrences`.
  const check: CheckResult = {
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2019",
    pageUrl: "https://example.test/a",
    details: { blob: "x".repeat(REPORT_LIMITS.maxFindingPayload * 2) },
    componentOccurrences: [occurrence("https://example.test/a")],
  };
  const [line] = buildStreamFindings(
    { [RULE_ID]: { meta: { severity: "warning" }, checks: [check] } },
    1,
  );
  expect(line!.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);
});

test("folding checks that carry markers keeps the record of omission", () => {
  const marked = (pageUrl: string, count: number): CheckResult => ({
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2019",
    pageUrl,
    pages: [pageUrl],
    componentEvidence: { state: "omitted", reason: "page-sample-limit", occurrenceCount: count },
  });
  const folded = foldOverflowChecks(
    [
      marked("https://example.test/a", 3),
      { ...marked("https://example.test/b", 5), componentEvidence: { state: "omitted", reason: "payload-limit", occurrenceCount: 5 } },
      marked("https://example.test/c", 2),
    ],
    { maxChecks: 1, maxItemsPerCheck: 10, maxPagesPerCheck: 10, maxSourcePagesPerItem: 10 },
  )[0]!;

  // Counts sum, and the harder reason wins: `payload-limit` means the evidence
  // could not be stored at all, which outranks a bounded page sample.
  expect(folded.componentEvidence).toEqual({
    state: "omitted",
    reason: "payload-limit",
    occurrenceCount: 10,
  });
});
