import { expect, test } from "bun:test";
import type { CheckResult, ComponentOccurrence, PageFindingRecord } from "@squirrelscan/core-contracts";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { unpackComponentOccurrences } from "@squirrelscan/core-contracts/component-evidence";
import { findingFingerprint } from "../src/fingerprint";
import { flattenChecks } from "../src/merge-core";
import { reconstructPageRuleChecks } from "../src/reconstruct";
import { buildStreamFindings } from "../src/stream-findings";

const occurrences: ComponentOccurrence[] = [
  {
    version: 1, pageUrl: "https://example.test/about", siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable: true, confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: "r" },
    family: { key: "f", structuralSignature: "f" },
    variant: { key: "v", structuralSignature: "v", contentHash: "c" },
    element: { locator: "footer>a:1", structuralSignature: "e" },
    defect: { kind: "link-text-generic", values: { text: "Read more" }, valueHashes: { text: "h" } },
  },
];

test("component occurrence evidence round-trips through item finding storage", () => {
  const check: CheckResult = {
    name: "generic-link-text", status: "warn", message: "Generic link text found",
    pageUrl: "https://example.test/about", items: [{ id: "footer>a:1", label: "Read more" }],
    componentOccurrences: occurrences,
  };
  const rows: PageFindingRecord[] = flattenChecks(check.pageUrl!, "a11y/link-text", [check]).map((finding) => ({
    siteKey: "site", normalizedUrl: finding.normalizedUrl, ruleId: finding.ruleId,
    checkName: finding.checkName, locator: finding.locator, status: finding.status,
    severity: "warning", message: finding.message, value: finding.value, expected: finding.expected,
    payload: finding.payload,
    fingerprint: findingFingerprint(finding.status, finding.message, finding.value, finding.expected),
    firstSeenAt: 1, lastSeenCrawlId: "crawl", lastSeenAt: 1, provenance: "fresh", state: "open",
  }));

  const rebuilt = reconstructPageRuleChecks(rows).get("a11y/link-text")![0]!;
  expect(rebuilt.componentOccurrences).toEqual(occurrences);
  expect(rebuilt.items).toEqual(check.items);
});

test("only the last duplicate locator owns evidence and it survives latest-wins streaming", () => {
  const check: CheckResult = {
    name: "generic-link-text", status: "warn", message: "Generic link text found",
    pageUrl: "https://example.test/about", items: [{ id: "same" }, { id: "same" }],
    componentOccurrences: occurrences,
  };
  const rows = flattenChecks(check.pageUrl!, "a11y/link-text", [check]);
  expect(JSON.parse(rows[0]!.payload!).componentOccurrences).toBeUndefined();
  // Stored in the hoisted wire form; the codec is what makes it whole again.
  expect(
    unpackComponentOccurrences(JSON.parse(rows[1]!.payload!).componentOccurrences),
  ).toEqual(occurrences);
});

function stored(lines: ReturnType<typeof buildStreamFindings>): PageFindingRecord[] {
  return lines.map((line) => ({
    ...line,
    siteKey: "site",
    lastSeenCrawlId: "crawl",
  }));
}

test("oversized item evidence becomes an explicit omission on every storage path", () => {
  const complete = Array.from({ length: 100 }, (_, i) => ({
    ...occurrences[0]!,
    pageUrl: `https://example.test/page-${i}`,
    element: { locator: `footer>a:${i}`, structuralSignature: `element-${i}` },
  }));
  const check: CheckResult = {
    name: "generic-link-text", status: "warn", message: "Generic link text found",
    pageUrl: "https://example.test/about", items: [{ id: "same" }, { id: "same" }],
    componentOccurrences: complete,
  };

  const local = reconstructPageRuleChecks(stored(flattenChecks(check.pageUrl!, "a11y/link-text", [check]).map((finding) => ({
    ...finding,
    severity: "warning",
    fingerprint: findingFingerprint(finding.status, finding.message, finding.value, finding.expected),
    firstSeenAt: 1,
    lastSeenAt: 1,
    provenance: "fresh" as const,
    state: "open" as const,
  }))));
  // The local store obeys the same cap: a row this large is exactly what the
  // chunk ingest drops whole, so the additive evidence yields and says so.
  const localCheck = local.get("a11y/link-text")![0]!;
  expect(localCheck.componentOccurrences).toBeUndefined();
  expect(localCheck.componentEvidence).toEqual({
    state: "omitted",
    reason: "payload-limit",
    occurrenceCount: 100,
  });

  const lines = buildStreamFindings({ "a11y/link-text": { meta: { severity: "warning" }, checks: [check] } }, 1);
  // Latest-wins leaves one row for the duplicate locator, and that row owns the
  // complete check evidence before the transport cap turns it into a marker.
  expect(lines).toHaveLength(1);
  const payload = JSON.parse(lines[0]!.payload!);
  expect(lines[0]!.message).toContain("same");
  expect(payload.componentOccurrences).toBeUndefined();
  expect(payload.componentEvidence).toEqual({ state: "omitted", reason: "payload-limit", occurrenceCount: 100 });
  expect(lines[0]!.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);

  const rebuilt = reconstructPageRuleChecks(stored(lines)).get("a11y/link-text")![0]!;
  expect(rebuilt.componentOccurrences).toBeUndefined();
  expect(rebuilt.componentEvidence).toEqual(payload.componentEvidence);
  expect(rebuilt.items).toEqual([{ id: "same" }]);
});

test("streaming marks oversized whole-check evidence and leaves intrinsically oversized legacy payloads alone", () => {
  const complete = Array.from({ length: 100 }, (_, i) => ({ ...occurrences[0]!, pageUrl: `https://example.test/page-${i}` }));
  const check: CheckResult = {
    name: "stale-copyright", status: "warn", message: "Copyright year is stale",
    pageUrl: "https://example.test/about", componentOccurrences: complete,
  };
  const [line] = buildStreamFindings({ copyright: { meta: { severity: "warning" }, checks: [check] } }, 1);
  expect(JSON.parse(line!.payload!).componentEvidence).toEqual({ state: "omitted", reason: "payload-limit", occurrenceCount: 100 });
  expect(reconstructPageRuleChecks(stored([line!])).get("copyright")![0]!.componentEvidence).toEqual({ state: "omitted", reason: "payload-limit", occurrenceCount: 100 });

  const legacyTooLarge: CheckResult = {
    ...check,
    details: { blob: "x".repeat(REPORT_LIMITS.maxFindingPayload * 2) },
  };
  const [legacyLine] = buildStreamFindings({ copyright: { meta: { severity: "warning" }, checks: [legacyTooLarge] } }, 1);
  const legacyPayload = JSON.parse(legacyLine!.payload!);
  // The cap now HOLDS here. Previously this row stayed oversized and the chunk
  // ingest dropped it whole, losing the legacy fields anyway; once the legacy
  // payload cannot fit on its own, keeping the marker is strictly better than
  // emitting a payload that will be discarded.
  expect(legacyLine!.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);
  expect(legacyPayload.componentOccurrences).toBeUndefined();
  expect(legacyPayload.componentEvidence).toEqual({
    state: "omitted",
    reason: "payload-limit",
    occurrenceCount: 100,
  });
});

test("a near-cap legacy payload stays byte-identical when an omission marker cannot fit", () => {
  const base = (blob: string, componentOccurrences?: ComponentOccurrence[]): CheckResult => ({
    name: "stale-copyright", status: "warn", message: "Copyright year is stale",
    pageUrl: "https://example.test/about", details: { blob }, componentOccurrences,
  });
  const initial = buildStreamFindings({ copyright: { meta: { severity: "warning" }, checks: [base("")] } }, 1)[0]!;
  const blob = "x".repeat(REPORT_LIMITS.maxFindingPayload - initial.payload!.length - 8);
  const baseline = buildStreamFindings({ copyright: { meta: { severity: "warning" }, checks: [base(blob)] } }, 1)[0]!;
  expect(baseline.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);

  const withEvidence = buildStreamFindings({ copyright: { meta: { severity: "warning" }, checks: [base(blob, [occurrences[0]!])] } }, 1)[0]!;
  expect(withEvidence.payload).toBe(baseline.payload);
  expect(JSON.parse(withEvidence.payload!).componentEvidence).toBeUndefined();
  expect(withEvidence.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);
});
